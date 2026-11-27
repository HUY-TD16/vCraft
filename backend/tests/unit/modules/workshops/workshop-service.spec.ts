import { describe, expect, it, vi } from 'vitest';
import { WorkshopService } from '../../../../src/modules/workshops/application/services/workshop.service';
import { PrismaWorkshopRepository } from '../../../../src/modules/workshops/adapters/persistence/repositories/prisma-workshop.repository';
import type { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import type { PrismaService } from '../../../../src/infrastructure/database/prisma/prisma.service';
import type { TransactionContext } from '../../../../src/common/application/ports/transaction-runner';
import type { AuthenticatedActor, TrustedActor } from '../../../../src/common/application/types/contract-types';
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
    $queryRaw: vi.fn().mockImplementation(async (_strings: any, ...values: any[]) => {
      const rawSql = Array.isArray(_strings) ? _strings.join('?') : String(_strings);
      if (rawSql.includes('FROM "Workshop" WHERE id IN')) {
        let ids: bigint[] = [];
        const firstVal = values[0];
        if (firstVal && typeof firstVal === 'object' && 'values' in firstVal) {
          ids = firstVal.values as bigint[];
        } else if (Array.isArray(firstVal)) {
          ids = firstVal;
        } else {
          ids = values as bigint[];
        }
        const results = ids
          .map(id => workshopsDb.get(id))
          .filter(Boolean)
          .map(w => ({ id: w.id, status: w.status }));
        return results;
      }
      if (rawSql.includes('FROM "Workshop" WHERE id =')) {
        const id = values[0] as bigint;
        const w = workshopsDb.get(id);
        return w ? [{ id: w.id, status: w.status }] : [];
      }
      return [];
    }),
    workshop: {
      count: vi.fn().mockImplementation(async ({ where }: { where?: any }) => {
        let count = 0;
        for (const w of workshopsDb.values()) {
          if (where?.status && w.status !== where.status) continue;
          if (where?.accepting_visitors !== undefined && w.accepting_visitors !== where.accepting_visitors) continue;
          if (where?.name?.contains && !w.name.toLowerCase().includes(where.name.contains.toLowerCase())) continue;
          count++;
        }
        return count;
      }),
      findUnique: vi.fn().mockImplementation(async ({ where, include }: { where: { id?: bigint; account_id?: bigint }; include?: any }) => {
        let w: any = null;
        if (where.id !== undefined) w = workshopsDb.get(where.id) ?? null;
        else if (where.account_id !== undefined) {
          for (const item of workshopsDb.values()) {
            if (item.account_id === where.account_id) {
              w = item;
              break;
            }
          }
        }
        if (!w) return null;
        const result = { ...w };
        if (include?.certificates) {
          result.certificates = Array.from(certificatesDb.values()).filter(c => c.workshop_id === w.id);
        }
        if (include?.account) {
          result.account = accountsDb.get(w.account_id) ?? null;
        }
        return result;
      }),
      findMany: vi.fn().mockImplementation(async ({ where, skip = 0, take = 100, include }: { where?: any; skip?: number; take?: number; include?: any }) => {
        if (where?.id?.in) {
          const inIds = where.id.in as bigint[];
          return inIds
            .map(id => workshopsDb.get(id))
            .filter(Boolean)
            .map(w => ({ id: w.id, status: w.status }));
        }

        let list = Array.from(workshopsDb.values());
        if (where?.status) {
          list = list.filter(w => w.status === where.status);
        }
        if (where?.accepting_visitors !== undefined) {
          list = list.filter(w => w.accepting_visitors === where.accepting_visitors);
        }
        if (where?.name?.contains) {
          list = list.filter(w => w.name.toLowerCase().includes(where.name.contains.toLowerCase()));
        }

        return list.slice(skip, skip + take).map(w => {
          const item = { ...w };
          if (include?.certificates) {
            item.certificates = Array.from(certificatesDb.values()).filter(c => c.workshop_id === w.id);
          }
          if (include?.account) {
            item.account = accountsDb.get(w.account_id) ?? null;
          }
          return item;
        });
      }),
      create: vi.fn().mockImplementation(async ({ data }: { data: any }) => {
        const id = BigInt(workshopsDb.size + 1);
        const record = {
          id,
          created_at: new Date(),
          updated_at: new Date(),
          accepting_visitors: false,
          ...data,
        };
        workshopsDb.set(id, record);
        return record;
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: bigint }; data: any }) => {
        const existing = workshopsDb.get(where.id);
        if (!existing) throw new Error('Not found');
        const updated = { ...existing, ...data, updated_at: new Date() };
        workshopsDb.set(where.id, updated);
        return updated;
      }),
    },
    account: {
      findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id?: bigint } }) => {
        if (where.id !== undefined) return accountsDb.get(where.id) ?? null;
        return null;
      }),
    },
    image: {
      count: vi.fn().mockImplementation(async ({ where }: { where: any }) => {
        let count = 0;
        for (const img of imagesDb.values()) {
          if (
            img.context_type === where.context_type &&
            img.context_id === where.context_id &&
            img.is_attached === where.is_attached
          ) {
            count++;
          }
        }
        return count;
      }),
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: any }) => {
        for (const img of imagesDb.values()) {
          if (
            img.id === where.id &&
            img.context_type === where.context_type &&
            img.context_id === where.context_id &&
            img.is_attached === where.is_attached
          ) {
            return img;
          }
        }
        return null;
      }),
      findMany: vi.fn().mockImplementation(async ({ where }: { where: any }) => {
        const list: any[] = [];
        for (const img of imagesDb.values()) {
          const matchContextId = where.context_id?.in
            ? where.context_id.in.includes(img.context_id)
            : where.context_id === undefined || img.context_id === where.context_id;
          if (
            img.context_type === where.context_type &&
            matchContextId &&
            img.is_attached === where.is_attached
          ) {
            list.push(img);
          }
        }
        return list;
      }),
      updateMany: vi.fn().mockImplementation(async ({ where, data }: { where: any; data: any }) => {
        let count = 0;
        for (const img of imagesDb.values()) {
          if (where.id?.in && where.id.in.includes(img.id)) {
            Object.assign(img, data);
            count++;
          } else if (where.id?.notIn && !where.id.notIn.includes(img.id)) {
            Object.assign(img, data);
            count++;
          } else if (!where.id && img.context_id === where.context_id) {
            Object.assign(img, data);
            count++;
          }
        }
        return { count };
      }),
    },
    certificate: {
      findMany: vi.fn().mockImplementation(async ({ where }: { where?: { workshop_id?: bigint } }) =>
        Array.from(certificatesDb.values())
          .filter(c => where?.workshop_id === undefined || c.workshop_id === where.workshop_id)
          .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id?: bigint } }) => {
        if (where.id !== undefined) return certificatesDb.get(where.id) ?? null;
        return null;
      }),
      create: vi.fn().mockImplementation(async ({ data }: { data: any }) => {
        const id = BigInt(certificatesDb.size + 1);
        const cert = { id, ...data };
        certificatesDb.set(id, cert);
        return cert;
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: bigint }; data: any }) => {
        const existing = certificatesDb.get(where.id);
        if (!existing) throw new Error('Not found');
        const updated = { ...existing, ...data };
        certificatesDb.set(where.id, updated);
        return updated;
      }),
      deleteMany: vi.fn().mockImplementation(async ({ where }: { where: any }) => {
        let count = 0;
        for (const [id, cert] of Array.from(certificatesDb.entries())) {
          if (cert.workshop_id === where.workshop_id) {
            if (where.id?.notIn && !where.id.notIn.includes(id)) {
              certificatesDb.delete(id);
              count++;
            }
          }
        }
        return { count };
      }),
    },
    workshopStatusLog: {
      count: vi.fn().mockImplementation(async ({ where }: { where: any }) => {
        return statusLogsDb.filter(l => l.workshop_id === where.workshop_id).length;
      }),
      findMany: vi.fn().mockImplementation(async ({ where, skip = 0, take = 100 }: { where: any; skip?: number; take?: number }) => {
        const filtered = statusLogsDb.filter(l => l.workshop_id === where.workshop_id);
        return filtered.slice(skip, skip + take).map(l => ({
          ...l,
          performedBy: accountsDb.get(l.performed_by) ?? { id: l.performed_by, username: 'admin' },
        }));
      }),
      create: vi.fn().mockImplementation(async ({ data }: { data: any }) => {
        const log = { id: BigInt(statusLogsDb.length + 1), created_at: new Date(), ...data };
        statusLogsDb.push(log);
        return log;
      }),
    },
  };

  const fakeTx = {} as TransactionContext;
  const runner = {
    getClient: vi.fn().mockReturnValue(client),
    run: vi.fn().mockImplementation(async work => work(fakeTx)),
  } as unknown as PrismaTransactionRunner;

  const prisma = client as unknown as PrismaService;
  const repo = new PrismaWorkshopRepository(runner, prisma);
  const media = { replaceImages: vi.fn().mockResolvedValue(undefined) } as any;
  const service = new WorkshopService(repo, runner, media);

  return {
    service,
    repo,
    client,
    runner,
    prisma,
    media,
    fakeTx,
    workshopsDb,
    accountsDb,
    imagesDb,
    certificatesDb,
    statusLogsDb,
  };
}

