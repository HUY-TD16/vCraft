import { beforeEach, describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '../../../../src/common/application/errors/service-unavailable.exception';
import type { TrustedActor } from '../../../../src/common/application/types/contract-types';
import { BusinessRuleException } from '../../../../src/common/domain/errors/business-rule.exception';
import { ReservationCleanupService } from '../../../../src/modules/media/application/services/reservation-cleanup.service';
import {
  UploadImageUseCase, type AdminAssertion, type UploadImageCommand,
} from '../../../../src/modules/media/application/use-cases/uploads/upload-image.use-case';
import { GIB, MIB, QUOTA_LIMIT_BYTES, UPLOAD_LIMITS } from '../../../../src/modules/media/domain/value-objects/image-limits';
import {
  FakeCapacity, FakeProcessor, InMemoryImageRepository, InMemoryMediaDb, InMemoryQuotaRepository,
  InMemoryReservationRepository, InMemoryScopeRepository, InMemoryStorage, InMemoryTransactionRunner,
} from '../../../support/fakes/media-in-memory';

const artisan: TrustedActor = { accountId: '11', role: 'artisan', workshopId: '7', authVersion: 1, sessionId: 's' };
const buyer: TrustedActor = { accountId: '12', role: 'buyer', workshopId: null, authVersion: 1, sessionId: 's' };
const admin: TrustedActor = { accountId: '5', role: 'admin', workshopId: null, authVersion: 1, sessionId: 's' };
const KEY = '8c1f2c7e-5f0a-4d44-9a52-6d0d6b0f1a11';
const file = new Uint8Array(1000);

function setup() {
  const db = new InMemoryMediaDb();
  const txRunner = new InMemoryTransactionRunner(db);
  const quotas = new InMemoryQuotaRepository(db);
  const scopes = new InMemoryScopeRepository(db);
  const reservations = new InMemoryReservationRepository(db);
  const images = new InMemoryImageRepository(db);
  const storage = new InMemoryStorage();
  const processor = new FakeProcessor();
  const capacity = new FakeCapacity();
  const adminCalls: TrustedActor[] = [];
  const admins: AdminAssertion = { lockAndAssertAdmin: async (a) => { adminCalls.push(a); } };
  const cleanup = new ReservationCleanupService({ txRunner, quotas, reservations, storage });
  let n = 0;
  const useCase = new UploadImageUseCase({
    txRunner, quotas, scopes, reservations, images, processor, storage, capacity, cleanup, admins,
    newPrefixId: () => `p${++n}`,
  });
  return { db, txRunner, storage, processor, capacity, useCase, cleanup, adminCalls, reservations, images };
}

const workshopCommand = (over: Partial<UploadImageCommand> = {}): UploadImageCommand => ({
  actor: artisan, file, contextType: 'journal_entry', contextId: null,
  target: { kind: 'workshop', workshopId: '7' }, ...over,
});
const scopeCommand = (over: Partial<UploadImageCommand> = {}): UploadImageCommand => ({
  actor: admin, file, contextType: 'workshop_profile', contextId: null,
  target: { kind: 'initial_scope', initialWorkshopKey: KEY }, ...over,
});
const failure = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e; } return undefined; };
const codeOf = (e: unknown) => (e instanceof BusinessRuleException || e instanceof ServiceUnavailableException ? e.code : `OTHER:${String(e)}`);
const quotaOf = (db: InMemoryMediaDb, workshopId: string) =>
  [...db.quotas.values()].find(q => q.owner.kind === 'workshop' && q.owner.workshopId === workshopId)!.state;
const BUDGET = UPLOAD_LIMITS.reservationBudgetBytes;

