import type { ConfigService } from '@nestjs/config';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import type { Env } from '../config/env.validation';
import type { PrismaService } from '../prisma/prisma.service';
import { PoliciesService } from './policies.service';

const actor = { id: 'admin-1' } as AuthenticatedStaff;

function setup(stored = { lockoutWarningLeadHours: 12 }) {
  const row = {
    defaultInstallmentMinor: null,
    defaultFrequency: 'DAILY',
    defaultGraceDays: 1,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    updatedBy: null,
    ...stored,
  };
  const upsert = jest
    .fn()
    .mockImplementation(() => Promise.resolve({ ...row }));
  const update = jest
    .fn()
    .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined && key in row) {
          Object.assign(row, { [key]: value });
        }
      }
      return Promise.resolve({ ...row });
    });
  const recordChange = jest.fn().mockResolvedValue({});
  const tx = {
    fleetPolicy: { update },
    policyChange: { create: recordChange },
  };
  const prisma = {
    fleetPolicy: { upsert },
    $transaction: jest.fn((run: (client: typeof tx) => Promise<unknown>) =>
      run(tx),
    ),
  };
  const config = {
    get: jest.fn(() => 12),
  } as unknown as ConfigService<Env, true>;
  return {
    service: new PoliciesService(prisma as unknown as PrismaService, config),
    upsert,
    update,
    recordChange,
  };
}

describe('PoliciesService', () => {
  it('starts from the environment value the first time it is read', async () => {
    const { service, upsert } = setup();

    await service.get();

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        update: {},
        create: { id: 1, lockoutWarningLeadHours: 12 },
      }),
    );
  });

  // Acceptance: a threshold changed in Settings is what enforcement uses next, with no
  // restart: the cached value is dropped the moment the policy changes.
  it('serves the new lead time straight after a change', async () => {
    const { service } = setup();
    expect(await service.lockoutWarningLeadHours()).toBe(12);

    await service.update({ lockoutWarningLeadHours: 24 }, actor);

    expect(await service.lockoutWarningLeadHours()).toBe(24);
  });

  it('records who changed what, with before and after', async () => {
    const { service, recordChange, update } = setup();

    await service.update(
      { lockoutWarningLeadHours: 24, defaultGraceDays: 1 },
      actor,
    );

    // Grace days were already 1: only the real change is recorded.
    expect(recordChange).toHaveBeenCalledWith({
      data: {
        actorUserId: 'admin-1',
        changes: { lockoutWarningLeadHours: { from: 12, to: 24 } },
      },
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ updatedById: 'admin-1' }) as unknown,
      }),
    );
  });

  it('writes nothing when nothing changed', async () => {
    const { service, recordChange, update } = setup();

    await service.update({ lockoutWarningLeadHours: 12 }, actor);

    expect(recordChange).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('can clear the suggested installment', async () => {
    const { service, recordChange } = setup({
      lockoutWarningLeadHours: 12,
      defaultInstallmentMinor: 4500,
    } as never);

    const policy = await service.update(
      { defaultInstallmentMinor: null },
      actor,
    );

    expect(policy.defaultInstallmentMinor).toBeNull();
    expect(recordChange).toHaveBeenCalledWith({
      data: {
        actorUserId: 'admin-1',
        changes: { defaultInstallmentMinor: { from: 4500, to: null } },
      },
    });
  });
});