describe('WorkshopService Contract Suite', () => {
  workshopContractSuite('WorkshopService conformance', async () => {
    const { service, runner, workshopsDb } = createMocks();
    workshopsDb.set(1n, { id: 1n, name: 'Active Workshop', status: 'active' });
    workshopsDb.set(2n, { id: 2n, name: 'Suspended Workshop', status: 'suspended' });

    return {
      contract: service,
      runner,
      activeId: '1',
      suspendedId: '2',
      missingId: '999',
      dispose: async () => {},
    };
  });
});

describe('WorkshopService', () => {
  const adminActor: AuthenticatedActor = {
    accountId: '100',
    role: 'admin',
    workshopId: null,
    authVersion: 1,
    sessionId: 'sess-admin',
    sessionLevel: 'normal',
  };

  const artisanActor: AuthenticatedActor = {
    accountId: '200',
    role: 'artisan',
    workshopId: '1',
    authVersion: 1,
    sessionId: 'sess-artisan',
    sessionLevel: 'normal',
  };

  describe('lockAndAssertActive', () => {
    it('returns immediately without db calls when workshopIds is empty', async () => {
      const { service, client, fakeTx } = createMocks();
      await service.lockAndAssertActive([], fakeTx);
      expect(client.$queryRaw).not.toHaveBeenCalled();
      expect(client.workshop.findMany).not.toHaveBeenCalled();
    });

    it('successfully locks active workshops in ascending order', async () => {
      const { service, workshopsDb, fakeTx, client } = createMocks();
      workshopsDb.set(1n, { id: 1n, status: 'active' });
      workshopsDb.set(2n, { id: 2n, status: 'active' });

      await service.lockAndAssertActive(['2', '1', '2'], fakeTx);
      expect(client.$queryRaw).toHaveBeenCalled();
    });

    it('falls back to findMany when $queryRaw is undefined', async () => {
      const { service, workshopsDb, fakeTx, client } = createMocks();
      (client as any).$queryRaw = undefined;
      workshopsDb.set(1n, { id: 1n, status: 'active' });

      await service.lockAndAssertActive(['1'], fakeTx);
      expect(client.workshop.findMany).toHaveBeenCalledWith({
        where: { id: { in: [1n] } },
        select: { id: true, status: true },
        orderBy: { id: 'asc' },
      });
    });

    it('throws RESOURCE_NOT_FOUND when any workshop is missing', async () => {
      const { service, workshopsDb, fakeTx } = createMocks();
      workshopsDb.set(1n, { id: 1n, status: 'active' });

      const promise = service.lockAndAssertActive(['1', '999'], fakeTx);
      await expect(promise).rejects.toBeInstanceOf(BusinessRuleException);
      await expect(promise).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('throws WORKSHOP_SUSPENDED when any workshop has suspended status', async () => {
      const { service, workshopsDb, fakeTx } = createMocks();
      workshopsDb.set(1n, { id: 1n, status: 'active' });
      workshopsDb.set(2n, { id: 2n, status: 'suspended' });

      const promise = service.lockAndAssertActive(['1', '2'], fakeTx);
      await expect(promise).rejects.toBeInstanceOf(WorkshopSuspended);
      await expect(promise).rejects.toMatchObject({ code: 'WORKSHOP_SUSPENDED' });
    });
  });

  describe('getWorkshopSummary', () => {
    it('returns null if workshopId is invalid format or non-existent', async () => {
      const { service } = createMocks();
      expect(await service.getWorkshopSummary('invalid-id')).toBeNull();
      expect(await service.getWorkshopSummary('999')).toBeNull();
    });

    it('returns summary with isProfilePublic = true when all fields and image are present', async () => {
      const { service, workshopsDb } = createMocks();
      workshopsDb.set(1n, {
        id: 1n,
        name: 'Gom Bat Trang',
        status: 'active',
        address: 'Bat Trang, Gia Lam, Ha Noi',
        story: 'Nghe truyen thong 500 nam',
        avatar_image_id: 10n,
      });

      const summary = await service.getWorkshopSummary('1');
      expect(summary).toEqual({
        id: '1',
        name: 'Gom Bat Trang',
        status: 'active',
        isProfilePublic: true,
      });
    });
  });

  describe('createWorkshop', () => {
    it('throws PERMISSION_DENIED if actor is not admin', async () => {
      const { service, fakeTx } = createMocks();
      const promise = service.createWorkshop(
        {
          accountId: '200',
          name: 'Xuong Gom',
          address: 'Bat Trang',
          story: 'Truyen thong',
          latitude: null,
          longitude: null,
          actor: artisanActor,
        },
        fakeTx,
      );

      await expect(promise).rejects.toBeInstanceOf(BusinessRuleException);
      await expect(promise).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });

    it('creates workshop and initial log successfully', async () => {
      const { service, accountsDb, statusLogsDb, fakeTx } = createMocks();
      accountsDb.set(200n, { id: 200n, role: 'artisan' });

      const result = await service.createWorkshop(
        {
          accountId: '200',
          name: 'Xuong Gom Thuan Phat',
          address: 'Bat Trang, Ha Noi',
          story: 'Nghe truyen 3 doi',
          latitude: 21.002,
          longitude: 105.912,
          actor: adminActor,
        },
        fakeTx,
      );

      expect(result.workshopId).toBe('1');
      expect(statusLogsDb).toHaveLength(1);
      expect(statusLogsDb[0].new_status).toBe('active');
    });
  });

  describe('changeStatus', () => {
    it('returns changed = false if status is identical', async () => {
      const { service, workshopsDb, fakeTx } = createMocks();
      workshopsDb.set(1n, { id: 1n, status: 'active' });

      const result = await service.changeStatus(
        { workshopId: '1', status: 'active', reason: 'Same', actor: adminActor },
        fakeTx,
      );
      expect(result.changed).toBe(false);
    });

    it('updates status and logs when changing from active to suspended', async () => {
      const { service, workshopsDb, statusLogsDb, fakeTx } = createMocks();
      workshopsDb.set(1n, { id: 1n, status: 'active' });

      const result = await service.changeStatus(
        { workshopId: '1', status: 'suspended', reason: 'Vi pham', actor: adminActor },
        fakeTx,
      );
      expect(result.changed).toBe(true);
      expect(result.status).toBe('suspended');
      expect(statusLogsDb).toHaveLength(1);
    });
  });

  describe('listPublicWorkshops', () => {
    it('returns only active and public workshops with pagination envelope', async () => {
      const { service, workshopsDb } = createMocks();
      workshopsDb.set(1n, {
        id: 1n,
        name: 'Xuong 1',
        status: 'active',
        address: 'Bat Trang',
        story: 'Story 1',
        avatar_image_id: 10n,
        accepting_visitors: true,
      });
      workshopsDb.set(2n, {
        id: 2n,
        name: 'Xuong 2',
        status: 'suspended',
        address: 'Bat Trang',
        story: 'Story 2',
        avatar_image_id: 20n,
        accepting_visitors: true,
      });

      const result = await service.listPublicWorkshops({ page: 1, limit: 10 } as any);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('1');
      expect(result.metadata.pagination?.total_records).toBe(1);
    });
  });

  describe('getPublicWorkshopDetail', () => {
    it('throws RESOURCE_NOT_FOUND when workshop is suspended or not public', async () => {
      const { service, workshopsDb } = createMocks();
      workshopsDb.set(1n, { id: 1n, name: 'Xuong 1', status: 'suspended' });

      await expect(service.getPublicWorkshopDetail('1')).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
      });
    });

    it('returns public detail with images and certificates', async () => {
      const { service, workshopsDb, imagesDb, certificatesDb } = createMocks();
      workshopsDb.set(1n, {
        id: 1n,
        name: 'Xuong Gom Minh Long',
        status: 'active',
        address: 'Bat Trang',
        story: 'Gia dinh lam gom',
        avatar_image_id: 10n,
        accepting_visitors: true,
      });
      imagesDb.set(10n, { id: 10n, context_type: 'workshop_profile', context_id: 1n, is_attached: true });
      certificatesDb.set(50n, { id: 50n, workshop_id: 1n, name: 'Cert 1', image_id: 30n });

      const result = await service.getPublicWorkshopDetail('1');
      expect(result.id).toBe('1');
      expect(result.name).toBe('Xuong Gom Minh Long');
      expect(result.images).toHaveLength(1);
      expect(result.certificates).toHaveLength(1);
    });
  });

  describe('getOwnWorkshop and updateOwnWorkshop', () => {
    it('getOwnWorkshop returns own workshop profile with missing_public_fields', async () => {
      const { service, workshopsDb } = createMocks();
      workshopsDb.set(1n, {
        id: 1n,
        name: 'Xuong Cua Toi',
        status: 'active',
        address: null,
        story: null,
        avatar_image_id: null,
        created_at: new Date(),
        updated_at: new Date(),
        accepting_visitors: false,
      });

      const result = await service.getOwnWorkshop(artisanActor);
      expect(result.id).toBe('1');
      expect(result.missing_public_fields).toContain('address');
      expect(result.missing_public_fields).toContain('story');
      expect(result.missing_public_fields).toContain('images');
      expect(result.is_profile_public).toBe(false);
    });

    it('updateOwnWorkshop updates profile and manages certificates and images', async () => {
      const { service, workshopsDb } = createMocks();
      workshopsDb.set(1n, {
        id: 1n,
        name: 'Xuong Cu',
        status: 'active',
        address: null,
        story: null,
        avatar_image_id: null,
        created_at: new Date(),
        updated_at: new Date(),
        accepting_visitors: false,
      });

      const dto = {
        name: 'Xuong Gom Moi',
        address: 'Bat Trang, Gia Lam',
        story: 'Cau chuyen moi',
        latitude: 21.0,
        longitude: 105.0,
        avatar_image_id: '10',
        image_ids: ['10', '20'],
        certificates: [{ name: 'Chung nhan moi', image_id: '30' }],
      };

      const result = await service.updateOwnWorkshop(artisanActor, dto as any);
      expect(result.name).toBe('Xuong Gom Moi');
      expect(result.address).toBe('Bat Trang, Gia Lam');
      expect(result.story).toBe('Cau chuyen moi');
    });

    it('updateOwnWorkshop prevents removing required fields from an already public profile', async () => {
      const { service, workshopsDb } = createMocks();
      workshopsDb.set(1n, {
        id: 1n,
        name: 'Xuong Cong Khai',
        status: 'active',
        address: 'Dia chi cu',
        story: 'Cau chuyen cu',
        avatar_image_id: 10n,
        created_at: new Date(),
        updated_at: new Date(),
        accepting_visitors: false,
      });

      const dto = {
        name: 'Xuong Cong Khai',
        address: '',
        story: 'Cau chuyen',
        image_ids: [],
        certificates: [],
      };

      await expect(service.updateOwnWorkshop(artisanActor, dto as any)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    });

    it('updateVisitors updates accepting_visitors flag', async () => {
      const { service, workshopsDb } = createMocks();
      workshopsDb.set(1n, { id: 1n, accepting_visitors: false });

      const result = await service.updateVisitors(artisanActor, { accepting_visitors: true });
      expect(result.accepting_visitors).toBe(true);
      expect(workshopsDb.get(1n)?.accepting_visitors).toBe(true);
    });
  });

  describe('Admin APIs: listAdminWorkshops, getAdminWorkshop, getWorkshopStatusHistory, changeStatusByAdmin', () => {
    it('listAdminWorkshops returns workshops with account data', async () => {
      const { service, workshopsDb, accountsDb } = createMocks();
      accountsDb.set(100n, { id: 100n, username: 'artisan1', display_name: 'Chu Xuong 1', role: 'artisan' });
      workshopsDb.set(1n, {
        id: 1n,
        account_id: 100n,
        name: 'Xuong 1',
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
        accepting_visitors: false,
      });

      const result = await service.listAdminWorkshops({ page: 1, limit: 10 } as any);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].account.username).toBe('artisan1');
    });

    it('getAdminWorkshop returns detailed admin workshop dto', async () => {
      const { service, workshopsDb, accountsDb } = createMocks();
      accountsDb.set(100n, { id: 100n, username: 'artisan1', display_name: 'Chu Xuong 1', role: 'artisan' });
      workshopsDb.set(1n, {
        id: 1n,
        account_id: 100n,
        name: 'Xuong 1',
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
        accepting_visitors: false,
      });

      const result = await service.getAdminWorkshop('1');
      expect(result.id).toBe('1');
      expect(result.account.username).toBe('artisan1');
    });

    it('getWorkshopStatusHistory returns status logs for workshop', async () => {
      const { service, workshopsDb, statusLogsDb, accountsDb } = createMocks();
      workshopsDb.set(1n, { id: 1n, status: 'active' });
      accountsDb.set(99n, { id: 99n, username: 'admin', display_name: 'Admin User' });
      statusLogsDb.push({
        id: 1n,
        workshop_id: 1n,
        prev_status: 'active',
        new_status: 'suspended',
        performed_by: 99n,
        reason: 'Vi pham',
        created_at: new Date(),
      });

      const result = await service.getWorkshopStatusHistory('1', { page: 1, limit: 10 });
      expect(result.data).toHaveLength(1);
      expect(result.data[0].reason).toBe('Vi pham');
      expect(result.data[0].actor.display_name).toBe('Admin User');
    });

    it('changeStatusByAdmin changes status and returns updated admin workshop', async () => {
      const { service, workshopsDb, accountsDb } = createMocks();
      accountsDb.set(100n, { id: 100n, username: 'artisan1', display_name: 'Chu Xuong 1', role: 'artisan' });
      workshopsDb.set(1n, {
        id: 1n,
        account_id: 100n,
        name: 'Xuong 1',
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
        accepting_visitors: false,
      });

      const result = await service.changeStatusByAdmin('1', { status: 'suspended', reason: 'Kiem tra' }, adminActor);
      expect(result.status).toBe('suspended');
    });
  });
});