describe('UploadImageUseCase — Artisan, hộ của mình', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it('thành công: quyết toán byte thực, tạo Image chờ gắn, hạn 24 giờ', async () => {
    const result = await t.useCase.execute(workshopCommand());
    const quota = quotaOf(t.db, '7');
    expect(quota.reservedBytes).toBe(BigInt(0));
    expect(quota.usedBytes).toBe(BigInt(20_000 + 300_000));
    expect(quota.limitBytes).toBe(QUOTA_LIMIT_BYTES.workshop);

    const reservation = [...t.db.reservations.values()][0]!;
    expect(reservation.state).toMatchObject({ status: 'committed', actualBytes: BigInt(320_000) });
    const image = t.db.images.get(result.imageId)!;
    expect(image).toMatchObject({
      contextType: 'journal_entry', contextId: null, quotaId: reservation.quotaId, reservationId: reservation.id,
      thumbnailSizeBytes: BigInt(20_000), displaySizeBytes: BigInt(300_000), width: 4000, height: 3000,
    });
    expect(result.unattachedExpiresAt.toISOString()).toBe('2026-11-22T10:00:00.000Z');
    expect([...t.storage.files.keys()].sort()).toEqual([`w7/p1/display.webp`, `w7/p1/thumbnail.webp`]);
    expect(image.thumbnailKey).toBe('w7/p1/thumbnail.webp');
  });

  it('hộ chưa có quota thì tạo với hạn mức 2 GiB; lần sau dùng lại cùng dòng', async () => {
    await t.useCase.execute(workshopCommand());
    await t.useCase.execute(workshopCommand());
    expect([...t.db.quotas.values()]).toHaveLength(1);
    expect(quotaOf(t.db, '7').usedBytes).toBe(BigInt(640_000));
  });

  it('khóa đúng thứ tự: kho chung trước quota trước reservation', async () => {
    await t.useCase.execute(workshopCommand());
    const first = t.db.locks.slice(0, 2);
    expect(first[0]).toBe('storage');
    expect(first[1]).toMatch(/^quota:/);
    const commitStart = t.db.locks.lastIndexOf('storage');
    expect(t.db.locks[commitStart + 1]).toMatch(/^quota:/);
    expect(t.db.locks[commitStart + 2]).toMatch(/^reservation:/);
  });

  it('Buyer và Artisan hộ khác bị từ chối, không đụng DB hay kho', async () => {
    expect(codeOf(await failure(t.useCase.execute(workshopCommand({ actor: buyer }))))).toBe('PERMISSION_DENIED');
    expect(codeOf(await failure(t.useCase.execute(workshopCommand({ target: { kind: 'workshop', workshopId: '8' } }))))).toBe('PERMISSION_DENIED');
    expect(t.txRunner.transactions).toBe(0);
    expect(t.processor.processCalls).toBe(0);
  });

  it('ảnh không hợp lệ bị từ chối trước khi giữ chỗ (không tốn quota)', async () => {
    t.processor.info = { format: 'gif', width: 10, height: 10 };
    expect(codeOf(await failure(t.useCase.execute(workshopCommand())))).toBe('INVALID_IMAGE_FORMAT');
    expect(t.txRunner.transactions).toBe(0);
    expect(t.db.reservations.size).toBe(0);
  });

  it('vượt hạn mức hộ → STORAGE_QUOTA_EXCEEDED, DB nguyên vẹn (rollback)', async () => {
    await t.useCase.execute(workshopCommand());
    const row = [...t.db.quotas.values()][0]!;
    t.db.quotas.set(row.id, { ...row, state: { ...row.state, usedBytes: QUOTA_LIMIT_BYTES.workshop - BUDGET + BigInt(1) } });
    const before = t.db.reservations.size;
    expect(codeOf(await failure(t.useCase.execute(workshopCommand())))).toBe('STORAGE_QUOTA_EXCEEDED');
    expect(t.db.reservations.size).toBe(before);
    expect(quotaOf(t.db, '7').reservedBytes).toBe(BigInt(0));
  });

  it('kho gần đầy → 503 STORAGE_CAPACITY_LOW, không tạo reservation', async () => {
    t.capacity.snapshot = { freeBytes: BigInt(2 * GIB), totalBytes: BigInt(100 * GIB) };
    expect(codeOf(await failure(t.useCase.execute(workshopCommand())))).toBe('STORAGE_CAPACITY_LOW');
    expect(t.db.reservations.size).toBe(0);
    expect(t.processor.processCalls).toBe(0);
  });

  it('xử lý quá hạn → 503 IMAGE_PROCESSING_UNAVAILABLE, trả ngân sách và dọn tệp', async () => {
    t.processor.outcome = 'timeout';
    expect(codeOf(await failure(t.useCase.execute(workshopCommand())))).toBe('IMAGE_PROCESSING_UNAVAILABLE');
    expect(quotaOf(t.db, '7')).toMatchObject({ usedBytes: BigInt(0), reservedBytes: BigInt(0) });
    expect([...t.db.reservations.values()][0]!.state.status).toBe('released');
    expect(t.db.images.size).toBe(0);
    expect(t.storage.files.size).toBe(0);
  });

  it('lỗi ghi tệp thứ hai: tệp thứ nhất bị xóa, ngân sách được trả, lỗi gốc được ném lại', async () => {
    t.storage.failWriteOnCall = 2;
    const error = await failure(t.useCase.execute(workshopCommand()));
    expect((error as Error).message).toBe('disk full');
    expect(t.storage.files.size).toBe(0);
    expect(quotaOf(t.db, '7').reservedBytes).toBe(BigInt(0));
    expect([...t.db.reservations.values()][0]!.state.status).toBe('released');
  });

  it('worker quá chậm (hết lease) không commit được; tệp bị dọn, ngân sách được trả', async () => {
    t.processor.onProcess = () => t.db.advance(UPLOAD_LIMITS.reservationLeaseMs + 1);
    expect(codeOf(await failure(t.useCase.execute(workshopCommand())))).toBe('INVALID_STATE');
    expect(t.db.images.size).toBe(0);
    expect(t.storage.files.size).toBe(0);
    expect(quotaOf(t.db, '7')).toMatchObject({ usedBytes: BigInt(0), reservedBytes: BigInt(0) });
  });

  it('giao dịch quyết toán lỗi giữa chừng: rollback trọn vẹn, rồi dọn và trả ngân sách đúng một lần', async () => {
    t.images.create = async () => { throw new Error('db down'); };
    const error = await failure(t.useCase.execute(workshopCommand()));
    expect((error as Error).message).toBe('db down');
    expect(t.db.images.size).toBe(0);
    expect(quotaOf(t.db, '7')).toMatchObject({ usedBytes: BigInt(0), reservedBytes: BigInt(0) });
    expect([...t.db.reservations.values()][0]!.state).toMatchObject({ status: 'released', actualBytes: null });
    expect(t.storage.files.size).toBe(0);
  });

  it('dọn thất bại: giữ cleanup_pending và KHÔNG trả ngân sách; vẫn ném lỗi gốc', async () => {
    t.processor.outcome = 'timeout';
    t.storage.failDeletePrefix = true;
    expect(codeOf(await failure(t.useCase.execute(workshopCommand())))).toBe('IMAGE_PROCESSING_UNAVAILABLE');
    expect([...t.db.reservations.values()][0]!.state.status).toBe('cleanup_pending');
    expect(quotaOf(t.db, '7').reservedBytes).toBe(BUDGET);

    // tác vụ định kỳ thử lại khi kho hồi phục: trả ngân sách đúng một lần
    t.storage.failDeletePrefix = false;
    const id = [...t.db.reservations.keys()][0]!;
    expect(await t.cleanup.abandon(id)).toBe('released');
    expect(await t.cleanup.abandon(id)).toBe('noop');
    expect(quotaOf(t.db, '7').reservedBytes).toBe(BigInt(0));
  });
});

