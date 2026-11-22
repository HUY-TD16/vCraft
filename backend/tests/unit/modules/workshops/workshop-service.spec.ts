import { describe, expect, it, vi } from 'vitest';
import { WorkshopService } from '../../../../src/modules/workshops/application/services/workshop.service';
import type { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import type { PrismaService } from '../../../../src/infrastructure/database/prisma/prisma.service';
import type { TransactionContext } from '../../../../src/common/application/ports/transaction-runner';
import type { TrustedActor } from '../../../../src/common/application/types/contract-types';
import { BusinessRuleException } from '../../../../src/common/domain/errors/business-rule.exception';
import { WorkshopSuspended } from '../../../../src/modules/workshops/domain/errors/workshop-suspended';
import { workshopContractSuite } from '../../../contracts/workshop.contract-suite';

function createMocks() {
  const workshopsDb = new Map<bigint, any>();
  const accountsDb = new Map<bigint, any>();
  const imagesDb = new Map<bigint, any>();
  const certificatesDb = new Map<bigint, any>();
  const statusLogsDb: any[] = [];

  const client = {
    $queryRaw: vi.fn().mockImplementation(async (strings: any, ...values: any[]) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('FROM "Workshop" WHERE id IN')) {
        const ids = (values[0]?.values ?? values[0] ?? values) as bigint[];
        return ids.map(id => workshopsDb.get(id)).filter(Boolean).map(w => ({ id: w.id, status: w.status }));
      }
      if (sql.includes('FROM "Workshop" WHERE id =')) {
        const w = workshopsDb.get(values[0] as bigint);
        return w ? [{ id: w.id, status: w.status }] : [];
      }
      return [];
    }),
    workshop: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.id !== undefined) return workshopsDb.get(where.id) ?? null;
        return Array.from(workshopsDb.values()).find(w => w.account_id === where.account_id) ?? null;
      }),
      findMany: vi.fn().mockImplementation(async ({ where }: any) => {
        return (where?.id?.in ?? []).map((id: bigint) => workshopsDb.get(id)).filter(Boolean).map((w: any) => ({ id: w.id, status: w.status }));
      }),
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        const record = { id: BigInt(workshopsDb.size + 1), ...data };
        workshopsDb.set(record.id, record);
        return record;
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const existing = workshopsDb.get(where.id);
        const updated = { ...existing, ...data };
        workshopsDb.set(where.id, updated);
        return updated;
      }),
    },
    account: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => accountsDb.get(where.id) ?? null),
    },
    image: {
      count: vi.fn().mockImplementation(async ({ where }: any) => {
        return Array.from(imagesDb.values()).filter(
          img => img.context_type === where.context_type && img.context_id === where.context_id && img.is_attached === where.is_attached,
        ).length;
      }),
      findFirst: vi.fn().mockImplementation(async ({ where }: any) => {
        return Array.from(imagesDb.values()).find(
          img => img.id === where.id && img.context_type === where.context_type && img.context_id === where.context_id && img.is_attached === where.is_attached,
        ) ?? null;
      }),
    },
    certificate: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => certificatesDb.get(where.id) ?? null),
    },
    workshopStatusLog: {
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        const log = { id: BigInt(statusLogsDb.length + 1), ...data };
        statusLogsDb.push(log);
        return log;
      }),
    },
  };

  const fakeTx = {} as TransactionContext;
  const runner = {
    getClient: vi.fn().mockReturnValue(client),
    run: vi.fn().mockImplementation(work => work(fakeTx)),
  } as unknown as PrismaTransactionRunner;

  const service = new WorkshopService(runner, client as unknown as PrismaService);
  return { service, client, runner, fakeTx, workshopsDb, accountsDb, imagesDb, certificatesDb, statusLogsDb };
}

const adminActor: TrustedActor = { accountId: '99', role: 'admin', workshopId: null, authVersion: 1, sessionId: 's1' };
const artisanActor: TrustedActor = { accountId: '10', role: 'artisan', workshopId: '1', authVersion: 1, sessionId: 's2' };
const otherArtisanActor: TrustedActor = { accountId: '11', role: 'artisan', workshopId: '2', authVersion: 1, sessionId: 's3' };

describe('WorkshopService Contract Suite', () => {
  workshopContractSuite('WorkshopService complies with IWorkshopContract', async () => {
    const { service, runner, workshopsDb } = createMocks();
    workshopsDb.set(100n, { id: 100n, status: 'active' });
    workshopsDb.set(101n, { id: 101n, status: 'suspended' });
    return {
      contract: service,
      runner,
      activeId: '100',
      suspendedId: '101',
      missingId: '999',
      dispose: async () => {},
    };
  });
});

