import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { isUniqueViolation } from '../common/prisma-errors';
import { EnforcementService } from '../enforcement/enforcement.service';
import type { Prisma } from '../generated/prisma/client';
import {
  AssignmentEndReason,
  BikeStatus,
  CustomerStatus,
  LoanStatus,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AssignBikeDto,
  CreateBikeDto,
  EndAssignmentDto,
  EndableReason,
  InstallTrackerDto,
  TransferBikeDto,
  UpdateBikeDto,
} from './dto/bike-input.dto';
import type { BikeQueryDto } from './dto/bike-query.dto';
import type {
  BikeDetailDto,
  BikePageDto,
  BikeSummaryDto,
} from './dto/bike-response.dto';

const riderSelect = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
} satisfies Prisma.CustomerSelect;

const summarySelect = {
  id: true,
  label: true,
  vin: true,
  registrationNumber: true,
  make: true,
  model: true,
  year: true,
  color: true,
  status: true,
  imei: true,
  retiredAt: true,
  createdAt: true,
  enforcement: { select: { desiredState: true, confirmedState: true } },
  assignments: {
    where: { endedAt: null },
    take: 1,
    select: { id: true, startedAt: true, customer: { select: riderSelect } },
  },
} satisfies Prisma.BikeSelect;

type SummaryRow = Prisma.BikeGetPayload<{ select: typeof summarySelect }>;

const STATUS_AFTER_END: Record<EndableReason, BikeStatus> = {
  [AssignmentEndReason.RETURNED]: BikeStatus.IN_INVENTORY,
  [AssignmentEndReason.REPOSSESSED]: BikeStatus.REPOSSESSED,
  [AssignmentEndReason.SOLD]: BikeStatus.SOLD,
};

/** Statuses a bike can hold a tracker in. A sold bike is the rider's; a retired one is gone. */
const TRACKABLE: BikeStatus[] = [
  BikeStatus.IN_INVENTORY,
  BikeStatus.ASSIGNED,
  BikeStatus.REPOSSESSED,
];

/**
 * Bike inventory, trackers and who holds each bike.
 *
 * Status is never set directly. Each action moves it with a conditional update that names the
 * statuses it may start from, so the check and the write cannot be separated by a concurrent
 * request, and logs the change in the same transaction. Assignments and tracker installations
 * are closed rather than deleted, so every past rider and device stays on record.
 */
