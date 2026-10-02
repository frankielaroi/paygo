import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Observable, Subject } from 'rxjs';
import type { Env } from '../config/env.validation';
import { BIKE_WENT_OFFLINE, type BikeWentOfflineEvent } from '../common/events';
import { GeofencesService } from '../geofences/geofences.service';
import { PrismaService } from '../prisma/prisma.service';
import type { DevicePosition } from '../tcp/codec8-parser';
import { DEVICE_POSITIONS, type DevicePositionsEvent } from '../tcp/tcp.events';
import { BikePositionDto } from './dto/bike-position.dto';
import { BikeStatusDto } from './dto/bike-status.dto';
import { batteryPercentOf, powerAndOdometerOf } from './telemetry';

/**
 * How far ahead of the server clock a device timestamp may be and still become the current
 * position. The current row only ever moves forward in time, so a single record from a
 * glitched future clock would otherwise pin it: every genuine record after it looks older and
 * is discarded, while lastReportedAt stays fresh and the bike reads as online and stationary.
 */
const MAX_DEVICE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** How recently a bike must have crossed the offline threshold to count as having just gone. */
const JUST_WENT_OFFLINE_MS = 2 * 60 * 1000;

/**
 * The facts Enforcement reads before deciding anything. Two clocks are deliberately separate:
 *
 * - `recordedAt` is the device timestamp of the telemetry below. A device replaying a stored
 *   backlog after reconnecting can be online while this is hours old.
 * - `lastReportedAt` / `online` say when the server last heard from the device at all.
 *
 * A stationary reading is only as good as `recordedAt` is recent. `ignition` and `movement`
 * are null when the device did not report them, which means unknown, not off.
 */
/** One historical reading, reduced to what a stationary check needs. */
export interface SafetyReading {
  recordedAt: Date;
  speed: number;
  ignition: boolean | null;
  movement: boolean | null;
  hasFix: boolean;
}

export interface TrackingSafetySnapshot {
  bikeId: string;
  speed: number;
  ignition: boolean | null;
  movement: boolean | null;
  hasFix: boolean;
  recordedAt: Date;
  /** Server time at which the reading above arrived. */
  receivedAt: Date;
  lastReportedAt: Date;
  online: boolean;
}

