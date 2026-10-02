import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GEOFENCE_EXITED, type GeofenceExitedEvent } from '../common/events';
import type { Prisma } from '../generated/prisma/client';
import { GeofenceCrossingDirection } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateGeofenceDto,
  GeofenceDto,
  UpdateGeofenceDto,
} from './dto/geofence.dto';
import { isInsidePolygon, parsePolygon, type LatLng } from './geometry';

interface Zone {
  id: string;
  name: string;
  polygon: LatLng[];
}

/** How long the zones are held in memory between reads; positions arrive far more often. */
const ZONE_CACHE_MS = 30_000;

/**
 * GPS wanders by a few metres, so a bike parked on a boundary would cross it back and forth all
 * day. Once a bike has crossed, another crossing of the same zone is not accepted for this
 * long; if it is still on the other side afterwards, that crossing is recorded then.
 */
export const MIN_CROSSING_INTERVAL_MS = 2 * 60_000;

const zoneSelect = {
  id: true,
  name: true,
  polygon: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.GeofenceSelect;

type ZoneRow = Prisma.GeofenceGetPayload<{ select: typeof zoneSelect }>;

/**
 * Operating zones: outlines drawn once and reused, and the record of bikes crossing them.
 *
 * A crossing is recorded when a bike's position moves from one side of a zone to the other,
 * so the dashboard's activity feed can show it without anyone watching the map. The first
 * position seen for a bike and zone only sets the baseline: a zone drawn around bikes that are
 * already outside it does not raise an alert for each of them.
 *
 * Zones are removed, never deleted, so a past crossing still names the zone it was about.
 */
@Injectable()
export class GeofencesService {
  private readonly logger = new Logger(GeofencesService.name);
  /** Per process. With several instances a new zone is picked up within ZONE_CACHE_MS. */
  private cache: { readAt: number; zones: Zone[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async list(): Promise<GeofenceDto[]> {
    const rows = await this.prisma.geofence.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: zoneSelect,
    });
    return rows.map(toDto);
  }

  async create(
    input: CreateGeofenceDto,
    actorId: string,
  ): Promise<GeofenceDto> {
    const row = await this.prisma.geofence.create({
      data: {
        name: input.name,
        polygon: requirePolygon(input.polygon),
        createdById: actorId,
      },
      select: zoneSelect,
    });
    this.cache = null;
    return toDto(row);
  }

  async update(id: string, input: UpdateGeofenceDto): Promise<GeofenceDto> {
    const polygon =
      input.polygon === undefined ? undefined : requirePolygon(input.polygon);

    const row = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.geofence.updateMany({
        where: { id, deletedAt: null },
        data: { name: input.name, polygon },
      });
      if (changed.count !== 1) {
        throw new NotFoundException('Zone not found');
      }
      if (polygon) {
        // Which side each bike was on described the old outline, not this one.
        await tx.bikeGeofenceState.deleteMany({ where: { geofenceId: id } });
      }
      return tx.geofence.findUniqueOrThrow({
        where: { id },
        select: zoneSelect,
      });
    });
    this.cache = null;
    return toDto(row);
  }

  async remove(id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const removed = await tx.geofence.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (removed.count !== 1) {
        throw new NotFoundException('Zone not found');
      }
      await tx.bikeGeofenceState.deleteMany({ where: { geofenceId: id } });
    });
    this.cache = null;
  }

  /**
   * Called for each new current position that has a GPS fix. Compares the side of every zone
   * the bike is on now with the side it was on, and records a crossing where they differ.
   * Never throws: a zone check must not stop a position from being stored.
   */
  async observe(
    bikeId: string,
    latitude: number,
    longitude: number,
    recordedAt: Date,
  ): Promise<void> {
    try {
      const zones = await this.activeZones();
      if (zones.length === 0) {
        return;
      }
      const states = await this.prisma.bikeGeofenceState.findMany({
        where: { bikeId },
        select: { geofenceId: true, inside: true, since: true },
      });

      for (const zone of zones) {
        const inside = isInsidePolygon([latitude, longitude], zone.polygon);
        const known = states.find((state) => state.geofenceId === zone.id);

        if (!known) {
          await this.prisma.bikeGeofenceState.createMany({
            data: [{ bikeId, geofenceId: zone.id, inside, since: recordedAt }],
            skipDuplicates: true,
          });
          continue;
        }
        if (
          known.inside === inside ||
          recordedAt.getTime() - known.since.getTime() <
            MIN_CROSSING_INTERVAL_MS
        ) {
          continue;
        }

        const crossing = await this.prisma.$transaction(async (tx) => {
          // Conditional on the side last recorded, so two positions handled at once cannot
          // both record the same crossing.
          const moved = await tx.bikeGeofenceState.updateMany({
            where: { bikeId, geofenceId: zone.id, inside: known.inside },
            data: { inside, since: recordedAt },
          });
          if (moved.count !== 1) {
            return null;
          }
          return tx.geofenceCrossing.create({
            data: {
              bikeId,
              geofenceId: zone.id,
              direction: inside
                ? GeofenceCrossingDirection.ENTERED
                : GeofenceCrossingDirection.EXITED,
              latitude,
              longitude,
              recordedAt,
            },
            select: { id: true },
          });
        });
        // After the commit, and only for a bike leaving: staff who asked are told.
        if (crossing && !inside) {
          const event: GeofenceExitedEvent = {
            crossingId: crossing.id,
            bikeId,
            geofenceName: zone.name,
          };
          this.events.emit(GEOFENCE_EXITED, event);
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not check zones for bike ${bikeId}: ${detail}`);
    }
  }

  private async activeZones(): Promise<Zone[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.readAt < ZONE_CACHE_MS) {
      return this.cache.zones;
    }
    const rows = await this.prisma.geofence.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, polygon: true },
    });
    const zones = rows.flatMap((row) => {
      const polygon = parsePolygon(row.polygon);
      return polygon ? [{ id: row.id, name: row.name, polygon }] : [];
    });
    this.cache = { readAt: now, zones };
    return zones;
  }
}

function requirePolygon(value: unknown): LatLng[] {
  const polygon = parsePolygon(value);
  if (!polygon) {
    throw new BadRequestException(
      'polygon must be three or more [latitude, longitude] corners that enclose an area',
    );
  }
  return polygon;
}

function toDto(row: ZoneRow): GeofenceDto {
  return {
    id: row.id,
    name: row.name,
    polygon: parsePolygon(row.polygon) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