@Injectable()
export class BikesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enforcement: EnforcementService,
  ) {}

  async create(input: CreateBikeDto, userId: string): Promise<BikeDetailDto> {
    this.checkPurchasePrice(input);

    try {
      const bike = await this.prisma.$transaction(async (tx) => {
        const created = await tx.bike.create({
          data: {
            label: input.label,
            vin: input.vin,
            registrationNumber: input.registrationNumber,
            make: input.make,
            model: input.model,
            year: input.year,
            color: input.color,
            purchasePriceMinor: input.purchasePriceMinor,
            purchaseCurrency: input.purchaseCurrency,
            purchasedAt: input.purchasedAt
              ? new Date(input.purchasedAt)
              : undefined,
            supplier: input.supplier,
          },
          select: { id: true },
        });
        await tx.bikeStatusChange.create({
          data: {
            bikeId: created.id,
            fromStatus: null,
            toStatus: BikeStatus.IN_INVENTORY,
            reason: 'Added to inventory',
            actorUserId: userId,
          },
        });
        return created;
      });
      return this.get(bike.id);
    } catch (error) {
      throw this.duplicateIdentity(error);
    }
  }

  async update(id: string, input: UpdateBikeDto): Promise<BikeDetailDto> {
    const current = await this.prisma.bike.findUnique({
      where: { id },
      select: { purchasePriceMinor: true, purchaseCurrency: true },
    });
    if (!current) {
      throw new NotFoundException('Bike not found');
    }
    this.checkPurchasePrice({
      purchasePriceMinor:
        input.purchasePriceMinor ?? current.purchasePriceMinor ?? undefined,
      purchaseCurrency:
        input.purchaseCurrency ?? current.purchaseCurrency ?? undefined,
    });

    try {
      await this.prisma.bike.update({
        where: { id },
        data: {
          label: input.label,
          vin: input.vin,
          registrationNumber: input.registrationNumber,
          make: input.make,
          model: input.model,
          year: input.year,
          color: input.color,
          purchasePriceMinor: input.purchasePriceMinor,
          purchaseCurrency: input.purchaseCurrency,
          purchasedAt: input.purchasedAt
            ? new Date(input.purchasedAt)
            : undefined,
          supplier: input.supplier,
        },
      });
    } catch (error) {
      throw this.duplicateIdentity(error);
    }
    return this.get(id);
  }

  async list(query: BikeQueryDto): Promise<BikePageDto> {
    const where: Prisma.BikeWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      AND: searchWords(query.search).map((word) => ({
        OR: [
          { registrationNumber: { contains: word, mode: 'insensitive' } },
          { vin: { contains: word, mode: 'insensitive' } },
          { label: { contains: word, mode: 'insensitive' } },
          { imei: { contains: word } },
          {
            assignments: {
              some: {
                endedAt: null,
                customer: {
                  OR: [
                    { firstName: { contains: word, mode: 'insensitive' } },
                    { lastName: { contains: word, mode: 'insensitive' } },
                    { phone: { contains: word } },
                  ],
                },
              },
            },
          },
        ],
      })),
    };

    const [rows, total] = await Promise.all([
      this.prisma.bike.findMany({
        where,
        select: summarySelect,
        orderBy: {
          [query.sortBy ?? 'createdAt']: query.sortOrder ?? 'desc',
        },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.bike.count({ where }),
    ]);

    return new PaginatedResponseDto(
      rows.map(toSummary),
      total,
      query.page,
      query.limit,
    );
  }

  async get(id: string): Promise<BikeDetailDto> {
    const bike = await this.prisma.bike.findUnique({
      where: { id },
      select: {
        ...summarySelect,
        purchasePriceMinor: true,
        purchaseCurrency: true,
        purchasedAt: true,
        supplier: true,
        trackerInstallations: {
          orderBy: { installedAt: 'desc' },
          select: {
            id: true,
            imei: true,
            installedAt: true,
            installedById: true,
            removedAt: true,
            removedById: true,
            removedReason: true,
          },
        },
        statusChanges: {
          orderBy: { createdAt: 'desc' },
          take: 100,
          select: {
            id: true,
            fromStatus: true,
            toStatus: true,
            reason: true,
            actorUserId: true,
            createdAt: true,
          },
        },
      },
    });
    if (!bike) {
      throw new NotFoundException('Bike not found');
    }

    const history = await this.prisma.bikeAssignment.findMany({
      where: { bikeId: id },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        startedAt: true,
        assignedById: true,
        endedAt: true,
        endReason: true,
        endedById: true,
        notes: true,
        customer: { select: riderSelect },
      },
    });

    return {
      ...toSummary(bike),
      purchasePriceMinor: bike.purchasePriceMinor,
      purchaseCurrency: bike.purchaseCurrency,
      purchasedAt: bike.purchasedAt,
      supplier: bike.supplier,
      trackerHistory: bike.trackerInstallations,
      assignmentHistory: history.map(({ customer, ...assignment }) => ({
        ...assignment,
        rider: riderRef(customer),
      })),
      statusHistory: bike.statusChanges,
    };
  }

  /**
   * Fits a tracker, replacing any unit already on the bike. This is the link tracking and
   * enforcement resolve IMEIs through. The IMEI must not be on another bike: taking it off
   * there first is a deliberate step, not a side effect of fitting it here.
   */
  async installTracker(
    id: string,
    input: InstallTrackerDto,
    userId: string,
  ): Promise<BikeDetailDto> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const bike = await this.requireBike(tx, id);
        if (!TRACKABLE.includes(bike.status)) {
          throw new ConflictException(
            `A ${bike.status.toLowerCase()} bike cannot be fitted with a tracker`,
          );
        }
        if (bike.imei === input.imei) {
          throw new ConflictException(
            'This tracker is already fitted to this bike',
          );
        }

        const holder = await tx.bike.findUnique({
          where: { imei: input.imei },
          select: { id: true, label: true },
        });
        if (holder) {
          throw new ConflictException(
            `Tracker ${input.imei} is fitted to ${holder.label}; remove it there first`,
          );
        }

        const now = new Date();
        if (bike.imei) {
          await this.closeInstallation(
            tx,
            id,
            now,
            userId,
            input.reason ?? 'Replaced',
          );
        }
        await tx.bikeTrackerInstallation.create({
          data: {
            bikeId: id,
            imei: input.imei,
            installedAt: now,
            installedById: userId,
          },
        });
        await tx.bike.update({
          where: { id },
          data: { imei: input.imei },
        });
        await this.enforcement.recordTrackerChange(tx, id, {
          fromImei: bike.imei,
          toImei: input.imei,
          userId,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'That tracker was just fitted elsewhere; reload and try again',
        );
      }
      throw error;
    }

    await this.enforcement.reconcile(id, 'tracker-changed');
    return this.get(id);
  }

  async removeTracker(
    id: string,
    reason: string,
    userId: string,
  ): Promise<BikeDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      const bike = await this.requireBike(tx, id);
      if (!bike.imei) {
        throw new ConflictException('No tracker is fitted to this bike');
      }
      await this.closeInstallation(tx, id, new Date(), userId, reason);
      await tx.bike.update({ where: { id }, data: { imei: null } });
      await this.enforcement.recordTrackerChange(tx, id, {
        fromImei: bike.imei,
        toImei: null,
        userId,
      });
    });

    await this.enforcement.reconcile(id, 'tracker-changed');
    return this.get(id);
  }

  /** Assigns a bike from inventory. A bike already held by a rider must be transferred. */
  async assign(
    id: string,
    input: AssignBikeDto,
    userId: string,
  ): Promise<BikeDetailDto> {
    await this.withOpenAssignmentGuard(async () => {
      await this.prisma.$transaction(async (tx) => {
        const bike = await this.requireBike(tx, id);
        if (bike.status === BikeStatus.ASSIGNED) {
          throw new ConflictException(
            'This bike is already assigned to a rider; transfer it instead',
          );
        }
        await this.requireAssignableRider(tx, input.customerId);

        await this.moveStatus(
          tx,
          id,
          [BikeStatus.IN_INVENTORY],
          BikeStatus.ASSIGNED,
          'Assigned to rider',
          userId,
        );
        await tx.bikeAssignment.create({
          data: {
            bikeId: id,
            customerId: input.customerId,
            assignedById: userId,
            notes: input.notes,
          },
        });
      });
    });
    return this.get(id);
  }

  /**
   * Moves a bike from one rider to another in one step: the previous assignment ends and the
   * next starts at the same instant, so there is never a moment with no holder or two.
   */
  async transfer(
    id: string,
    input: TransferBikeDto,
    userId: string,
  ): Promise<BikeDetailDto> {
    await this.withOpenAssignmentGuard(async () => {
      await this.prisma.$transaction(async (tx) => {
        const bike = await this.requireBike(tx, id);
        if (bike.status !== BikeStatus.ASSIGNED) {
          throw new ConflictException(
            'Only an assigned bike can be transferred; assign it instead',
          );
        }
        const open = await this.requireOpenAssignment(tx, id);
        if (open.customerId === input.customerId) {
          throw new ConflictException('The bike is already with this rider');
        }
        await this.refuseIfOpenLoan(tx, id, 'transferred');
        await this.requireAssignableRider(tx, input.customerId);

        const now = new Date();
        await this.closeAssignment(
          tx,
          open.id,
          now,
          AssignmentEndReason.TRANSFERRED,
          userId,
          input.reason,
        );
        await tx.bikeAssignment.create({
          data: {
            bikeId: id,
            customerId: input.customerId,
            startedAt: now,
            assignedById: userId,
            notes: input.reason,
          },
        });
      });
    });
    return this.get(id);
  }

  async endAssignment(
    id: string,
    input: EndAssignmentDto,
    userId: string,
  ): Promise<BikeDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.refuseIfOpenLoan(
        tx,
        id,
        input.reason === AssignmentEndReason.SOLD ? 'sold' : 'taken back',
      );
      await this.closeCurrentAssignment(
        tx,
        id,
        input.reason,
        input.notes,
        userId,
      );
    });
    return this.get(id);
  }

  /**
   * For the loans module only, inside the transaction that repossesses a loan: ends the
   * assignment the loan financed, which the public path refuses while a loan is open.
   */
  async repossessUnderLoan(
    tx: Prisma.TransactionClient,
    bikeId: string,
    notes: string,
    userId: string,
  ): Promise<void> {
    await this.closeCurrentAssignment(
      tx,
      bikeId,
      AssignmentEndReason.REPOSSESSED,
      notes,
      userId,
    );
  }

  private async closeCurrentAssignment(
    tx: Prisma.TransactionClient,
    id: string,
    reason: EndableReason,
    notes: string | undefined,
    userId: string,
  ): Promise<void> {
    const open = await this.requireOpenAssignment(tx, id);
    await this.moveStatus(
      tx,
      id,
      [BikeStatus.ASSIGNED],
      STATUS_AFTER_END[reason],
      notes ?? endReasonText(reason),
      userId,
    );
    await this.closeAssignment(tx, open.id, new Date(), reason, userId, notes);
  }

  /**
   * While a loan is open the bike is collateral: it cannot change hands, go back to stock, or be
   * sold around the loan. A sale follows a completed loan; a repossession goes through the loan.
   */
  private async refuseIfOpenLoan(
    tx: Prisma.TransactionClient,
    bikeId: string,
    action: string,
  ): Promise<void> {
    const loan = await tx.loan.findFirst({
      where: {
        bikeId,
        status: { in: [LoanStatus.ACTIVE, LoanStatus.DEFAULTED] },
      },
      select: { id: true },
    });
    if (loan) {
      throw new ConflictException(
        `This bike has an open loan (${loan.id}) and cannot be ${action}; ` +
          'settle the loan, or repossess through the loan',
      );
    }
  }

  /** A repossessed bike goes back into inventory once it has been checked over. */
  async restock(
    id: string,
    reason: string,
    userId: string,
  ): Promise<BikeDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.requireBike(tx, id);
      await this.moveStatus(
        tx,
        id,
        [BikeStatus.REPOSSESSED],
        BikeStatus.IN_INVENTORY,
        reason,
        userId,
      );
    });
    return this.get(id);
  }

  /**
   * Takes a bike out of service for good. The record, and everything that points at it, stays:
   * bikes are retired, never deleted.
   */
  async retire(
    id: string,
    reason: string,
    userId: string,
  ): Promise<BikeDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.requireBike(tx, id);
      await this.moveStatus(
        tx,
        id,
        [BikeStatus.IN_INVENTORY, BikeStatus.REPOSSESSED],
        BikeStatus.RETIRED,
        reason,
        userId,
      );
    });
    return this.get(id);
  }

  /**
   * The only way status changes. The update names the statuses it may start from, so a request
   * racing another sees count 0 and gets a 409 instead of overwriting it.
   */
  private async moveStatus(
    tx: Prisma.TransactionClient,
    id: string,
    from: BikeStatus[],
    to: BikeStatus,
    reason: string,
    userId: string,
  ): Promise<void> {
    const current = await tx.bike.findUnique({
      where: { id },
      select: { status: true },
    });
    const moved = await tx.bike.updateMany({
      where: { id, status: { in: from } },
      data: {
        status: to,
        ...(to === BikeStatus.RETIRED ? { retiredAt: new Date() } : {}),
      },
    });
    if (moved.count !== 1 || !current) {
      throw new ConflictException(
        `A bike that is ${describeStatus(current?.status)} cannot become ${describeStatus(to)}`,
      );
    }
    await tx.bikeStatusChange.create({
      data: {
        bikeId: id,
        fromStatus: current.status,
        toStatus: to,
        reason,
        actorUserId: userId,
      },
    });
  }

  private async requireBike(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<{ id: string; status: BikeStatus; imei: string | null }> {
    const bike = await tx.bike.findUnique({
      where: { id },
      select: { id: true, status: true, imei: true },
    });
    if (!bike) {
      throw new NotFoundException('Bike not found');
    }
    return bike;
  }

  private async requireOpenAssignment(
    tx: Prisma.TransactionClient,
    bikeId: string,
  ): Promise<{ id: string; customerId: string }> {
    await this.requireBike(tx, bikeId);
    const open = await tx.bikeAssignment.findFirst({
      where: { bikeId, endedAt: null },
      select: { id: true, customerId: true },
    });
    if (!open) {
      throw new ConflictException('This bike is not assigned to anyone');
    }
    return open;
  }

  /** Credit goes only to a rider whose identity has been verified and who is in good standing. */
  private async requireAssignableRider(
    tx: Prisma.TransactionClient,
    customerId: string,
  ): Promise<void> {
    const rider = await tx.customer.findUnique({
      where: { id: customerId },
      select: { status: true },
    });
    if (!rider) {
      throw new NotFoundException('Rider not found');
    }
    if (rider.status !== CustomerStatus.ACTIVE) {
      throw new ConflictException(
        rider.status === CustomerStatus.PENDING_KYC
          ? 'The rider must pass KYC before a bike can be assigned'
          : `A rider who is ${rider.status.toLowerCase()} cannot be assigned a bike`,
      );
    }
  }

  private async closeInstallation(
    tx: Prisma.TransactionClient,
    bikeId: string,
    at: Date,
    userId: string,
    reason: string,
  ): Promise<void> {
    await tx.bikeTrackerInstallation.updateMany({
      where: { bikeId, removedAt: null },
      data: { removedAt: at, removedById: userId, removedReason: reason },
    });
  }

  private async closeAssignment(
    tx: Prisma.TransactionClient,
    assignmentId: string,
    at: Date,
    reason: AssignmentEndReason,
    userId: string,
    notes: string | undefined,
  ): Promise<void> {
    const closed = await tx.bikeAssignment.updateMany({
      where: { id: assignmentId, endedAt: null },
      data: {
        endedAt: at,
        endReason: reason,
        endedById: userId,
        ...(notes ? { notes } : {}),
      },
    });
    if (closed.count !== 1) {
      throw new ConflictException(
        'The assignment changed while this request was running; reload and try again',
      );
    }
  }

  /** The partial unique index on open assignments is the last line against a double assign. */
  private async withOpenAssignmentGuard(run: () => Promise<void>) {
    try {
      await run();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'This bike was just assigned by someone else; reload and try again',
        );
      }
      throw error;
    }
  }

  private checkPurchasePrice(input: {
    purchasePriceMinor?: number;
    purchaseCurrency?: string;
  }): void {
    if (
      (input.purchasePriceMinor === undefined) !==
      (input.purchaseCurrency === undefined)
    ) {
      throw new BadRequestException(
        'purchasePriceMinor and purchaseCurrency go together: give both or neither',
      );
    }
  }

  private duplicateIdentity(error: unknown): unknown {
    return isUniqueViolation(error)
      ? new ConflictException(
          'A bike with this VIN or registration number already exists',
        )
      : error;
  }
}

