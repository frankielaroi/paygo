import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { isUniqueViolation } from '../common/prisma-errors';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import type { Prisma } from '../generated/prisma/client';
import {
  AssignmentEndReason,
  CustomerStatus,
  StaffRole,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { Permission, roleHasPermission } from '../users/enums/role.enum';
import {
  type CreateCustomerDto,
  type CustomerQueryDto,
  normalizePhone,
  type UpdateCustomerDto,
} from './dto/customer-input.dto';
import type {
  CustomerDetailDto,
  CustomerPageDto,
  CustomerSummaryDto,
} from './dto/customer-response.dto';

const bikeRefSelect = {
  id: true,
  label: true,
  registrationNumber: true,
  vin: true,
} satisfies Prisma.BikeSelect;

const summarySelect = {
  id: true,
  status: true,
  firstName: true,
  lastName: true,
  phone: true,
  nationalId: true,
  district: true,
  region: true,
  assignedAgentId: true,
  kycVerifiedAt: true,
  createdAt: true,
  bikeAssignments: {
    where: { endedAt: null },
    select: { bike: { select: bikeRefSelect } },
  },
} satisfies Prisma.CustomerSelect;

type SummaryRow = Prisma.CustomerGetPayload<{ select: typeof summarySelect }>;

/** Fields whose change means the KYC on file no longer describes this person. */
const KYC_FIELDS = [
  'firstName',
  'lastName',
  'nationalId',
  'dateOfBirth',
  'photoUrl',
  'idDocumentUrl',
] as const;

/**
 * Riders: the people credit is extended to.
 *
 * Ownership is enforced here, not only by role: a field agent sees and edits only riders
 * assigned to them, and a rider outside their scope is a 404, not a 403, so the endpoint does
 * not confirm that the record exists. Riders are deactivated, never deleted.
 */
@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    input: CreateCustomerDto,
    actor: AuthenticatedStaff,
  ): Promise<CustomerDetailDto> {
    const assignedAgentId = await this.agentFor(input.assignedAgentId, actor);

    try {
      const customer = await this.prisma.customer.create({
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
          alternatePhone: input.alternatePhone,
          nationalId: input.nationalId,
          dateOfBirth: input.dateOfBirth
            ? new Date(input.dateOfBirth)
            : undefined,
          photoUrl: input.photoUrl,
          idDocumentUrl: input.idDocumentUrl,
          addressLine: input.addressLine,
          ward: input.ward,
          district: input.district,
          region: input.region,
          registeredById: actor.id,
          assignedAgentId,
          contacts: input.contacts?.length
            ? { create: input.contacts }
            : undefined,
        },
        select: { id: true },
      });
      return this.get(customer.id, actor);
    } catch (error) {
      throw this.duplicateIdentity(error);
    }
  }

  async list(
    query: CustomerQueryDto,
    actor: AuthenticatedStaff,
  ): Promise<CustomerPageDto> {
    const where: Prisma.CustomerWhereInput = {
      ...this.scope(actor),
      ...(query.status ? { status: query.status } : {}),
      AND: searchWords(query.search).map((word) => ({
        OR: [
          { firstName: { contains: word, mode: 'insensitive' } },
          { lastName: { contains: word, mode: 'insensitive' } },
          { phone: { contains: normalizePhone(word) } },
          { nationalId: { contains: word, mode: 'insensitive' } },
        ],
      })),
    };

    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        select: summarySelect,
        orderBy: {
          [query.sortBy ?? 'createdAt']: query.sortOrder ?? 'desc',
        },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.customer.count({ where }),
    ]);

    return new PaginatedResponseDto(
      rows.map(toSummary),
      total,
      query.page,
      query.limit,
    );
  }

  async get(id: string, actor: AuthenticatedStaff): Promise<CustomerDetailDto> {
    const customer = await this.prisma.customer.findFirst({
      where: { id, ...this.scope(actor) },
      select: {
        ...summarySelect,
        alternatePhone: true,
        dateOfBirth: true,
        photoUrl: true,
        idDocumentUrl: true,
        addressLine: true,
        ward: true,
        registeredById: true,
        kycVerifiedById: true,
        deactivatedAt: true,
        deactivationReason: true,
        contacts: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            type: true,
            firstName: true,
            lastName: true,
            phone: true,
            relationship: true,
            nationalId: true,
            addressLine: true,
          },
        },
      },
    });
    if (!customer) {
      throw new NotFoundException('Rider not found');
    }

    const history = await this.prisma.bikeAssignment.findMany({
      where: { customerId: id },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        startedAt: true,
        endedAt: true,
        endReason: true,
        bike: { select: bikeRefSelect },
      },
    });

    const { contacts, ...rest } = customer;
    return {
      ...toSummary(rest),
      alternatePhone: rest.alternatePhone,
      dateOfBirth: rest.dateOfBirth,
      photoUrl: rest.photoUrl,
      idDocumentUrl: rest.idDocumentUrl,
      addressLine: rest.addressLine,
      ward: rest.ward,
      registeredById: rest.registeredById,
      kycVerifiedById: rest.kycVerifiedById,
      deactivatedAt: rest.deactivatedAt,
      deactivationReason: rest.deactivationReason,
      contacts,
      bikeHistory: history.map((assignment) => ({
        assignmentId: assignment.id,
        bike: bikeRef(assignment.bike),
        startedAt: assignment.startedAt,
        endedAt: assignment.endedAt,
        endReason: assignment.endReason,
      })),
      risk: {
        // Transfers are excluded: one bike moving on is not the rider taking another.
        bikesHeld: history.filter(
          (row) => row.endReason !== AssignmentEndReason.TRANSFERRED,
        ).length,
        currentlyHolding: history.filter((row) => row.endedAt === null).length,
        repossessions: history.filter(
          (row) => row.endReason === AssignmentEndReason.REPOSSESSED,
        ).length,
        paidOff: history.filter(
          (row) => row.endReason === AssignmentEndReason.SOLD,
        ).length,
      },
    };
  }

  async update(
    id: string,
    input: UpdateCustomerDto,
    actor: AuthenticatedStaff,
  ): Promise<CustomerDetailDto> {
    const current = await this.prisma.customer.findFirst({
      where: { id, ...this.scope(actor) },
      select: {
        status: true,
        phone: true,
        kycVerifiedAt: true,
        firstName: true,
        lastName: true,
        nationalId: true,
        dateOfBirth: true,
        photoUrl: true,
        idDocumentUrl: true,
      },
    });
    if (!current) {
      throw new NotFoundException('Rider not found');
    }

    const dateOfBirth =
      input.dateOfBirth !== undefined ? new Date(input.dateOfBirth) : undefined;
    const proposed = { ...input, dateOfBirth };
    const kycChanged = KYC_FIELDS.some((field) => {
      const next = proposed[field];
      if (next === undefined) {
        return false;
      }
      const before = current[field];
      return next instanceof Date && before instanceof Date
        ? next.getTime() !== before.getTime()
        : next !== before;
    });
    const resetKyc = kycChanged && current.kycVerifiedAt !== null;

    try {
      await this.prisma.customer.update({
        where: { id },
        data: {
          ...input,
          dateOfBirth,
          ...(input.phone !== undefined && input.phone !== current.phone
            ? { phoneVerifiedAt: null }
            : {}),
          ...(resetKyc
            ? {
                kycVerifiedAt: null,
                kycVerifiedById: null,
                ...(current.status === CustomerStatus.ACTIVE
                  ? { status: CustomerStatus.PENDING_KYC }
                  : {}),
              }
            : {}),
        },
      });
    } catch (error) {
      throw this.duplicateIdentity(error);
    }
    return this.get(id, actor);
  }

  /**
   * Marks the rider's identity as checked. Needs the documents on file, and a rider already
   * past KYC (or suspended, defaulted, closed) is not silently moved back to active.
   */
  async verifyKyc(
    id: string,
    actor: AuthenticatedStaff,
  ): Promise<CustomerDetailDto> {
    const customer = await this.prisma.customer.findFirst({
      where: { id, ...this.scope(actor) },
      select: { status: true, photoUrl: true, idDocumentUrl: true },
    });
    if (!customer) {
      throw new NotFoundException('Rider not found');
    }
    if (customer.status !== CustomerStatus.PENDING_KYC) {
      throw new ConflictException(
        `Only a rider pending KYC can be verified; this one is ${customer.status.toLowerCase()}`,
      );
    }
    if (!customer.photoUrl || !customer.idDocumentUrl) {
      throw new ConflictException(
        'Add the photo and ID document before verifying KYC',
      );
    }

    const verified = await this.prisma.customer.updateMany({
      where: { id, status: CustomerStatus.PENDING_KYC },
      data: {
        status: CustomerStatus.ACTIVE,
        kycVerifiedAt: new Date(),
        kycVerifiedById: actor.id,
      },
    });
    if (verified.count !== 1) {
      throw new ConflictException('The rider changed; reload and try again');
    }
    return this.get(id, actor);
  }

  /** Closes a rider's record. Refused while they hold a bike, so no bike is left with nobody. */
  async deactivate(
    id: string,
    reason: string,
    actor: AuthenticatedStaff,
  ): Promise<CustomerDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id, ...this.scope(actor) },
        select: { status: true },
      });
      if (!customer) {
        throw new NotFoundException('Rider not found');
      }
      if (customer.status === CustomerStatus.CLOSED) {
        throw new ConflictException('This rider is already deactivated');
      }

      const holding = await tx.bikeAssignment.findFirst({
        where: { customerId: id, endedAt: null },
        select: { bike: { select: { label: true } } },
      });
      if (holding) {
        throw new ConflictException(
          `The rider still holds ${holding.bike.label}; end or transfer that assignment first`,
        );
      }

      await tx.customer.update({
        where: { id },
        data: {
          status: CustomerStatus.CLOSED,
          deactivatedAt: new Date(),
          deactivationReason: reason,
        },
      });
    });
    return this.get(id, actor);
  }

  /** Riders a caller may see: all of them with READ_ALL, otherwise their own. */
  private scope(actor: AuthenticatedStaff): Prisma.CustomerWhereInput {
    return roleHasPermission(actor.role, Permission.CUSTOMER_READ_ALL)
      ? {}
      : { assignedAgentId: actor.id };
  }

  private async agentFor(
    requested: string | undefined,
    actor: AuthenticatedStaff,
  ): Promise<string | null> {
    if (!roleHasPermission(actor.role, Permission.CUSTOMER_READ_ALL)) {
      if (requested !== undefined && requested !== actor.id) {
        throw new ForbiddenException(
          'A field agent registers riders to themselves',
        );
      }
      return actor.id;
    }
    if (requested === undefined) {
      return null;
    }

    const agent = await this.prisma.user.findUnique({
      where: { id: requested },
      select: { role: true, isActive: true },
    });
    if (!agent || !agent.isActive || agent.role !== StaffRole.FIELD_AGENT) {
      throw new BadRequestException(
        'assignedAgentId must be an active field agent',
      );
    }
    return requested;
  }

  private duplicateIdentity(error: unknown): unknown {
    return isUniqueViolation(error)
      ? new ConflictException(
          'A rider with this phone number or national ID already exists',
        )
      : error;
  }
}

function searchWords(search: string | undefined): string[] {
  return (search ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
}

function bikeRef(bike: {
  id: string;
  label: string;
  registrationNumber: string | null;
  vin: string;
}) {
  return {
    bikeId: bike.id,
    label: bike.label,
    registrationNumber: bike.registrationNumber,
    vin: bike.vin,
  };
}

function toSummary(customer: SummaryRow): CustomerSummaryDto {
  return {
    id: customer.id,
    status: customer.status,
    firstName: customer.firstName,
    lastName: customer.lastName,
    phone: customer.phone,
    nationalId: customer.nationalId,
    district: customer.district,
    region: customer.region,
    assignedAgentId: customer.assignedAgentId,
    kycVerifiedAt: customer.kycVerifiedAt,
    currentBikes: customer.bikeAssignments.map((row) => bikeRef(row.bike)),
    createdAt: customer.createdAt,
  };
}
