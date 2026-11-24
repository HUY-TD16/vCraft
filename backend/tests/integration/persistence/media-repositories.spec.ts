import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '../../../src/common/application/errors/service-unavailable.exception';
import type { TransactionContext, TransactionRunner } from '../../../src/common/application/ports/transaction-runner';
import type { TrustedActor } from '../../../src/common/application/types/contract-types';
import { BusinessRuleException } from '../../../src/common/domain/errors/business-rule.exception';
import type { PrismaService } from '../../../src/infrastructure/database/prisma/prisma.service';
import type { PrismaTransactionRunner } from '../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import { ReservationCleanupService } from '../../../src/modules/media/application/services/reservation-cleanup.service';
import { UploadImageUseCase } from '../../../src/modules/media/application/use-cases/uploads/upload-image.use-case';
import { QUOTA_LIMIT_BYTES, UPLOAD_LIMITS } from '../../../src/modules/media/domain/value-objects/image-limits';
import { FakeCapacity, FakeProcessor, InMemoryStorage } from '../../support/fakes/media-in-memory';

const testUrl = process.env.VCRAFT_TEST_DATABASE_URL;
const BUDGET = UPLOAD_LIMITS.reservationBudgetBytes;
const MIB = BigInt(1024 * 1024);

describe.skipIf(!testUrl)('Media repositories on a migrated PostgreSQL test schema', () => {
  let db: PrismaService;
  let pg: PrismaTransactionRunner;
  let runner: TransactionRunner;
  let quotas: import('../../../src/modules/media/adapters/persistence/repositories/prisma-storage-quota.repository').PrismaStorageQuotaRepository;
  let scopes: import('../../../src/modules/media/adapters/persistence/repositories/prisma-upload-scope.repository').PrismaUploadScopeRepository;
  let reservations: import('../../../src/modules/media/adapters/persistence/repositories/prisma-upload-reservation.repository').PrismaUploadReservationRepository;
  let images: import('../../../src/modules/media/adapters/persistence/repositories/prisma-image.repository').PrismaImageRepository;

  const created = { accounts: [] as bigint[], workshops: [] as bigint[], scopes: [] as string[] };

  /** Truy vấn thô không theo tham số `schema` của adapter, nên mỗi giao dịch phải đặt search_path (cách quote-request.spec đang làm). */
  class SchemaScopedRunner implements TransactionRunner {
    constructor(private readonly inner: PrismaTransactionRunner, private readonly schema: string) {}
    run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return this.inner.run(async (tx) => {
        await this.inner.getClient(tx).$queryRaw`SELECT set_config('search_path', quote_ident(${this.schema}::text), true)`;
        return work(tx);
      });
    }
  }

  async function newAccount(role: 'artisan' | 'admin') {
    const account = await db.account.create({ data: { username: randomUUID().replaceAll('-', '').slice(0, 30), password_hash: 'x', role } });
    created.accounts.push(account.id);
    return account;
  }
  async function newWorkshop() {
    const account = await newAccount('artisan');
    const workshop = await db.workshop.create({ data: { account_id: account.id, name: 'Xưởng thử' } });
    created.workshops.push(workshop.id);
    return { account, workshop };
  }
  async function newScope(adminId: bigint, expiresInMs = 3_600_000) {
    const scope = await db.initialWorkshopUploadScope.create({ data: { created_by: adminId, expires_at: new Date(Date.now() + expiresInMs) } });
    created.scopes.push(scope.initial_workshop_key);
    await db.storageQuota.create({ data: { initial_workshop_key: scope.initial_workshop_key, limit_bytes: QUOTA_LIMIT_BYTES.initialScope } });
    return scope;
  }
  const actorOf = (accountId: bigint, workshopId: bigint, role: 'artisan' | 'admin' = 'artisan'): TrustedActor =>
    ({ accountId: accountId.toString(), role, workshopId: role === 'artisan' ? workshopId.toString() : null, authVersion: 1, sessionId: 's' });

  beforeAll(async () => {
    const { PrismaService } = await import('../../../src/infrastructure/database/prisma/prisma.service');
    const { PrismaTransactionRunner } = await import('../../../src/infrastructure/database/transactions/prisma-transaction-runner');
    const repos = await import('../../../src/modules/media/adapters/persistence/repositories/prisma-storage-quota.repository');
    const scopeRepo = await import('../../../src/modules/media/adapters/persistence/repositories/prisma-upload-scope.repository');
    const reservationRepo = await import('../../../src/modules/media/adapters/persistence/repositories/prisma-upload-reservation.repository');
    const imageRepo = await import('../../../src/modules/media/adapters/persistence/repositories/prisma-image.repository');
    db = new PrismaService({ DATABASE_URL: testUrl! });
    pg = new PrismaTransactionRunner(db);
    runner = new SchemaScopedRunner(pg, new URL(testUrl!).searchParams.get('schema')!);
    quotas = new repos.PrismaStorageQuotaRepository(pg);
    scopes = new scopeRepo.PrismaUploadScopeRepository(pg);
    reservations = new reservationRepo.PrismaUploadReservationRepository(pg);
    images = new imageRepo.PrismaImageRepository(pg);
  });

  afterAll(async () => {
    if (!db) return;
    const accounts = { in: created.accounts };
    await db.image.deleteMany({ where: { uploaded_by: accounts } });
    await db.uploadReservation.deleteMany({ where: { uploaded_by: accounts } });
    await db.storageQuota.deleteMany({ where: { OR: [{ workshop_id: { in: created.workshops } }, { initial_workshop_key: { in: created.scopes } }] } });
    await db.initialWorkshopUploadScope.deleteMany({ where: { initial_workshop_key: { in: created.scopes } } });
    await db.workshop.deleteMany({ where: { id: { in: created.workshops } } });
    await db.account.deleteMany({ where: { id: accounts } });
    await db.$disconnect();
  });

  describe('StorageQuota', () => {
    it('tạo quota hộ ở lần đầu, các lần sau dùng lại đúng dòng đó và không đổi hạn mức', async () => {
      const { workshop } = await newWorkshop();
      const first = await runner.run(tx => quotas.lockOrCreateWorkshopQuota(workshop.id.toString(), QUOTA_LIMIT_BYTES.workshop, tx));
      const second = await runner.run(tx => quotas.lockOrCreateWorkshopQuota(workshop.id.toString(), BigInt(1), tx));
      expect(second.id).toBe(first.id);
      expect(first.state).toEqual({ limitBytes: QUOTA_LIMIT_BYTES.workshop, usedBytes: BigInt(0), reservedBytes: BigInt(0) });
      expect(second.state.limitBytes).toBe(QUOTA_LIMIT_BYTES.workshop);
      expect(await db.storageQuota.count({ where: { workshop_id: workshop.id } })).toBe(1);
    });

    it('nhiều giao dịch cùng tạo quota lần đầu chỉ ra một dòng', async () => {
      const { workshop } = await newWorkshop();
      const results = await Promise.all(Array.from({ length: 6 }, () =>
        runner.run(tx => quotas.lockOrCreateWorkshopQuota(workshop.id.toString(), QUOTA_LIMIT_BYTES.workshop, tx))));
      expect(new Set(results.map(r => r.id)).size).toBe(1);
      expect(await db.storageQuota.count({ where: { workshop_id: workshop.id } })).toBe(1);
    });

    it('save ghi used/reserved; lockById và lockScopeQuota đọc lại đúng, id lạ trả null', async () => {
      const { workshop } = await newWorkshop();
      const quota = await runner.run(async (tx) => {
        const q = await quotas.lockOrCreateWorkshopQuota(workshop.id.toString(), QUOTA_LIMIT_BYTES.workshop, tx);
        await quotas.save({ id: q.id, state: { ...q.state, usedBytes: BigInt(5), reservedBytes: BigInt(7) } }, tx);
        return q;
      });
      const reread = await runner.run(tx => quotas.lockById(quota.id, tx));
      expect(reread!.state).toMatchObject({ usedBytes: BigInt(5), reservedBytes: BigInt(7) });
      expect(await runner.run(tx => quotas.lockById('999999999', tx))).toBeNull();
      expect(await runner.run(tx => quotas.lockScopeQuota(randomUUID(), tx))).toBeNull();
      expect(await runner.run(tx => quotas.lockScopeQuota('không-phải-uuid', tx))).toBeNull();
    });

    /** Hai giao dịch xin cùng một khóa: B chỉ được khóa SAU KHI A kết thúc. */
    async function expectExclusive(acquire: (tx: TransactionContext) => Promise<unknown>) {
      const events: string[] = [];
      const holder = runner.run(async (tx) => {
        await acquire(tx);
        events.push('A giữ');
        await sleep(300);
        events.push('A nhả');
      });
      await sleep(100);
      const waiter = runner.run(async (tx) => {
        events.push('B xin');
        await acquire(tx);
        events.push('B được');
      });
      await Promise.all([holder, waiter]);
      expect(events).toEqual(['A giữ', 'B xin', 'A nhả', 'B được']);
    }

    it('lockById khóa độc quyền dòng quota', async () => {
      const { workshop } = await newWorkshop();
      const quota = await runner.run(tx => quotas.lockOrCreateWorkshopQuota(workshop.id.toString(), QUOTA_LIMIT_BYTES.workshop, tx));
      await expectExclusive(tx => quotas.lockById(quota.id, tx));
    });

    it('lockOrCreateWorkshopQuota khóa độc quyền dòng quota của hộ', async () => {
      const { workshop } = await newWorkshop();
      await runner.run(tx => quotas.lockOrCreateWorkshopQuota(workshop.id.toString(), QUOTA_LIMIT_BYTES.workshop, tx));
      await expectExclusive(tx => quotas.lockOrCreateWorkshopQuota(workshop.id.toString(), QUOTA_LIMIT_BYTES.workshop, tx));
    });

    it('lockScopeQuota khóa độc quyền dòng quota của phạm vi', async () => {
      const admin = await newAccount('admin');
      const scope = await newScope(admin.id);
      await expectExclusive(tx => quotas.lockScopeQuota(scope.initial_workshop_key, tx));
    });

    it('khóa kho (advisory) tuần tự hóa các giao dịch và tự nhả khi giao dịch kết thúc, kể cả khi lỗi', async () => {
      const events: string[] = [];
      const failing = runner.run(async (tx) => {
        await quotas.lockStorageBudget(tx);
        events.push('A giữ');
        await sleep(300);
        events.push('A lỗi');
        throw new Error('A lỗi');
      }).catch(() => undefined);
      await sleep(80);
      const waiter = runner.run(async (tx) => {
        events.push('B xin');
        await quotas.lockStorageBudget(tx);
        events.push('B được');
      });
      await Promise.all([failing, waiter]);
      expect(events).toEqual(['A giữ', 'B xin', 'A lỗi', 'B được']);
    });

    it('sumReservedBytes cộng mọi quota; sumInitialScopeBytes chỉ cộng phạm vi của đúng Admin', async () => {
      const adminA = await newAccount('admin');
      const adminB = await newAccount('admin');
      const scopeA1 = await newScope(adminA.id);
      const scopeA2 = await newScope(adminA.id);
      const scopeB = await newScope(adminB.id);
      const set = async (key: string, used: number, reserved: number) => runner.run(async (tx) => {
        const q = await quotas.lockScopeQuota(key, tx);
        await quotas.save({ id: q!.id, state: { ...q!.state, usedBytes: BigInt(used), reservedBytes: BigInt(reserved) } }, tx);
      });
      const before = await runner.run(tx => quotas.sumReservedBytes(tx));
      await set(scopeA1.initial_workshop_key, 100, 10);
      await set(scopeA2.initial_workshop_key, 200, 20);
      await set(scopeB.initial_workshop_key, 999, 99);
      expect(await runner.run(tx => quotas.sumInitialScopeBytes(adminA.id.toString(), tx))).toBe(BigInt(330));
      expect(await runner.run(tx => quotas.sumInitialScopeBytes(adminB.id.toString(), tx))).toBe(BigInt(1098));
      expect(await runner.run(tx => quotas.sumReservedBytes(tx))).toBe(before + BigInt(10 + 20 + 99));
    });

    it('ràng buộc CHECK của DB chặn trạng thái sai (used + reserved > limit)', async () => {
      const { workshop } = await newWorkshop();
      await expect(runner.run(async (tx) => {
        const q = await quotas.lockOrCreateWorkshopQuota(workshop.id.toString(), BigInt(100), tx);
        await quotas.save({ id: q.id, state: { limitBytes: BigInt(100), usedBytes: BigInt(80), reservedBytes: BigInt(30) } }, tx);
      })).rejects.toThrow(/violates check constraint/i);
    });
  });

  describe('UploadScope', () => {
    it('lockByKey đọc đủ trường; khóa lạ hoặc sai định dạng trả null', async () => {
      const admin = await newAccount('admin');
      const scope = await newScope(admin.id);
      const found = await runner.run(tx => scopes.lockByKey(scope.initial_workshop_key, tx));
      expect(found).toMatchObject({ initialWorkshopKey: scope.initial_workshop_key, createdBy: admin.id.toString(), status: 'open' });
      expect(found!.expiresAt).toBeInstanceOf(Date);
      expect(await runner.run(tx => scopes.lockByKey(randomUUID(), tx))).toBeNull();
      expect(await runner.run(tx => scopes.lockByKey("x'; DROP TABLE \"Account\"; --", tx))).toBeNull();
    });
  });

  describe('Khóa hàng của scope và reservation', () => {
    async function expectExclusive(acquire: (tx: TransactionContext) => Promise<unknown>) {
      const events: string[] = [];
      const holder = runner.run(async (tx) => { await acquire(tx); events.push('A giữ'); await sleep(300); events.push('A nhả'); });
      await sleep(100);
      const waiter = runner.run(async (tx) => { events.push('B xin'); await acquire(tx); events.push('B được'); });
      await Promise.all([holder, waiter]);
      expect(events).toEqual(['A giữ', 'B xin', 'A nhả', 'B được']);
    }

    it('scopes.lockByKey khóa độc quyền dòng scope', async () => {
      const admin = await newAccount('admin');
      const scope = await newScope(admin.id);
      await expectExclusive(tx => scopes.lockByKey(scope.initial_workshop_key, tx));
    });

    it('reservations.lockById khóa độc quyền dòng reservation', async () => {
      const { account, workshop } = await newWorkshop();
      const reservation = await runner.run(async (tx) => {
        const quota = await quotas.lockOrCreateWorkshopQuota(workshop.id.toString(), QUOTA_LIMIT_BYTES.workshop, tx);
        return reservations.create({
          quotaId: quota.id, uploadedBy: account.id.toString(), contextType: 'product', contextId: null,
          budgetBytes: BUDGET, storagePrefix: `w${workshop.id}/${randomUUID()}/`, expiresAt: new Date(Date.now() + 60_000),
        }, tx);
      });
      await expectExclusive(tx => reservations.lockById(reservation.id, tx));
    });
  });

  describe('UploadReservation và Image', () => {
    it('databaseNow là giờ thực của DB, gần giờ máy', async () => {
      const now = await runner.run(tx => reservations.databaseNow(tx));
      expect(Math.abs(now.getTime() - Date.now())).toBeLessThan(5_000);
    });

    it('tạo, đọc, khóa và đổi trạng thái reservation; tạo Image đúng trường', async () => {
      const { account, workshop } = await newWorkshop();
      const expiresAt = new Date(Date.now() + 30_000);
      const result = await runner.run(async (tx) => {
        const quota = await quotas.lockOrCreateWorkshopQuota(workshop.id.toString(), QUOTA_LIMIT_BYTES.workshop, tx);
        const reservation = await reservations.create({
          quotaId: quota.id, uploadedBy: account.id.toString(), contextType: 'product', contextId: null,
          budgetBytes: BUDGET, storagePrefix: `w${workshop.id}/${randomUUID()}/`, expiresAt,
        }, tx);
        return { quota, reservation };
      });
      expect(result.reservation.state).toMatchObject({ status: 'reserved', budgetBytes: BUDGET, actualBytes: null });
      expect(result.reservation.state.expiresAt.getTime()).toBe(expiresAt.getTime());

      const locked = await runner.run(tx => reservations.lockById(result.reservation.id, tx));
      expect(locked).toEqual(result.reservation);
      expect(await runner.run(tx => reservations.lockById('999999999', tx))).toBeNull();
      expect(await runner.run(tx => reservations.findById('999999999', tx))).toBeNull();

      const image = await runner.run(async (tx) => {
        await reservations.saveState(result.reservation.id, { ...result.reservation.state, status: 'committed', actualBytes: BigInt(1234) }, tx);
        return images.create({
          uploadedBy: account.id.toString(), contextType: 'product', contextId: null,
          thumbnailKey: `${result.reservation.storagePrefix}thumbnail.webp`, displayKey: `${result.reservation.storagePrefix}display.webp`,
          thumbnailSizeBytes: BigInt(234), displaySizeBytes: BigInt(1000), quotaId: result.quota.id,
          reservationId: result.reservation.id, width: 800, height: 600, unreferencedAt: new Date(),
        }, tx);
      });
      expect(image).toMatchObject({ contextType: 'product', contextId: null, width: 800, height: 600, thumbnailSizeBytes: BigInt(234) });
      const reread = await db.uploadReservation.findUnique({ where: { id: BigInt(result.reservation.id) } });
      expect(reread).toMatchObject({ status: 'committed', actual_bytes: BigInt(1234) });
      const row = await db.image.findUnique({ where: { id: BigInt(image.id) } });
      expect(row).toMatchObject({ storage_key: null, original_size_bytes: 0, storage_state: 'ready', is_attached: false });
    });

    it('CHECK của DB chặn actual_bytes vượt budget', async () => {
      const { account, workshop } = await newWorkshop();
      await expect(runner.run(async (tx) => {
        const quota = await quotas.lockOrCreateWorkshopQuota(workshop.id.toString(), QUOTA_LIMIT_BYTES.workshop, tx);
        const r = await reservations.create({
          quotaId: quota.id, uploadedBy: account.id.toString(), contextType: 'journal_entry', contextId: null,
          budgetBytes: BigInt(10), storagePrefix: `w${workshop.id}/${randomUUID()}/`, expiresAt: new Date(Date.now() + 1000),
        }, tx);
        await reservations.saveState(r.id, { ...r.state, status: 'committed', actualBytes: BigInt(11) }, tx);
      })).rejects.toThrow(/violates check constraint/i);
    });
  });

  describe('UploadImageUseCase trên PostgreSQL thật', () => {
    function build(over: { processor?: FakeProcessor; storage?: InMemoryStorage } = {}) {
      const processor = over.processor ?? new FakeProcessor();
      const storage = over.storage ?? new InMemoryStorage();
      const cleanup = new ReservationCleanupService({ txRunner: runner, quotas, reservations, storage });
      const useCase = new UploadImageUseCase({
        txRunner: runner, quotas, scopes, reservations, images, processor, storage, capacity: new FakeCapacity(),
        cleanup, admins: { lockAndAssertAdmin: async () => undefined },
      });
      return { useCase, processor, storage, cleanup };
    }
    const file = new Uint8Array(1000);
    const failure = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e; } return undefined; };
    const quotaOf = (workshopId: bigint) => db.storageQuota.findUniqueOrThrow({ where: { workshop_id: workshopId } });

    it('thành công: reservation committed, quota quyết toán, Image được tạo, tệp có trên kho', async () => {
      const { account, workshop } = await newWorkshop();
      const { useCase, storage } = build();
      const result = await useCase.execute({
        actor: actorOf(account.id, workshop.id), file, contextType: 'journal_entry', contextId: null,
        target: { kind: 'workshop', workshopId: workshop.id.toString() },
      });
      const quota = await quotaOf(workshop.id);
      expect(quota).toMatchObject({ used_bytes: BigInt(320_000), reserved_bytes: BigInt(0) });
      const image = await db.image.findUniqueOrThrow({ where: { id: BigInt(result.imageId) }, include: { reservation: true } });
      expect(image.reservation).toMatchObject({ status: 'committed', actual_bytes: BigInt(320_000) });
      expect(image.quota_id).toBe(quota.id);
      expect(storage.files.size).toBe(2);
      expect(result.unattachedExpiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    });

    it('xử lý lỗi: DB trả về trạng thái sạch, reservation released, tệp bị xóa', async () => {
      const { account, workshop } = await newWorkshop();
      const processor = new FakeProcessor();
      processor.outcome = 'timeout';
      const { useCase, storage } = build({ processor });
      const error = await failure(useCase.execute({
        actor: actorOf(account.id, workshop.id), file, contextType: 'product', contextId: null,
        target: { kind: 'workshop', workshopId: workshop.id.toString() },
      }));
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(await quotaOf(workshop.id)).toMatchObject({ used_bytes: BigInt(0), reserved_bytes: BigInt(0) });
      const reservation = await db.uploadReservation.findFirstOrThrow({ where: { uploaded_by: account.id } });
      expect(reservation.status).toBe('released');
      expect(await db.image.count({ where: { uploaded_by: account.id } })).toBe(0);
      expect(storage.files.size).toBe(0);
    });

    async function raceSixUploads(delayMs: number) {
      const { account, workshop } = await newWorkshop();
      await runner.run(tx => quotas.lockOrCreateWorkshopQuota(workshop.id.toString(), BigInt(0), tx));
      await db.storageQuota.update({ where: { workshop_id: workshop.id }, data: { limit_bytes: BUDGET * BigInt(2) + MIB } });
      const processor = new FakeProcessor();
      processor.delayMs = delayMs;
      const { useCase } = build({ processor });
      const outcomes = await Promise.all(Array.from({ length: 6 }, () => useCase.execute({
        actor: actorOf(account.id, workshop.id), file, contextType: 'journal_entry', contextId: null,
        target: { kind: 'workshop', workshopId: workshop.id.toString() },
      }).then(() => 'ok', (e: unknown) => (e instanceof BusinessRuleException ? e.code : `lỗi: ${String(e)}`))));
      return { account, workshop, outcomes };
    }

    it('cạnh tranh có kiểm soát: giữ reservation đủ lâu để cả 6 cùng giữ chỗ → đúng 2 thành công, 4 STORAGE_QUOTA_EXCEEDED', async () => {
      const { account, workshop, outcomes } = await raceSixUploads(300);
      expect(outcomes.filter(o => o === 'ok')).toHaveLength(2);
      expect(outcomes.filter(o => o === 'STORAGE_QUOTA_EXCEEDED')).toHaveLength(4);
      expect(await quotaOf(workshop.id)).toMatchObject({ used_bytes: BigInt(640_000), reserved_bytes: BigInt(0) });
      expect(await db.image.count({ where: { uploaded_by: account.id } })).toBe(2);
      expect(await db.uploadReservation.count({ where: { uploaded_by: account.id, status: 'committed' } })).toBe(2);
    });

    it('cạnh tranh không kiểm soát thời gian: chỉ giữ các bất biến (không lỗi lạ, sổ sách khớp số ảnh)', async () => {
      const { account, workshop, outcomes } = await raceSixUploads(0);
      const succeeded = outcomes.filter(o => o === 'ok').length;
      expect(succeeded).toBeGreaterThanOrEqual(2);
      expect(outcomes.every(o => o === 'ok' || o === 'STORAGE_QUOTA_EXCEEDED')).toBe(true);
      expect(await quotaOf(workshop.id)).toMatchObject({ used_bytes: BigInt(320_000 * succeeded), reserved_bytes: BigInt(0) });
      expect(await db.image.count({ where: { uploaded_by: account.id } })).toBe(succeeded);
    });

    it('Admin tải ảnh vào phạm vi khởi tạo; phạm vi hết hạn bị từ chối', async () => {
      const admin = await newAccount('admin');
      const open = await newScope(admin.id);
      const expired = await newScope(admin.id, -1000);
      const { useCase } = build();
      const ok = await useCase.execute({
        actor: actorOf(admin.id, BigInt(0), 'admin'), file, contextType: 'workshop_profile', contextId: null,
        target: { kind: 'initial_scope', initialWorkshopKey: open.initial_workshop_key },
      });
      const image = await db.image.findUniqueOrThrow({ where: { id: BigInt(ok.imageId) }, include: { quota: true } });
      expect(image.quota.initial_workshop_key).toBe(open.initial_workshop_key);
      expect(image.quota.used_bytes).toBe(BigInt(320_000));
      const error = await failure(useCase.execute({
        actor: actorOf(admin.id, BigInt(0), 'admin'), file, contextType: 'workshop_profile', contextId: null,
        target: { kind: 'initial_scope', initialWorkshopKey: expired.initial_workshop_key },
      }));
      expect((error as BusinessRuleException).code).toBe('UPLOAD_SCOPE_UNAVAILABLE');
    });
  });
});