@Injectable()
export class TrackingService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TrackingService.name);
  private readonly positionUpdates = new Subject<BikeStatusDto>();
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly geofences: GeofencesService,
    private readonly events: EventEmitter2,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const bikes = await this.prisma.bike.findMany({
        where: { lastReportedAt: { not: null } },
        select: { id: true, lastReportedAt: true },
      });

      for (const bike of bikes) {
        if (bike.lastReportedAt) {
          this.scheduleOfflineNotification(bike.id, bike.lastReportedAt);
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not restore bike offline timers: ${detail}`);
    }
  }

  @OnEvent(DEVICE_POSITIONS)
  async handleDevicePositions(event: DevicePositionsEvent): Promise<void> {
    try {
      const bike = await this.prisma.bike.findUnique({
        where: { imei: event.imei },
        select: { id: true },
      });

      if (!bike) {
        this.logger.warn(`Position event from unregistered IMEI ${event.imei}`);
        return;
      }

      // The record that became the bike's current position, or null when none did.
      const newCurrent = await this.prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`
          UPDATE "bikes"
          SET "lastReportedAt" = GREATEST(
            COALESCE("lastReportedAt", ${event.receivedAt}),
            ${event.receivedAt}
          )
          WHERE "id" = ${bike.id}::uuid
        `;

        await transaction.bikePosition.createMany({
          data: event.records.map((record) =>
            this.historyData(bike.id, event.receivedAt, record),
          ),
          skipDuplicates: true,
        });

        const latestAcceptable =
          event.receivedAt.getTime() + MAX_DEVICE_CLOCK_SKEW_MS;
        const latestRecord = event.records.reduce<DevicePosition | null>(
          (latest, record) => {
            if (record.timestamp.getTime() > latestAcceptable) {
              this.logger.warn(
                `IMEI ${event.imei} sent a record dated ${record.timestamp.toISOString()}, ` +
                  'ahead of the server clock; kept in history, not used as current',
              );
              return latest;
            }
            return !latest || record.timestamp > latest.timestamp
              ? record
              : latest;
          },
          null,
        );

        if (!latestRecord) {
          return null;
        }

        const latestPower = powerAndOdometerOf(latestRecord.io);
        const affected = await transaction.$executeRaw`
            INSERT INTO "bike_current_positions" (
              "bikeId", "recordedAt", "receivedAt", "latitude", "longitude",
              "altitude", "angle", "satellites", "speed", "ignition", "movement", "hasFix",
              "externalVoltageMv", "odometerMeters"
            ) VALUES (
              ${bike.id}::uuid, ${latestRecord.timestamp}, ${event.receivedAt},
              ${latestRecord.latitude}, ${latestRecord.longitude}, ${latestRecord.altitude},
              ${latestRecord.angle}, ${latestRecord.satellites}, ${latestRecord.speed},
              ${latestRecord.ignition}, ${latestRecord.movement}, ${latestRecord.hasFix},
              ${latestPower.externalVoltageMv}, ${latestPower.odometerMeters}
            )
            ON CONFLICT ("bikeId") DO UPDATE SET
              "recordedAt" = EXCLUDED."recordedAt",
              "receivedAt" = EXCLUDED."receivedAt",
              "latitude" = EXCLUDED."latitude",
              "longitude" = EXCLUDED."longitude",
              "altitude" = EXCLUDED."altitude",
              "angle" = EXCLUDED."angle",
              "satellites" = EXCLUDED."satellites",
              "speed" = EXCLUDED."speed",
              "ignition" = EXCLUDED."ignition",
              "movement" = EXCLUDED."movement",
              "hasFix" = EXCLUDED."hasFix",
              "externalVoltageMv" = EXCLUDED."externalVoltageMv",
              "odometerMeters" = EXCLUDED."odometerMeters"
            WHERE "bike_current_positions"."recordedAt" < EXCLUDED."recordedAt"
          `;

        return affected > 0 ? latestRecord : null;
      });

      this.scheduleOfflineNotification(bike.id, event.receivedAt);

      if (newCurrent) {
        // Without a fix the coordinates are meaningless (0/0), not a place outside a zone.
        if (newCurrent.hasFix) {
          await this.geofences.observe(
            bike.id,
            newCurrent.latitude,
            newCurrent.longitude,
            newCurrent.timestamp,
          );
        }
        this.positionUpdates.next(await this.getBikeStatus(bike.id));
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Could not process positions from IMEI ${event.imei}: ${detail}`,
      );
    }
  }

  async listBikeStatuses(): Promise<BikeStatusDto[]> {
    const bikes = await this.prisma.bike.findMany({
      select: {
        id: true,
        imei: true,
        label: true,
        registrationNumber: true,
        lastReportedAt: true,
        currentPosition: true,
      },
      orderBy: { label: 'asc' },
    });

    return bikes.map((bike) => this.toBikeStatus(bike));
  }

  async getBikeStatus(bikeId: string): Promise<BikeStatusDto> {
    const bike = await this.prisma.bike.findUnique({
      where: { id: bikeId },
      select: {
        id: true,
        imei: true,
        label: true,
        registrationNumber: true,
        lastReportedAt: true,
        currentPosition: true,
      },
    });

    if (!bike) {
      throw new NotFoundException('Bike not found');
    }

    return this.toBikeStatus(bike);
  }

  async getPositionHistory(
    bikeId: string,
    from: Date,
    to: Date,
    limit: number,
    keep: 'oldest' | 'newest' = 'oldest',
  ): Promise<BikePositionDto[]> {
    if (from > to) {
      throw new BadRequestException('from must be earlier than or equal to to');
    }

    const bike = await this.prisma.bike.findUnique({
      where: { id: bikeId },
      select: { id: true },
    });

    if (!bike) {
      throw new NotFoundException('Bike not found');
    }

    // Always returned oldest first. When the window holds more than `limit`, `keep` decides
    // which end survives: a route up to now wants the newest.
    const rows = await this.prisma.bikePosition.findMany({
      where: { bikeId, recordedAt: { gte: from, lte: to } },
      orderBy: { recordedAt: keep === 'newest' ? 'desc' : 'asc' },
      take: limit,
      select: {
        id: true,
        recordedAt: true,
        receivedAt: true,
        latitude: true,
        longitude: true,
        altitude: true,
        angle: true,
        satellites: true,
        speed: true,
        ignition: true,
        movement: true,
        hasFix: true,
        externalVoltageMv: true,
        odometerMeters: true,
      },
    });
    return keep === 'newest' ? rows.reverse() : rows;
  }

  async getSafetySnapshot(
    bikeId: string,
  ): Promise<TrackingSafetySnapshot | null> {
    const bike = await this.prisma.bike.findUnique({
      where: { id: bikeId },
      select: {
        lastReportedAt: true,
        currentPosition: {
          select: {
            recordedAt: true,
            receivedAt: true,
            speed: true,
            ignition: true,
            movement: true,
            hasFix: true,
          },
        },
      },
    });

    if (!bike?.currentPosition || !bike.lastReportedAt) {
      return null;
    }

    return {
      bikeId,
      ...bike.currentPosition,
      lastReportedAt: bike.lastReportedAt,
      online: this.isOnline(bike.lastReportedAt),
    };
  }

  /**
   * The readings Enforcement needs to judge whether a bike has been stopped since `from`: the
   * last reading at or before `from` (the anchor, proving the state at the start of the window)
   * and every reading after it up to `to`, oldest first. Judging them is Enforcement's job.
   */
  async getSafetyWindow(
    bikeId: string,
    from: Date,
    to: Date,
  ): Promise<{ anchor: SafetyReading | null; readings: SafetyReading[] }> {
    const select = {
      recordedAt: true,
      speed: true,
      ignition: true,
      movement: true,
      hasFix: true,
    } as const;

    const [anchor, readings] = await Promise.all([
      this.prisma.bikePosition.findFirst({
        where: { bikeId, recordedAt: { lte: from } },
        orderBy: { recordedAt: 'desc' },
        select,
      }),
      this.prisma.bikePosition.findMany({
        where: { bikeId, recordedAt: { gt: from, lte: to } },
        orderBy: { recordedAt: 'asc' },
        select,
      }),
    ]);

    return { anchor, readings };
  }

  watchPositionUpdates(): Observable<BikeStatusDto> {
    return this.positionUpdates.asObservable();
  }

  onModuleDestroy(): void {
    for (const timer of this.offlineTimers.values()) {
      clearTimeout(timer);
    }
    this.offlineTimers.clear();
    this.positionUpdates.complete();
  }

  private scheduleOfflineNotification(
    bikeId: string,
    lastReportedAt: Date,
  ): void {
    const existing = this.offlineTimers.get(bikeId);

    if (existing) {
      clearTimeout(existing);
    }

    const timeoutMs =
      this.config.get('TRACKING_OFFLINE_AFTER_SECONDS', { infer: true }) * 1000;
    const delay = Math.max(
      0,
      lastReportedAt.getTime() + timeoutMs - Date.now() + 1,
    );
    const timer = setTimeout(() => {
      this.offlineTimers.delete(bikeId);
      void this.publishOfflineStatus(bikeId);
    }, delay);

    timer.unref();
    this.offlineTimers.set(bikeId, timer);
  }

  private async publishOfflineStatus(bikeId: string): Promise<void> {
    try {
      const status = await this.getBikeStatus(bikeId);

      if (status.online && status.lastReportedAt) {
        this.scheduleOfflineNotification(bikeId, status.lastReportedAt);
        return;
      }

      this.positionUpdates.next(status);
      this.announceIfJustWentOffline(bikeId, status.lastReportedAt);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not publish offline status for bike ${bikeId}: ${detail}`,
      );
    }
  }

  /**
   * Tells the rest of the system a bike has gone quiet, but only at the moment it happens. At
   * startup this runs for every bike that has been silent for days; those are not news.
   */
  private announceIfJustWentOffline(
    bikeId: string,
    lastReportedAt: Date | null,
  ): void {
    if (!lastReportedAt) {
      return;
    }
    const timeoutMs =
      this.config.get('TRACKING_OFFLINE_AFTER_SECONDS', { infer: true }) * 1000;
    const offlineFor = Date.now() - lastReportedAt.getTime() - timeoutMs;
    if (offlineFor >= 0 && offlineFor < JUST_WENT_OFFLINE_MS) {
      const event: BikeWentOfflineEvent = { bikeId, lastReportedAt };
      this.events.emit(BIKE_WENT_OFFLINE, event);
    }
  }

  private isOnline(lastReportedAt: Date | null): boolean {
    if (!lastReportedAt) {
      return false;
    }

    const timeoutMs =
      this.config.get('TRACKING_OFFLINE_AFTER_SECONDS', { infer: true }) * 1000;

    return Date.now() - lastReportedAt.getTime() <= timeoutMs;
  }

  private toBikeStatus(bike: {
    id: string;
    imei: string | null;
    label: string;
    registrationNumber: string | null;
    lastReportedAt: Date | null;
    currentPosition: {
      recordedAt: Date;
      receivedAt: Date;
      latitude: number;
      longitude: number;
      altitude: number;
      angle: number;
      satellites: number;
      speed: number;
      ignition: boolean | null;
      movement: boolean | null;
      hasFix: boolean;
      externalVoltageMv: number | null;
      odometerMeters: number | null;
    } | null;
  }): BikeStatusDto {
    return {
      bikeId: bike.id,
      label: bike.label,
      imei: bike.imei,
      registrationNumber: bike.registrationNumber,
      lastReportedAt: bike.lastReportedAt,
      online: this.isOnline(bike.lastReportedAt),
      batteryPercent: batteryPercentOf(
        bike.currentPosition?.externalVoltageMv,
        this.config.get('BIKE_BATTERY_EMPTY_MV', { infer: true }),
        this.config.get('BIKE_BATTERY_FULL_MV', { infer: true }),
      ),
      current: bike.currentPosition,
    };
  }

  private historyData(
    bikeId: string,
    receivedAt: Date,
    record: DevicePosition,
  ) {
    return {
      bikeId,
      recordedAt: record.timestamp,
      receivedAt,
      latitude: record.latitude,
      longitude: record.longitude,
      altitude: record.altitude,
      angle: record.angle,
      satellites: record.satellites,
      speed: record.speed,
      ignition: record.ignition,
      movement: record.movement,
      hasFix: record.hasFix,
      ...powerAndOdometerOf(record.io),
    };
  }
}