describe('ReservationCleanupService', () => {
  it('không bao giờ đụng reservation đã committed (mất ack commit vẫn an toàn)', async () => {
    const t = setup();
    await t.useCase.execute(workshopCommand());
    const id = [...t.db.reservations.keys()][0]!;
    expect(await t.cleanup.abandon(id)).toBe('noop');
    expect(t.storage.files.size).toBe(2);
    expect(quotaOf(t.db, '7').usedBytes).toBe(BigInt(320_000));
  });
  it('reservation không tồn tại → noop', async () => {
    expect(await setup().cleanup.abandon('999')).toBe('noop');
  });
});

describe('UploadImageUseCase — Admin, phạm vi ảnh khởi tạo', () => {
  let t: ReturnType<typeof setup>;
  const seedScope = (over: Partial<{ createdBy: string; status: 'open' | 'attached' | 'expired'; expiresAt: Date }> = {}, key = KEY) => {
    t.db.scopes.set(key, { initialWorkshopKey: key, createdBy: '5', status: 'open', expiresAt: new Date('2026-11-22T09:00:00Z'), ...over });
    const id = t.db.nextId();
    t.db.quotas.set(id, { id, owner: { kind: 'scope', key }, state: { limitBytes: QUOTA_LIMIT_BYTES.initialScope, usedBytes: BigInt(0), reservedBytes: BigInt(0) } });
    return id;
  };
  beforeEach(() => { t = setup(); });

  it('thành công: kiểm tra Admin, tính vào quota của phạm vi, tiền tố riêng', async () => {
    const quotaId = seedScope();
    const result = await t.useCase.execute(scopeCommand());
    expect(t.adminCalls.length).toBeGreaterThanOrEqual(2);              // giao dịch 1 và giao dịch 2
    expect(t.db.quotas.get(quotaId)!.state.usedBytes).toBe(BigInt(320_000));
    expect(t.db.images.get(result.imageId)!.thumbnailKey).toBe(`s${KEY}/p1/thumbnail.webp`);
    expect(t.db.locks.indexOf(`scope:${KEY}`)).toBeLessThan(t.db.locks.indexOf(`quota:s${KEY}`));
  });

  it('chỉ nhận ảnh hồ sơ và context_id phải null', async () => {
    seedScope();
    expect(codeOf(await failure(t.useCase.execute(scopeCommand({ contextType: 'product' }))))).toBe('INVALID_INPUT');
    expect(codeOf(await failure(t.useCase.execute(scopeCommand({ contextId: '70' }))))).toBe('INVALID_INPUT');
  });

  it('Admin không dùng được mục tiêu hộ có sẵn để sửa nội dung', async () => {
    expect(codeOf(await failure(t.useCase.execute(scopeCommand({ target: { kind: 'workshop', workshopId: '7' } }))))).toBe('PERMISSION_DENIED');
  });

  it('khóa không tồn tại hoặc của Admin khác → 404', async () => {
    expect(codeOf(await failure(t.useCase.execute(scopeCommand())))).toBe('RESOURCE_NOT_FOUND');
    seedScope({ createdBy: '6' });
    expect(codeOf(await failure(t.useCase.execute(scopeCommand())))).toBe('RESOURCE_NOT_FOUND');
  });

  it('phạm vi hết hạn hoặc đã dùng → 422 UPLOAD_SCOPE_UNAVAILABLE', async () => {
    seedScope({ expiresAt: new Date('2026-11-21T09:59:59Z') });
    expect(codeOf(await failure(t.useCase.execute(scopeCommand())))).toBe('UPLOAD_SCOPE_UNAVAILABLE');
    t = setup();
    seedScope({ status: 'attached' });
    expect(codeOf(await failure(t.useCase.execute(scopeCommand())))).toBe('UPLOAD_SCOPE_UNAVAILABLE');
  });

  it('phạm vi hết hạn GIỮA hai giao dịch: không commit, tệp bị dọn, ngân sách được trả', async () => {
    const quotaId = seedScope({ expiresAt: new Date('2026-11-21T10:00:05Z') });
    t.processor.onProcess = () => t.db.advance(10_000);
    expect(codeOf(await failure(t.useCase.execute(scopeCommand())))).toBe('UPLOAD_SCOPE_UNAVAILABLE');
    expect(t.db.images.size).toBe(0);
    expect(t.storage.files.size).toBe(0);
    expect(t.db.quotas.get(quotaId)!.state).toMatchObject({ usedBytes: BigInt(0), reservedBytes: BigInt(0) });
  });

  it('tổng mọi phạm vi của cùng Admin không vượt 2 GiB, kể cả phạm vi khác', async () => {
    seedScope();
    const other = seedScope({}, '11111111-2222-4333-8444-555555555555');
    const row = t.db.quotas.get(other)!;
    t.db.quotas.set(other, { ...row, state: { ...row.state, usedBytes: QUOTA_LIMIT_BYTES.initialScope - BUDGET + BigInt(1) } });
    expect(codeOf(await failure(t.useCase.execute(scopeCommand())))).toBe('STORAGE_QUOTA_EXCEEDED');
    expect(t.db.reservations.size).toBe(0);
  });

  it('phiên Admin không hợp lệ (lockAndAssertAdmin ném lỗi) → từ chối, không giữ chỗ', async () => {
    seedScope();
    const denied = setup();
    denied.db.scopes = t.db.scopes; denied.db.quotas = t.db.quotas;
    const useCase = new UploadImageUseCase({
      txRunner: denied.txRunner, quotas: new InMemoryQuotaRepository(denied.db), scopes: new InMemoryScopeRepository(denied.db),
      reservations: denied.reservations, images: new InMemoryImageRepository(denied.db), processor: denied.processor,
      storage: denied.storage, capacity: new FakeCapacity(), cleanup: denied.cleanup,
      admins: { lockAndAssertAdmin: async () => { throw new BusinessRuleException('SESSION_EXPIRED'); } },
    });
    expect(codeOf(await failure(useCase.execute(scopeCommand())))).toBe('SESSION_EXPIRED');
    expect(denied.db.reservations.size).toBe(0);
  });
});

void MIB;