describe('WorkshopService', () => {
  describe('lockAndAssertActive', () => {
    it('returns immediately without db calls when workshopIds is empty', async () => {
      const { service, runner, client } = createMocks();
      await runner.run(tx => service.lockAndAssertActive([], tx));
      expect(client.$queryRaw).not.toHaveBeenCalled();
    });

    it('successfully locks active workshops in ascending order', async () => {
      const { service, runner, workshopsDb } = createMocks();
      workshopsDb.set(2n, { id: 2n, status: 'active' });
      workshopsDb.set(1n, { id: 1n, status: 'active' });
      await expect(runner.run(tx => service.lockAndAssertActive(['2', '1', '2'], tx))).resolves.toBeUndefined();
    });

    it('falls back to findMany when $queryRaw is undefined', async () => {
      const { service, runner, client, workshopsDb } = createMocks();
      delete (client as any).$queryRaw;
      workshopsDb.set(1n, { id: 1n, status: 'active' });
      await expect(runner.run(tx => service.lockAndAssertActive(['1'], tx))).resolves.toBeUndefined();
      expect(client.workshop.findMany).toHaveBeenCalled();
    });

    it('throws RESOURCE_NOT_FOUND when any workshop is missing', async () => {
      const { service, runner, workshopsDb } = createMocks();
      workshopsDb.set(1n, { id: 1n, status: 'active' });
      await expect(runner.run(tx => service.lockAndAssertActive(['1', '2'], tx))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('throws WORKSHOP_SUSPENDED when any workshop has suspended status', async () => {
      const { service, runner, workshopsDb } = createMocks();
      workshopsDb.set(1n, { id: 1n, status: 'active' });
      workshopsDb.set(2n, { id: 2n, status: 'suspended' });
      await expect(runner.run(tx => service.lockAndAssertActive(['1', '2'], tx))).rejects.toBeInstanceOf(WorkshopSuspended);
    });

    it('throws RESOURCE_NOT_FOUND if one is missing even if another is suspended', async () => {
      const { service, runner, workshopsDb } = createMocks();
      workshopsDb.set(1n, { id: 1n, status: 'suspended' });
      await expect(runner.run(tx => service.lockAndAssertActive(['1', '999'], tx))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('throws INVALID_INPUT for non-numeric workshop ID', async () => {
      const { service, runner } = createMocks();
      await expect(runner.run(tx => service.lockAndAssertActive(['abc'], tx))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
  });

  describe('getWorkshopSummary', () => {
    it('returns null if workshopId is invalid format or not found', async () => {
      const { service } = createMocks();
      expect(await service.getWorkshopSummary('abc')).toBeNull();
      expect(await service.getWorkshopSummary('999')).toBeNull();
    });

    it('returns summary with isProfilePublic = true when all fields and avatar image are present', async () => {
      const { service, workshopsDb } = createMocks();
      workshopsDb.set(1n, { id: 1n, name: 'Gốm Chu Đậu', status: 'active', address: 'Hải Dương', story: 'Gốm cổ', avatar_image_id: 10n });
      const res = await service.getWorkshopSummary('1');
      expect(res).toEqual({ id: '1', name: 'Gốm Chu Đậu', status: 'active', isProfilePublic: true });
    });

    it('returns isProfilePublic = true when avatar is null but attached profile image exists', async () => {
      const { service, workshopsDb, imagesDb } = createMocks();
      workshopsDb.set(1n, { id: 1n, name: 'Gốm Chu Đậu', status: 'active', address: 'Hải Dương', story: 'Gốm cổ', avatar_image_id: null });
      imagesDb.set(100n, { id: 100n, context_type: 'workshop_profile', context_id: 1n, is_attached: true });
      const res = await service.getWorkshopSummary('1');
      expect(res?.isProfilePublic).toBe(true);
    });

    it.each([
      ['no image', { avatar_image_id: null }],
      ['empty address', { address: '   ' }],
      ['empty story', { story: '' }],
      ['status suspended', { status: 'suspended' }],
    ])('returns isProfilePublic = false when %s', async (_, override) => {
      const { service, workshopsDb } = createMocks();
      workshopsDb.set(1n, { id: 1n, name: 'Gốm Chu Đậu', status: 'active', address: 'Hải Dương', story: 'Gốm cổ', avatar_image_id: 10n, ...override });
      const res = await service.getWorkshopSummary('1');
      expect(res?.isProfilePublic).toBe(false);
    });
  });

  describe('createWorkshop', () => {
    const validPayload = {
      accountId: '1',
      name: 'Gốm Bát Tràng',
      address: 'Hà Nội',
      story: 'Làng gốm',
      latitude: 21.0,
      longitude: 105.8,
      actor: adminActor,
    };

    it('creates workshop and initial WorkshopStatusLog when input is valid', async () => {
      const { service, runner, accountsDb, statusLogsDb } = createMocks();
      accountsDb.set(1n, { id: 1n, role: 'artisan' });
      const res = await runner.run(tx => service.createWorkshop(validPayload, tx));
      expect(res).toEqual({ workshopId: '1' });
      expect(statusLogsDb).toHaveLength(1);
      expect(statusLogsDb[0].new_status).toBe('active');
    });

    it('throws PERMISSION_DENIED if actor is not admin', async () => {
      const { service, runner } = createMocks();
      await expect(runner.run(tx => service.createWorkshop({ ...validPayload, actor: artisanActor }, tx))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });

    it.each([
      ['name is empty', { name: '   ' }],
      ['name > 200 chars', { name: 'a'.repeat(201) }],
      ['address > 500 chars', { address: 'a'.repeat(501) }],
      ['lat without lng', { latitude: 10, longitude: null }],
      ['lng without lat', { latitude: null, longitude: 10 }],
      ['lat out of bounds', { latitude: 95, longitude: 100 }],
      ['lng out of bounds', { latitude: 20, longitude: 200 }],
      ['account not found', { accountId: '999' }],
    ])('throws INVALID_INPUT when %s', async (_, override) => {
      const { service, runner, accountsDb } = createMocks();
      accountsDb.set(1n, { id: 1n, role: 'artisan' });
      await expect(runner.run(tx => service.createWorkshop({ ...validPayload, ...override }, tx))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('throws INVALID_INPUT if account is not artisan or already has a workshop', async () => {
      const { service, runner, accountsDb, workshopsDb } = createMocks();
      accountsDb.set(1n, { id: 1n, role: 'buyer' });
      await expect(runner.run(tx => service.createWorkshop(validPayload, tx))).rejects.toMatchObject({ code: 'INVALID_INPUT' });

      accountsDb.set(1n, { id: 1n, role: 'artisan' });
      workshopsDb.set(10n, { id: 10n, account_id: 1n });
      await expect(runner.run(tx => service.createWorkshop(validPayload, tx))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
  });

  describe('changeStatus', () => {
    it('throws PERMISSION_DENIED if actor is not admin', async () => {
      const { service, runner } = createMocks();
      await expect(runner.run(tx => service.changeStatus({ workshopId: '1', status: 'suspended', reason: 'vi phạm', actor: artisanActor }, tx))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });

    it.each([
      ['status is invalid', { status: 'invalid_status' as any }],
      ['reason is empty', { reason: '   ' }],
      ['workshop not found', { workshopId: '999' }],
    ])('throws expected error when %s', async (_, override) => {
      const { service, runner, workshopsDb } = createMocks();
      workshopsDb.set(1n, { id: 1n, status: 'active' });
      await expect(runner.run(tx => service.changeStatus({ workshopId: '1', status: 'suspended', reason: 'Lý do', actor: adminActor, ...override }, tx))).rejects.toBeInstanceOf(BusinessRuleException);
    });

    it('returns changed = false and does not log if status is identical', async () => {
      const { service, runner, workshopsDb, statusLogsDb } = createMocks();
      workshopsDb.set(1n, { id: 1n, status: 'active' });
      const res = await runner.run(tx => service.changeStatus({ workshopId: '1', status: 'active', reason: 'Không đổi', actor: adminActor }, tx));
      expect(res).toEqual({ workshopId: '1', status: 'active', changed: false });
      expect(statusLogsDb).toHaveLength(0);
    });

    it('updates status and logs when changing status', async () => {
      const { service, runner, workshopsDb, statusLogsDb } = createMocks();
      workshopsDb.set(1n, { id: 1n, status: 'active' });
      const res = await runner.run(tx => service.changeStatus({ workshopId: '1', status: 'suspended', reason: 'Tạm đình chỉ', actor: adminActor }, tx));
      expect(res).toEqual({ workshopId: '1', status: 'suspended', changed: true });
      expect(workshopsDb.get(1n).status).toBe('suspended');
      expect(statusLogsDb[0]).toMatchObject({ prev_status: 'active', new_status: 'suspended' });
    });

    it('falls back to findUnique when $queryRaw is undefined', async () => {
      const { service, runner, client, workshopsDb } = createMocks();
      delete (client as any).$queryRaw;
      workshopsDb.set(1n, { id: 1n, status: 'active' });
      const res = await runner.run(tx => service.changeStatus({ workshopId: '1', status: 'suspended', reason: 'Lý do', actor: adminActor }, tx));
      expect(res.changed).toBe(true);
      expect(client.workshop.findUnique).toHaveBeenCalled();
    });
  });

  describe('getProfileImageAccess', () => {
    it('returns canRead = false if workshop not found or invalid id', async () => {
      const { service, runner } = createMocks();
      expect(await runner.run(tx => service.getProfileImageAccess({ workshopId: '999', imageId: '1', certificateId: null, actorOrNull: null }, tx))).toEqual({ canRead: false });
      expect(await runner.run(tx => service.getProfileImageAccess({ workshopId: 'abc', imageId: '1', certificateId: null, actorOrNull: null }, tx))).toEqual({ canRead: false });
    });

    describe('Certificate Image Access', () => {
      it('returns canRead = false if certificate does not match workshop/image', async () => {
        const { service, runner, workshopsDb, certificatesDb } = createMocks();
        workshopsDb.set(1n, { id: 1n, status: 'active', name: 'W', address: 'A', story: 'S', avatar_image_id: 10n });
        certificatesDb.set(5n, { id: 5n, workshop_id: 2n, image_id: 10n });
        const res = await runner.run(tx => service.getProfileImageAccess({ workshopId: '1', imageId: '10', certificateId: '5', actorOrNull: null }, tx));
        expect(res).toEqual({ canRead: false });
      });

      it.each([
        ['guest when profile is public', true, null, true],
        ['guest when profile is private', false, null, false],
        ['admin when profile is private', false, adminActor, true],
        ['owner artisan when profile is private', false, artisanActor, true],
        ['other artisan when profile is private', false, otherArtisanActor, false],
      ])('%s -> canRead: %s', async (_, isPublic, actor, expectedCanRead) => {
        const { service, runner, workshopsDb, certificatesDb } = createMocks();
        workshopsDb.set(1n, { id: 1n, status: isPublic ? 'active' : 'suspended', name: 'W', address: 'A', story: 'S', avatar_image_id: 10n });
        certificatesDb.set(5n, { id: 5n, workshop_id: 1n, image_id: 20n });
        const res = await runner.run(tx => service.getProfileImageAccess({ workshopId: '1', imageId: '20', certificateId: '5', actorOrNull: actor }, tx));
        expect(res.canRead).toBe(expectedCanRead);
      });
    });

    describe('Workshop Profile Image Access', () => {
      it('returns canRead = false if image is neither avatar nor attached', async () => {
        const { service, runner, workshopsDb } = createMocks();
        workshopsDb.set(1n, { id: 1n, status: 'active', name: 'W', address: 'A', story: 'S', avatar_image_id: 10n });
        const res = await runner.run(tx => service.getProfileImageAccess({ workshopId: '1', imageId: '99', certificateId: null, actorOrNull: null }, tx));
        expect(res).toEqual({ canRead: false });
      });

      it.each([
        ['avatar when profile is public', 10n, false, null, true],
        ['attached gallery when public', 99n, true, null, true],
        ['guest when profile is private', 10n, false, null, false],
        ['admin when profile is private', 10n, false, adminActor, true],
        ['owner artisan when profile is private', 10n, false, artisanActor, true],
      ])('%s -> canRead: %s', async (_, targetImageId, isGallery, actor, expectedCanRead) => {
        const { service, runner, workshopsDb, imagesDb } = createMocks();
        workshopsDb.set(1n, { id: 1n, status: expectedCanRead && actor === null ? 'active' : 'suspended', name: 'W', address: 'A', story: 'S', avatar_image_id: 10n });
        if (isGallery) {
          imagesDb.set(targetImageId, { id: targetImageId, context_type: 'workshop_profile', context_id: 1n, is_attached: true });
        }
        const res = await runner.run(tx => service.getProfileImageAccess({ workshopId: '1', imageId: String(targetImageId), certificateId: null, actorOrNull: actor }, tx));
        expect(res.canRead).toBe(expectedCanRead);
      });
    });
  });
});
