import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PasswordService } from '../auth/password.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { isUniqueViolation } from '../common/prisma-errors';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import type { Prisma } from '../generated/prisma/client';
import { StaffAuditEventType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateStaffDto,
  StaffDto,
  StaffPageDto,
  StaffQueryDto,
  StaffWithPasswordDto,
  UpdateMeDto,
  UpdateStaffDto,
} from './dto/staff.dto';
import { permissionsFor, StaffRole } from './enums/role.enum';

const staffSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  role: true,
  branch: true,
  supervisorId: true,
  isActive: true,
  mustChangePassword: true,
  passwordChangedAt: true,
  lastLoginAt: true,
  deactivatedAt: true,
  deactivationReason: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

type StaffRow = Prisma.UserGetPayload<{ select: typeof staffSelect }>;
type Tx = Prisma.TransactionClient;

/**
 * Staff accounts: who exists, what role they hold, and whether they may sign in.
 *
 * - Nobody is deleted. Deactivation stops sign-in immediately (login, refresh and every request
 *   check isActive) and revokes every session, while every audit row naming the person stays.
 * - An account an admin creates, or whose password an admin resets, gets a generated temporary
 *   password shown once, and can do nothing but change it until it does.
 * - There is always at least one active admin: nobody can deactivate or demote the last one,
 *   and nobody can deactivate themselves or change their own role.
 * - Every change is written to the append-only staff audit log with who made it.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: RefreshTokenService,
  ) {}

  async create(
    input: CreateStaffDto,
    actor: AuthenticatedStaff,
  ): Promise<StaffWithPasswordDto> {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.passwords.hash(temporaryPassword);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        if (input.supervisorId) {
          await this.requireActiveStaff(tx, input.supervisorId, 'supervisorId');
        }
        const user = await tx.user.create({
          data: {
            email: input.email,
            firstName: input.firstName,
            lastName: input.lastName,
            phone: input.phone,
            role: input.role,
            branch: input.branch,
            supervisorId: input.supervisorId,
            passwordHash,
            mustChangePassword: true,
          },
          select: staffSelect,
        });
        await this.audit(
          tx,
          StaffAuditEventType.ACCOUNT_CREATED,
          actor,
          user.id,
          {
            email: user.email,
            role: user.role,
          },
        );
        return user;
      });
      return { staff: toDto(created), temporaryPassword };
    } catch (error) {
      throw this.duplicate(error);
    }
  }

  async list(query: StaffQueryDto): Promise<StaffPageDto> {
    const words = (query.search ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5);
    const where: Prisma.UserWhereInput = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.active !== undefined ? { isActive: query.active } : {}),
      AND: words.map((word) => ({
        OR: [
          { firstName: { contains: word, mode: 'insensitive' } },
          { lastName: { contains: word, mode: 'insensitive' } },
          { email: { contains: word, mode: 'insensitive' } },
          { phone: { contains: word } },
        ],
      })),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: staffSelect,
        orderBy: [{ isActive: 'desc' }, { lastName: 'asc' }],
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return new PaginatedResponseDto(
      rows.map(toDto),
      total,
      query.page,
      query.limit,
    );
  }

  async get(id: string): Promise<StaffDto> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: staffSelect,
    });
    if (!user) {
      throw new NotFoundException('Staff member not found');
    }
    return toDto(user);
  }

  async update(
    id: string,
    input: UpdateStaffDto,
    actor: AuthenticatedStaff,
  ): Promise<StaffDto> {
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const current = await this.requireStaff(tx, id);

        if (input.role !== undefined && input.role !== current.role) {
          if (id === actor.id) {
            throw new ConflictException(
              'You cannot change your own role; ask another admin',
            );
          }
          if (current.role === StaffRole.ADMIN && current.isActive) {
            await this.requireAnotherActiveAdmin(tx, id);
          }
        }
        if (input.supervisorId !== undefined) {
          if (input.supervisorId === id) {
            throw new BadRequestException(
              'A staff member cannot supervise themselves',
            );
          }
          await this.requireActiveStaff(tx, input.supervisorId, 'supervisorId');
        }

        const user = await tx.user.update({
          where: { id },
          data: {
            firstName: input.firstName,
            lastName: input.lastName,
            phone: input.phone,
            role: input.role,
            branch: input.branch,
            supervisorId: input.supervisorId,
          },
          select: staffSelect,
        });

        if (input.role !== undefined && input.role !== current.role) {
          await this.audit(tx, StaffAuditEventType.ROLE_CHANGED, actor, id, {
            from: current.role,
            to: input.role,
          });
        }
        const changed = changedFields(current, input, [
          'firstName',
          'lastName',
          'phone',
          'branch',
          'supervisorId',
        ]);
        if (changed.length > 0) {
          await this.audit(tx, StaffAuditEventType.PROFILE_UPDATED, actor, id, {
            fields: changed,
          });
        }
        return user;
      });
      return toDto(updated);
    } catch (error) {
      throw this.duplicate(error);
    }
  }

  async deactivate(
    id: string,
    reason: string,
    actor: AuthenticatedStaff,
  ): Promise<StaffDto> {
    if (id === actor.id) {
      throw new ConflictException('You cannot deactivate your own account');
    }
    const user = await this.prisma.$transaction(async (tx) => {
      const current = await this.requireStaff(tx, id);
      if (!current.isActive) {
        throw new ConflictException('This account is already deactivated');
      }
      if (current.role === StaffRole.ADMIN) {
        await this.requireAnotherActiveAdmin(tx, id);
      }
      const updated = await tx.user.update({
        where: { id },
        data: {
          isActive: false,
          deactivatedAt: new Date(),
          deactivationReason: reason,
        },
        select: staffSelect,
      });
      await this.audit(tx, StaffAuditEventType.DEACTIVATED, actor, id, {
        reason,
      });
      return updated;
    });
    // After commit: the account can no longer refresh, and its access tokens already fail
    // because every request re-reads isActive.
    await this.sessions.revokeAllForUser(id);
    return toDto(user);
  }

  async reactivate(id: string, actor: AuthenticatedStaff): Promise<StaffDto> {
    const user = await this.prisma.$transaction(async (tx) => {
      const current = await this.requireStaff(tx, id);
      if (current.isActive) {
        throw new ConflictException('This account is already active');
      }
      const updated = await tx.user.update({
        where: { id },
        data: {
          isActive: true,
          deactivatedAt: null,
          deactivationReason: null,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
        select: staffSelect,
      });
      await this.audit(tx, StaffAuditEventType.REACTIVATED, actor, id, null);
      return updated;
    });
    return toDto(user);
  }

  /** A new temporary password, shown once; every session of the account ends. */
  async resetPassword(
    id: string,
    actor: AuthenticatedStaff,
  ): Promise<StaffWithPasswordDto> {
    if (id === actor.id) {
      throw new ConflictException(
        'Change your own password with POST /me/password',
      );
    }
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    const user = await this.prisma.$transaction(async (tx) => {
      await this.requireStaff(tx, id);
      const updated = await tx.user.update({
        where: { id },
        data: {
          passwordHash,
          mustChangePassword: true,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
        select: staffSelect,
      });
      await this.audit(tx, StaffAuditEventType.PASSWORD_RESET, actor, id, null);
      return updated;
    });
    await this.sessions.revokeAllForUser(id);
    return { staff: toDto(user), temporaryPassword };
  }

  async getMe(actor: AuthenticatedStaff): Promise<StaffDto> {
    return this.get(actor.id);
  }

  async updateMe(
    input: UpdateMeDto,
    actor: AuthenticatedStaff,
  ): Promise<StaffDto> {
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const current = await this.requireStaff(tx, actor.id);
        const updated = await tx.user.update({
          where: { id: actor.id },
          data: {
            firstName: input.firstName,
            lastName: input.lastName,
            phone: input.phone,
          },
          select: staffSelect,
        });
        const changed = changedFields(current, input, [
          'firstName',
          'lastName',
          'phone',
        ]);
        if (changed.length > 0) {
          await this.audit(
            tx,
            StaffAuditEventType.PROFILE_UPDATED,
            actor,
            actor.id,
            {
              fields: changed,
            },
          );
        }
        return updated;
      });
      return toDto(user);
    } catch (error) {
      throw this.duplicate(error);
    }
  }

  /**
   * Changes the caller's own password. Needs the current one, clears a temporary-password
   * requirement, and ends every session, including the one making the request: a password
   * change is what someone does after suspecting a compromise.
   */
  async changePassword(
    actor: AuthenticatedStaff,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { passwordHash: true },
    });
    if (
      !user ||
      !(await this.passwords.verify(user.passwordHash, currentPassword))
    ) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    if (await this.passwords.verify(user.passwordHash, newPassword)) {
      throw new BadRequestException(
        'The new password must differ from the current one',
      );
    }

    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: actor.id },
        data: {
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: new Date(),
        },
      });
      await this.audit(
        tx,
        StaffAuditEventType.PASSWORD_CHANGED,
        actor,
        actor.id,
        null,
      );
    });
    await this.sessions.revokeAllForUser(actor.id);
  }

  /**
   * Locks every active admin row first, so two admins demoting or deactivating each other at
   * the same moment cannot both succeed and leave nobody in charge.
   */
  private async requireAnotherActiveAdmin(
    tx: Tx,
    excludingId: string,
  ): Promise<void> {
    const admins = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "users" WHERE "role" = 'ADMIN' AND "isActive" = true FOR UPDATE
    `;
    if (!admins.some((admin) => admin.id !== excludingId)) {
      throw new ConflictException(
        'This is the last active admin; make someone else an admin first',
      );
    }
  }

  private async requireStaff(tx: Tx, id: string): Promise<StaffRow> {
    const user = await tx.user.findUnique({
      where: { id },
      select: staffSelect,
    });
    if (!user) {
      throw new NotFoundException('Staff member not found');
    }
    return user;
  }

  private async requireActiveStaff(
    tx: Tx,
    id: string,
    field: string,
  ): Promise<void> {
    const user = await tx.user.findUnique({
      where: { id },
      select: { isActive: true },
    });
    if (!user?.isActive) {
      throw new BadRequestException(`${field} must be an active staff member`);
    }
  }

  private async audit(
    tx: Tx,
    type: StaffAuditEventType,
    actor: AuthenticatedStaff,
    targetUserId: string,
    detail: Prisma.InputJsonObject | null,
  ): Promise<void> {
    await tx.staffAuditEvent.create({
      data: {
        type,
        actorUserId: actor.id,
        targetUserId,
        detail: detail ?? undefined,
      },
    });
  }

  private duplicate(error: unknown): unknown {
    return isUniqueViolation(error)
      ? new ConflictException(
          'A staff member with this email or phone already exists',
        )
      : error;
  }
}

/** 24 URL-safe characters from 18 random bytes: 144 bits, and easy to read out over the phone. */
export function generateTemporaryPassword(): string {
  return randomBytes(18).toString('base64url');
}

function changedFields<T extends string>(
  current: Record<T, unknown>,
  input: Partial<Record<T, unknown>>,
  fields: readonly T[],
): T[] {
  return fields.filter(
    (field) => input[field] !== undefined && input[field] !== current[field],
  );
}

function toDto(user: StaffRow): StaffDto {
  return { ...user, permissions: [...permissionsFor(user.role)] };
}
