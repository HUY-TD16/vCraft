import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '../../../src/common/application/errors/service-unavailable.exception';
import type { TransactionContext, TransactionRunner } from '../../../src/common/application/ports/transaction-runner';
import type { TrustedActor } from '../../../src/common/application/types/contract-types';
import { BusinessRuleException } from '../../../src/common/domain/errors/business-rule.exception';
import type { PrismaService } from '../../../src/infrastructure/database/prisma/prisma.service';
import type { PrismaTransactionRunner } from '../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import { MediaService } from '../../../src/modules/media/application/services/media.service';
import { GetImageUseCase } from '../../../src/modules/media/application/use-cases/images/get-image.use-case';
import { CreateUploadScopeUseCase } from '../../../src/modules/media/application/use-cases/uploads/create-upload-scope.use-case';
import { ReservationCleanupService } from '../../../src/modules/media/application/services/reservation-cleanup.service';
import { UploadImageUseCase } from '../../../src/modules/media/application/use-cases/uploads/upload-image.use-case';
import { QUOTA_LIMIT_BYTES, UPLOAD_LIMITS } from '../../../src/modules/media/domain/value-objects/image-limits';
import { FakeCapacity, FakeImageAccessResolver, FakeProcessor, InMemoryStorage } from '../../support/fakes/media-in-memory';

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
    // Mọi kết nối của bộ test dùng múi giờ lệch khỏi UTC, để lỗi đọc timestamptz bằng truy vấn thô lộ ra trên mọi máy
    // (đã gặp thật trên PostgreSQL Windows, múi giờ UTC+7).
    const url = new URL(testUrl!);
    url.searchParams.set('options', '-c timezone=Asia/Ho_Chi_Minh');
    db = new PrismaService({ DATABASE_URL: url.toString() });
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
    await db.journalHistoryImage.deleteMany({ where: { image: { uploaded_by: accounts } } });
    await db.journalEditHistory.deleteMany({ where: { edited_by: accounts } });
    await db.journalEntry.deleteMany({ where: { performed_by: accounts } });
    await db.batch.deleteMany({ where: { workshop_id: { in: created.workshops } } });
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
      const cleanup = new ReservationCleanupService({ txRunner: runner, quotas, reservations, images, storage });
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

  describe('Gắn ảnh, lịch sử và phạm vi upload (IMediaContract trên PostgreSQL thật)', () => {
    const access = new FakeImageAccessResolver();
    let service: MediaService;
    let getImage: GetImageUseCase;
    let createScope: CreateUploadScopeUseCase;
    const adminAssertion = { lockAndAssertAdmin: async () => undefined };
    const failure = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e; } return undefined; };
    const codeOf = (e: unknown) => (e instanceof BusinessRuleException ? e.code : `OTHER:${String(e)}`);

    beforeAll(() => {
      service = new MediaService(images, quotas, scopes, reservations, access, adminAssertion);
      getImage = new GetImageUseCase({ txRunner: runner, images, reservations, access });
      createScope = new CreateUploadScopeUseCase({ txRunner: runner, scopes, reservations, admins: adminAssertion });
    });

    /** Một ảnh đã quyết toán (committed) trong quota của hộ, y như sau một lần upload thành công. */
    async function image(workshopId: bigint, accountId: bigint, contextType: 'journal_entry' | 'product' | 'workshop_profile' = 'journal_entry') {
      return runner.run(async (tx) => {
        const quota = await quotas.lockOrCreateWorkshopQuota(workshopId.toString(), QUOTA_LIMIT_BYTES.workshop, tx);
        const prefix = `w${workshopId}/${randomUUID()}/`;
        const reservation = await reservations.create({
          quotaId: quota.id, uploadedBy: accountId.toString(), contextType, contextId: null,
          budgetBytes: BigInt(10), storagePrefix: prefix, expiresAt: new Date(Date.now() + 60_000),
        }, tx);
        await reservations.saveState(reservation.id, { ...reservation.state, status: 'committed', actualBytes: BigInt(0) }, tx);
        return images.create({
          uploadedBy: accountId.toString(), contextType, contextId: null, thumbnailKey: `${prefix}thumbnail.webp`, displayKey: `${prefix}display.webp`,
          thumbnailSizeBytes: BigInt(11), displaySizeBytes: BigInt(222), quotaId: quota.id, reservationId: reservation.id,
          width: 4, height: 3, unreferencedAt: new Date(),
        }, tx);
      });
    }
    const actorFor = (account: { id: bigint }, workshop: { id: bigint }) => actorOf(account.id, workshop.id);
    const row = (id: string) => db.image.findUniqueOrThrow({ where: { id: BigInt(id) } });

    async function journalHistory(workshopId: bigint, accountId: bigint) {
      const batch = await db.batch.create({ data: { workshop_id: workshopId, name: 'Lô thử', qr_token: randomUUID().replaceAll('-', ''), status: 'draft' } });
      const entry = await db.journalEntry.create({ data: { batch_id: batch.id, performed_by: accountId, stage: 'Nặn', performed_at: new Date() } });
      const history = await db.journalEditHistory.create({ data: {
        journal_entry_id: entry.id, edited_by: accountId, prev_stage: 'Nặn cũ', prev_performed_at: new Date(), edited_at: new Date(),
      } });
      return { entry, history };
    }

    it('findById trả trạng thái đầy đủ kèm hộ chủ quota; ID lạ trả null', async () => {
      const { account, workshop } = await newWorkshop();
      const img = await image(workshop.id, account.id);
      const found = await runner.run(tx => images.findById(img.id, tx));
      expect(found).toMatchObject({
        id: img.id, uploadedBy: account.id.toString(), contextType: 'journal_entry', contextId: null, quotaId: img.quotaId,
        quotaWorkshopId: workshop.id.toString(), isAttached: false, storageState: 'ready',
        thumbnailKey: img.thumbnailKey, displayKey: img.displayKey, thumbnailSizeBytes: BigInt(11), displaySizeBytes: BigInt(222),
      });
      expect(found!.unreferencedAt).toBeInstanceOf(Date);
      expect(await runner.run(tx => images.findById('999999999', tx))).toBeNull();
    });

    it('lockByIds trả theo ID tăng dần, bỏ qua ID lạ, trả rỗng khi không có ID', async () => {
      const { account, workshop } = await newWorkshop();
      const [a, b, c] = [await image(workshop.id, account.id), await image(workshop.id, account.id), await image(workshop.id, account.id)];
      const locked = await runner.run(tx => images.lockByIds([c.id, a.id, '999999999', b.id], tx));
      expect(locked.map(i => i.id)).toEqual([a.id, b.id, c.id]);
      expect(await runner.run(tx => images.lockByIds([], tx))).toEqual([]);
      expect(await runner.run(tx => images.lockByIds(['999999999'], tx))).toEqual([]);
    });

    it('lockByIds khóa độc quyền các dòng ảnh cho đến hết giao dịch', async () => {
      const { account, workshop } = await newWorkshop();
      const a = await image(workshop.id, account.id);
      const events: string[] = [];
      const holder = runner.run(async (tx) => { await images.lockByIds([a.id], tx); events.push('A giữ'); await sleep(300); events.push('A nhả'); });
      await sleep(100);
      const waiter = runner.run(async (tx) => { events.push('B xin'); await images.lockByIds([a.id], tx); events.push('B được'); });
      await Promise.all([holder, waiter]);
      expect(events).toEqual(['A giữ', 'B xin', 'A nhả', 'B được']);
    });

    it('markAttached / listAttachedIds / markDetached: cố định context_id, mốc hết hạn, thứ tự tăng dần', async () => {
      const { account, workshop } = await newWorkshop();
      const [a, b, c] = [await image(workshop.id, account.id), await image(workshop.id, account.id), await image(workshop.id, account.id)];
      await runner.run(tx => images.markAttached([c.id, a.id], '70', tx));
      expect(await runner.run(tx => images.listAttachedIds('journal_entry', '70', tx))).toEqual([a.id, c.id]);
      expect(await runner.run(tx => images.listAttachedIds('journal_entry', '71', tx))).toEqual([]);
      expect(await runner.run(tx => images.listAttachedIds('product', '70', tx))).toEqual([]);
      expect(await row(a.id)).toMatchObject({ is_attached: true, context_id: BigInt(70), unreferenced_at: null });
      expect(await row(b.id)).toMatchObject({ is_attached: false, context_id: null });

      const at = new Date('2026-11-21T10:00:00.000Z');
      await runner.run(tx => images.markDetached([a.id], at, tx));
      const detached = await row(a.id);
      expect(detached).toMatchObject({ is_attached: false, context_id: BigInt(70) });
      expect(detached.unreferenced_at!.getTime()).toBe(at.getTime());
      expect(await runner.run(tx => images.listAttachedIds('journal_entry', '70', tx))).toEqual([c.id]);
    });

    it('lịch sử: addHistoryLinks ghi position theo thứ tự; findHistoryEntry và isReferencedByHistory đọc lại đúng', async () => {
      const { account, workshop } = await newWorkshop();
      const { entry, history } = await journalHistory(workshop.id, account.id);
      const [a, b, other] = [await image(workshop.id, account.id), await image(workshop.id, account.id), await image(workshop.id, account.id)];
      await runner.run(tx => images.addHistoryLinks(history.id.toString(), [b.id, a.id], tx));
      const links = await db.journalHistoryImage.findMany({ where: { history_id: history.id }, orderBy: { position: 'asc' } });
      expect(links.map(l => [l.image_id.toString(), l.position])).toEqual([[b.id, 0], [a.id, 1]]);
      expect(await runner.run(tx => images.findHistoryEntry(history.id.toString(), a.id, tx))).toEqual({ entryId: entry.id.toString() });
      expect(await runner.run(tx => images.findHistoryEntry(history.id.toString(), other.id, tx))).toBeNull();
      expect(await runner.run(tx => images.findHistoryEntry('999999999', a.id, tx))).toBeNull();
      expect(await runner.run(tx => images.isReferencedByHistory(a.id, tx))).toBe(true);
      expect(await runner.run(tx => images.isReferencedByHistory(other.id, tx))).toBe(false);
      await runner.run(tx => images.addHistoryLinks(history.id.toString(), [], tx));
    });

    it('createScope tạo phạm vi mở cùng quota 2 GiB; countOpenUnexpired chỉ đếm phạm vi còn hiệu lực của đúng Admin', async () => {
      const [adminA, adminB] = [await newAccount('admin'), await newAccount('admin')];
      const mk = async (admin: typeof adminA) => {
        const result = await runner.run(tx => scopes.create({ adminId: admin.id.toString(), expiresAt: new Date(Date.now() + 3_600_000), quotaLimitBytes: QUOTA_LIMIT_BYTES.initialScope }, tx));
        created.scopes.push(result.initialWorkshopKey);
        return result;
      };
      const first = await mk(adminA);
      expect(first.initialWorkshopKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(first).toMatchObject({ createdBy: adminA.id.toString(), status: 'open' });
      const quota = await db.storageQuota.findUniqueOrThrow({ where: { initial_workshop_key: first.initialWorkshopKey } });
      expect(quota).toMatchObject({ limit_bytes: QUOTA_LIMIT_BYTES.initialScope, used_bytes: BigInt(0), workshop_id: null, account_id: null });

      await mk(adminA); await mk(adminB);
      const expired = await newScope(adminA.id, -1000);
      await db.initialWorkshopUploadScope.update({ where: { initial_workshop_key: expired.initial_workshop_key }, data: { status: 'open' } });
      const now = new Date();
      expect(await runner.run(tx => scopes.countOpenUnexpired(adminA.id.toString(), now, tx))).toBe(2);   // 2 còn hạn, 1 hết hạn không tính
      expect(await runner.run(tx => scopes.countOpenUnexpired(adminB.id.toString(), now, tx))).toBe(1);
      expect(await runner.run(tx => scopes.countOpenUnexpired(adminA.id.toString(), new Date(Date.now() + 2 * 3_600_000), tx))).toBe(0);
    });

    it('countActiveByQuota chỉ đếm reserved và cleanup_pending', async () => {
      const { account, workshop } = await newWorkshop();
      const quota = await runner.run(tx => quotas.lockOrCreateWorkshopQuota(workshop.id.toString(), QUOTA_LIMIT_BYTES.workshop, tx));
      for (const status of ['reserved', 'cleanup_pending', 'committed', 'released'] as const) {
        await runner.run(async (tx) => {
          const r = await reservations.create({
            quotaId: quota.id, uploadedBy: account.id.toString(), contextType: 'product', contextId: null, budgetBytes: BigInt(1),
            storagePrefix: `w${workshop.id}/${randomUUID()}/`, expiresAt: new Date(Date.now() + 60_000),
          }, tx);
          await reservations.saveState(r.id, { ...r.state, status, actualBytes: status === 'committed' ? BigInt(0) : null }, tx);
        });
      }
      expect(await runner.run(tx => reservations.countActiveByQuota(quota.id, tx))).toBe(2);
    });

    it('replaceImages thật: gắn, thay, gỡ; ảnh gỡ giữ context_id và có mốc hết hạn', async () => {
      const { account, workshop } = await newWorkshop();
      const [a, b, c] = [await image(workshop.id, account.id), await image(workshop.id, account.id), await image(workshop.id, account.id)];
      const replace = (ids: string[]) => runner.run(tx => service.replaceImages({
        contextType: 'journal_entry', contextId: '70', workshopId: workshop.id.toString(), imageIds: ids, actor: actorFor(account, workshop),
      }, tx));
      await replace([a.id, b.id]);
      await replace([b.id, c.id]);
      expect(await row(a.id)).toMatchObject({ is_attached: false, context_id: BigInt(70) });
      expect((await row(a.id)).unreferenced_at).toBeInstanceOf(Date);
      expect(await row(b.id)).toMatchObject({ is_attached: true, unreferenced_at: null });
      expect(await row(c.id)).toMatchObject({ is_attached: true, context_id: BigInt(70) });
      // ảnh của hộ khác không gắn được
      const { account: otherAccount, workshop: otherWorkshop } = await newWorkshop();
      const foreign = await image(otherWorkshop.id, otherAccount.id);
      expect(codeOf(await failure(replace([foreign.id])))).toBe('IMAGE_CONTEXT_MISMATCH');
    });

    it('replaceImages song song trên cùng một đối tượng: kết quả luôn là một trong hai danh sách, không trộn lẫn', async () => {
      const { account, workshop } = await newWorkshop();
      const imgs = await Promise.all(Array.from({ length: 4 }, () => image(workshop.id, account.id)));
      const replace = (ids: string[]) => runner.run(tx => service.replaceImages({
        contextType: 'journal_entry', contextId: '70', workshopId: workshop.id.toString(), imageIds: ids, actor: actorFor(account, workshop),
      }, tx));
      const listA = [imgs[0]!.id, imgs[1]!.id];
      const listB = [imgs[2]!.id, imgs[3]!.id];
      await Promise.all([replace(listA), replace(listB), replace(listA), replace(listB)]);
      const final = await runner.run(tx => images.listAttachedIds('journal_entry', '70', tx));
      expect([JSON.stringify([...listA].sort()), JSON.stringify([...listB].sort())]).toContain(JSON.stringify(final));
    });

    it('retainHistoryImages thật: ghi lịch sử rồi đọc lại bằng getImageDto và GetImageUseCase', async () => {
      const { account, workshop } = await newWorkshop();
      const { entry, history } = await journalHistory(workshop.id, account.id);
      const img = await image(workshop.id, account.id);
      const actor = actorFor(account, workshop);
      await runner.run(async (tx) => {
        await service.replaceImages({ contextType: 'journal_entry', contextId: entry.id.toString(), workshopId: workshop.id.toString(), imageIds: [img.id], actor }, tx);
        await service.retainHistoryImages({ historyId: history.id.toString(), entryId: entry.id.toString(), imageIds: [img.id] }, tx);
      });
      access.historyAllowed.add(`${history.id}:${img.id}:${account.id}`);
      access.currentAllowed.add(`journal_entry:${entry.id}:${img.id}:${account.id}`);
      const dto = await runner.run(tx => service.getImageDto({ imageId: img.id, contextType: 'journal_entry', contextId: entry.id.toString(), historyId: history.id.toString(), actorOrNull: actor }, tx));
      expect(dto).toEqual({
        id: img.id,
        thumbnail_url: `/api/v1/media/history/${history.id}/images/${img.id}/thumbnail`,
        display_url: `/api/v1/media/history/${history.id}/images/${img.id}/display`,
      });
      const target = await getImage.execute({ actorOrNull: actor, variant: 'thumbnail', source: { kind: 'history', historyId: history.id.toString(), imageId: img.id } });
      expect(target).toEqual({ key: img.thumbnailKey, sizeBytes: BigInt(11), contentType: 'image/webp' });
      expect(codeOf(await failure(getImage.execute({ actorOrNull: actor, variant: 'display', source: { kind: 'history', historyId: '999999999', imageId: img.id } })))).toBe('RESOURCE_NOT_FOUND');
    });

    it('GetImageUseCase pending/current trên DB thật', async () => {
      const { account, workshop } = await newWorkshop();
      const img = await image(workshop.id, account.id);
      const actor = actorFor(account, workshop);
      expect((await getImage.execute({ actorOrNull: actor, variant: 'display', source: { kind: 'pending', imageId: img.id } })).key).toBe(img.displayKey);
      const stranger = await newWorkshop();
      expect(codeOf(await failure(getImage.execute({ actorOrNull: actorFor(stranger.account, stranger.workshop), variant: 'display', source: { kind: 'pending', imageId: img.id } })))).toBe('RESOURCE_NOT_FOUND');
      // sau khi gắn thì không còn là ảnh chờ
      await runner.run(tx => service.replaceImages({ contextType: 'journal_entry', contextId: '70', workshopId: workshop.id.toString(), imageIds: [img.id], actor }, tx));
      expect(codeOf(await failure(getImage.execute({ actorOrNull: actor, variant: 'display', source: { kind: 'pending', imageId: img.id } })))).toBe('RESOURCE_NOT_FOUND');
      access.currentAllowed.add(`journal_entry:70:${img.id}:${account.id}`);
      expect((await getImage.execute({ actorOrNull: actor, variant: 'thumbnail', source: { kind: 'current', contextType: 'journal_entry', contextId: '70', imageId: img.id } })).key).toBe(img.thumbnailKey);
      // pending hết 24 giờ: đẩy mốc về quá khứ
      const old = await image(workshop.id, account.id);
      await db.image.update({ where: { id: BigInt(old.id) }, data: { unreferenced_at: new Date(Date.now() - 25 * 3_600_000) } });
      expect(codeOf(await failure(getImage.execute({ actorOrNull: actor, variant: 'display', source: { kind: 'pending', imageId: old.id } })))).toBe('RESOURCE_NOT_FOUND');
    });

    describe('luồng cấp hộ có ảnh: tạo phạm vi → upload → gắn khi cấp hộ', () => {
      const file = new Uint8Array(1000);
      async function scopeWithUploadedImage() {
        const admin = await newAccount('admin');
        const adminActor = actorOf(admin.id, BigInt(0), 'admin');
        const scope = await createScope.execute({ actor: adminActor });
        created.scopes.push(scope.initialWorkshopKey);
        const storage = new InMemoryStorage();
        const cleanup = new ReservationCleanupService({ txRunner: runner, quotas, reservations, images, storage });
        const upload = new UploadImageUseCase({
          txRunner: runner, quotas, scopes, reservations, images, processor: new FakeProcessor(), storage, capacity: new FakeCapacity(), cleanup, admins: adminAssertion,
        });
        const first = await upload.execute({ actor: adminActor, file, contextType: 'workshop_profile', contextId: null, target: { kind: 'initial_scope', initialWorkshopKey: scope.initialWorkshopKey } });
        const second = await upload.execute({ actor: adminActor, file, contextType: 'workshop_profile', contextId: null, target: { kind: 'initial_scope', initialWorkshopKey: scope.initialWorkshopKey } });
        return { admin, adminActor, scope, first, second };
      }

      it('attach: chuyển CHÍNH dòng quota, giữ used_bytes, ảnh chọn được gắn với ID hộ, ảnh còn lại ở lại quota hộ', async () => {
        const { adminActor, scope, first, second } = await scopeWithUploadedImage();
        const before = await db.storageQuota.findUniqueOrThrow({ where: { initial_workshop_key: scope.initialWorkshopKey } });
        expect(before.used_bytes).toBe(BigInt(640_000));
        const { workshop } = await newWorkshop();
        // quota hộ tự tạo ở newWorkshop? không: chỉ tạo khi upload. Xác nhận chưa có để chuyển không đụng ràng buộc unique.
        expect(await db.storageQuota.count({ where: { workshop_id: workshop.id } })).toBe(0);

        await runner.run(tx => service.attachInitialWorkshopScope({
          initialWorkshopKey: scope.initialWorkshopKey, workshopId: workshop.id.toString(), imageIds: [first.imageId], actor: adminActor,
        }, tx));

        const after = await db.storageQuota.findUniqueOrThrow({ where: { workshop_id: workshop.id } });
        expect(after).toMatchObject({ id: before.id, used_bytes: BigInt(640_000), reserved_bytes: BigInt(0), initial_workshop_key: null });
        expect(await db.initialWorkshopUploadScope.findUniqueOrThrow({ where: { initial_workshop_key: scope.initialWorkshopKey } }))
          .toMatchObject({ status: 'attached', attached_workshop_id: workshop.id });
        expect(await row(first.imageId)).toMatchObject({ is_attached: true, context_id: workshop.id, unreferenced_at: null });
        expect(await row(second.imageId)).toMatchObject({ is_attached: false, quota_id: before.id });

        // hộ mới dùng tiếp đúng dòng quota đã chuyển, không tạo dòng thứ hai
        const reused = await runner.run(tx => quotas.lockOrCreateWorkshopQuota(workshop.id.toString(), QUOTA_LIMIT_BYTES.workshop, tx));
        expect(reused.id).toBe(before.id.toString());
        expect(reused.state.usedBytes).toBe(BigInt(640_000));
        expect(await db.storageQuota.count({ where: { workshop_id: workshop.id } })).toBe(1);
      });

      it('rollback: workflow lỗi sau attach thì phạm vi, quota và ảnh trở về nguyên trạng', async () => {
        const { adminActor, scope, first } = await scopeWithUploadedImage();
        const { workshop } = await newWorkshop();
        const boom = new Error('tạo Account/Workshop thất bại');
        await expect(runner.run(async (tx) => {
          await service.attachInitialWorkshopScope({ initialWorkshopKey: scope.initialWorkshopKey, workshopId: workshop.id.toString(), imageIds: [first.imageId], actor: adminActor }, tx);
          throw boom;
        })).rejects.toBe(boom);
        expect(await db.initialWorkshopUploadScope.findUniqueOrThrow({ where: { initial_workshop_key: scope.initialWorkshopKey } })).toMatchObject({ status: 'open', attached_workshop_id: null });
        expect(await db.storageQuota.count({ where: { initial_workshop_key: scope.initialWorkshopKey } })).toBe(1);
        expect(await db.storageQuota.count({ where: { workshop_id: workshop.id } })).toBe(0);
        expect(await row(first.imageId)).toMatchObject({ is_attached: false, context_id: null });
      });

      it('không cấp lại được: phạm vi đã dùng, hoặc khóa của Admin khác', async () => {
        const { adminActor, scope, first } = await scopeWithUploadedImage();
        const { workshop } = await newWorkshop();
        const input = { initialWorkshopKey: scope.initialWorkshopKey, workshopId: workshop.id.toString(), imageIds: [first.imageId], actor: adminActor };
        await runner.run(tx => service.attachInitialWorkshopScope(input, tx));
        const another = await newWorkshop();
        expect(codeOf(await failure(runner.run(tx => service.attachInitialWorkshopScope({ ...input, workshopId: another.workshop.id.toString() }, tx))))).toBe('UPLOAD_SCOPE_UNAVAILABLE');
        const otherAdmin = await newAccount('admin');
        expect(codeOf(await failure(runner.run(tx => service.attachInitialWorkshopScope({ ...input, actor: actorOf(otherAdmin.id, BigInt(0), 'admin') }, tx))))).toBe('RESOURCE_NOT_FOUND');
      });

      it('UPLOAD_SCOPE_BUSY khi còn reservation đang xử lý', async () => {
        const { adminActor, scope, first } = await scopeWithUploadedImage();
        const quota = await db.storageQuota.findUniqueOrThrow({ where: { initial_workshop_key: scope.initialWorkshopKey } });
        await db.uploadReservation.create({ data: {
          quota_id: quota.id, uploaded_by: BigInt(adminActor.accountId), context_type: 'workshop_profile', budget_bytes: BigInt(1),
          status: 'reserved', storage_prefix: `s${scope.initialWorkshopKey}/${randomUUID()}/`, expires_at: new Date(Date.now() + 60_000),
        } });
        const { workshop } = await newWorkshop();
        const error = await failure(runner.run(tx => service.attachInitialWorkshopScope({
          initialWorkshopKey: scope.initialWorkshopKey, workshopId: workshop.id.toString(), imageIds: [first.imageId], actor: adminActor,
        }, tx)));
        expect(codeOf(error)).toBe('UPLOAD_SCOPE_BUSY');
        expect((await db.initialWorkshopUploadScope.findUniqueOrThrow({ where: { initial_workshop_key: scope.initialWorkshopKey } })).status).toBe('open');
      });

      it('đua: hai workflow cùng cấp hộ từ một phạm vi → đúng một thành công', async () => {
        const { adminActor, scope, first } = await scopeWithUploadedImage();
        const [w1, w2] = [await newWorkshop(), await newWorkshop()];
        const attach = (workshopId: bigint) => runner.run(tx => service.attachInitialWorkshopScope({
          initialWorkshopKey: scope.initialWorkshopKey, workshopId: workshopId.toString(), imageIds: [first.imageId], actor: adminActor,
        }, tx)).then(() => 'ok', (e: unknown) => codeOf(e));
        const outcomes = await Promise.all([attach(w1.workshop.id), attach(w2.workshop.id)]);
        expect(outcomes.filter(o => o === 'ok')).toHaveLength(1);
        expect(outcomes.filter(o => o === 'UPLOAD_SCOPE_UNAVAILABLE')).toHaveLength(1);
        expect(await db.storageQuota.count({ where: { workshop_id: { in: [w1.workshop.id, w2.workshop.id] } } })).toBe(1);
      });
    });

    it('CreateUploadScopeUseCase trên DB thật: tối đa 3 phạm vi, đua đồng thời vẫn không vượt 3 (khóa Account Admin thật sự cần ở Identity)', async () => {
      const admin = await newAccount('admin');
      const actor = actorOf(admin.id, BigInt(0), 'admin');
      for (let i = 0; i < 3; i++) created.scopes.push((await createScope.execute({ actor })).initialWorkshopKey);
      expect(codeOf(await failure(createScope.execute({ actor })))).toBe('UPLOAD_SCOPE_LIMIT_EXCEEDED');
      expect(await db.initialWorkshopUploadScope.count({ where: { created_by: admin.id } })).toBe(3);
    });
  });
});