function searchWords(search: string | undefined): string[] {
  return (search ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
}

function riderRef(customer: {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
}) {
  return {
    customerId: customer.id,
    firstName: customer.firstName,
    lastName: customer.lastName,
    phone: customer.phone,
  };
}

function toSummary(bike: SummaryRow): BikeSummaryDto {
  const open = bike.assignments[0];
  return {
    id: bike.id,
    label: bike.label,
    vin: bike.vin,
    registrationNumber: bike.registrationNumber,
    make: bike.make,
    model: bike.model,
    year: bike.year,
    color: bike.color,
    status: bike.status,
    imei: bike.imei,
    currentRider: open
      ? {
          ...riderRef(open.customer),
          assignmentId: open.id,
          since: open.startedAt,
        }
      : null,
    mobility: bike.enforcement
      ? {
          desiredState: bike.enforcement.desiredState,
          confirmedState: bike.enforcement.confirmedState,
        }
      : null,
    retiredAt: bike.retiredAt,
    createdAt: bike.createdAt,
  };
}

function describeStatus(status: BikeStatus | undefined): string {
  return status ? status.toLowerCase().replace('_', ' ') : 'unknown';
}

function endReasonText(reason: EndableReason): string {
  switch (reason) {
    case AssignmentEndReason.RETURNED:
      return 'Returned to inventory';
    case AssignmentEndReason.REPOSSESSED:
      return 'Repossessed';
    case AssignmentEndReason.SOLD:
      return 'Sold to rider';
  }
}
