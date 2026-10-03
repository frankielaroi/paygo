import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import type { Env } from '../config/env.validation';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { PolicyDto, UpdatePolicyDto } from './dto/policy.dto';

/** The one policy row. */
const POLICY_ID = 1;

/** How long the lead time is held in memory; the enforcement sweep asks for it constantly. */
const CACHE_MS = 15_000;

const policySelect = {
  lockoutWarningLeadHours: true,
  defaultInstallmentMinor: true,
  defaultFrequency: true,
  defaultGraceDays: true,
  updatedAt: true,
  updatedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.FleetPolicySelect;

const EDITABLE = [
  'lockoutWarningLeadHours',
  'defaultInstallmentMinor',
  'defaultFrequency',
  'defaultGraceDays',
] as const;

/**
 * Fleet-wide policy that admins change at runtime, instead of constants or environment
 * variables that need a deployment.
 *
 * Two kinds of value live here, and they behave differently on purpose:
 *
 * - lockoutWarningLeadHours governs every loan: enforcement reads it on each sweep, so a change
 *   takes effect at the next one with no restart.
 * - the default loan terms are only suggestions for the next loan opened. A loan's own terms
 *   are part of what the rider agreed to and never change underneath them.
 *
 * The row is created on first read from the environment's LOCKOUT_WARNING_LEAD_HOURS, which
 * from then on is only the starting value. Every change is recorded in policy_changes.
 */
@Injectable()
export class PoliciesService {
  /** Per process. With several instances a change reaches the others within CACHE_MS. */
  private leadHours: { readAt: number; value: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async get(): Promise<PolicyDto> {
    return this.prisma.fleetPolicy.upsert({
      where: { id: POLICY_ID },
      update: {},
      create: {
        id: POLICY_ID,
        lockoutWarningLeadHours: this.config.get('LOCKOUT_WARNING_LEAD_HOURS', {
          infer: true,
        }),
      },
      select: policySelect,
    });
  }

  async update(
    input: UpdatePolicyDto,
    actor: AuthenticatedStaff,
  ): Promise<PolicyDto> {
    const current = await this.get();
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of EDITABLE) {
      const next = input[field];
      if (next !== undefined && next !== current[field]) {
        changes[field] = { from: current[field], to: next };
      }
    }
    if (Object.keys(changes).length === 0) {
      return current;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.policyChange.create({
        data: {
          actorUserId: actor.id,
          changes: changes as Prisma.InputJsonValue,
        },
      });
      return tx.fleetPolicy.update({
        where: { id: POLICY_ID },
        data: {
          lockoutWarningLeadHours: input.lockoutWarningLeadHours,
          defaultInstallmentMinor: input.defaultInstallmentMinor,
          defaultFrequency: input.defaultFrequency,
          defaultGraceDays: input.defaultGraceDays,
          updatedById: actor.id,
        },
        select: policySelect,
      });
    });
    this.leadHours = null;
    return updated;
  }

  /** Hours a rider must have been warned before an automatic lock. Read by enforcement. */
  async lockoutWarningLeadHours(): Promise<number> {
    const now = Date.now();
    if (this.leadHours && now - this.leadHours.readAt < CACHE_MS) {
      return this.leadHours.value;
    }
    const { lockoutWarningLeadHours } = await this.get();
    this.leadHours = { readAt: now, value: lockoutWarningLeadHours };
    return lockoutWarningLeadHours;
  }
}
