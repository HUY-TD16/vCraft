import { beforeEach, describe, expect, it } from 'vitest';
import type { TrustedActor } from '../../../../src/common/application/types/contract-types';
import { BusinessRuleException } from '../../../../src/common/domain/errors/business-rule.exception';
import {
  GetImageUseCase, type GetImageCommand,
} from '../../../../src/modules/media/application/use-cases/images/get-image.use-case';
import { CreateUploadScopeUseCase } from '../../../../src/modules/media/application/use-cases/uploads/create-upload-scope.use-case';
import { MediaService } from '../../../../src/modules/media/application/services/media.service';
import { parseImageVariant } from '../../../../src/modules/media/domain/value-objects/image-variant';
import { canReadPendingImage } from '../../../../src/modules/media/domain/policies/image-reading.policy';
import { QUOTA_LIMIT_BYTES } from '../../../../src/modules/media/domain/value-objects/image-limits';
import type { TransactionContext } from '../../../../src/common/application/types/../ports/transaction-runner';
import {
  FakeImageAccessResolver, InMemoryImageRepository, InMemoryMediaDb, InMemoryQuotaRepository,
  InMemoryReservationRepository, InMemoryScopeRepository, InMemoryTransactionRunner, type FakeImage,
} from '../../../support/fakes/media-in-memory';

const tx = Object.freeze({}) as TransactionContext;
const artisan: TrustedActor = { accountId: '11', role: 'artisan', workshopId: '7', authVersion: 1, sessionId: 's' };
const stranger: TrustedActor = { ...artisan, accountId: '99', workshopId: '9' };
const admin: TrustedActor = { accountId: '5', role: 'admin', workshopId: null, authVersion: 1, sessionId: 's' };
const buyer: TrustedActor = { accountId: '20', role: 'buyer', workshopId: null, authVersion: 1, sessionId: 's' };
const HOUR = 3_600_000;

const codeOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof BusinessRuleException ? e.code : `OTHER:${String(e)}`; }
  return 'NO_ERROR';
};

function setup() {
  const db = new InMemoryMediaDb();
  const runner = new InMemoryTransactionRunner(db);
  const images = new InMemoryImageRepository(db);
  const reservations = new InMemoryReservationRepository(db);
  const scopes = new InMemoryScopeRepository(db);
  const access = new FakeImageAccessResolver();
  const getImage = new GetImageUseCase({ txRunner: runner, images, reservations, access });
  const adminCalls: TrustedActor[] = [];
  const createScope = new CreateUploadScopeUseCase({
    txRunner: runner, scopes, reservations, admins: { lockAndAssertAdmin: async (a) => { adminCalls.push(a); } },
  });
  const quotaId = db.nextId();
  db.quotas.set(quotaId, { id: quotaId, owner: { kind: 'workshop', workshopId: '7' }, state: { limitBytes: BigInt(1e9), usedBytes: BigInt(0), reservedBytes: BigInt(0) } });
  const addImage = (over: Partial<FakeImage> = {}): FakeImage => {
    const id = db.nextId();
    const image: FakeImage = {
      id, uploadedBy: '11', contextType: 'product', contextId: null, thumbnailKey: `w7/${id}/thumbnail.webp`, displayKey: `w7/${id}/display.webp`,
      thumbnailSizeBytes: BigInt(11), displaySizeBytes: BigInt(222), quotaId, reservationId: `r${id}`, width: 1, height: 1,
      unreferencedAt: db.now, isAttached: false, storageState: 'ready', nullableUnreferencedAt: db.now, ...over,
    };
    db.images.set(id, image);
    return image;
  };
  const service = new MediaService({ images, quotas: new InMemoryQuotaRepository(db), scopes, reservations, access });
  return { db, getImage, createScope, adminCalls, access, addImage, service };
}

describe('parseImageVariant và canReadPendingImage', () => {
  it('variant chỉ nhận thumbnail hoặc display', () => {
    expect(parseImageVariant('thumbnail')).toBe('thumbnail');
    expect(parseImageVariant('display')).toBe('display');
    for (const bad of ['original', 'Thumbnail', '', '../display', 'display ']) expect(parseImageVariant(bad)).toBeNull();
  });
  it('ảnh chờ gắn: ranh giới đúng 24 giờ', () => {
    const base = { uploadedBy: '11', contextType: 'product', contextId: null, isAttached: false, storageState: 'ready', unreferencedAt: new Date('2026-11-21T10:00:00Z') } as const;
    expect(canReadPendingImage(base, '11', false, new Date('2026-11-22T09:59:59.999Z'))).toBe(true);
    expect(canReadPendingImage(base, '11', false, new Date('2026-11-22T10:00:00Z'))).toBe(false);
  });
});

describe('GetImageUseCase', () => {
  let s: ReturnType<typeof setup>;
  const get = (command: Partial<GetImageCommand> & Pick<GetImageCommand, 'source'>) =>
    s.getImage.execute({ actorOrNull: artisan, variant: 'display', ...command });
  beforeEach(() => { s = setup(); });

  describe('ảnh chờ gắn (pending)', () => {
    it('người tải đọc được; trả đúng khóa và kích thước theo variant', async () => {
      const image = s.addImage();
      expect(await get({ source: { kind: 'pending', imageId: image.id }, variant: 'thumbnail' }))
        .toEqual({ key: `w7/${image.id}/thumbnail.webp`, sizeBytes: BigInt(11), contentType: 'image/webp' });
      expect(await get({ source: { kind: 'pending', imageId: image.id }, variant: 'display' }))
        .toEqual({ key: `w7/${image.id}/display.webp`, sizeBytes: BigInt(222), contentType: 'image/webp' });
    });

    it.each([
      ['người khác', (i: FakeImage) => ({ actor: stranger, image: i })],
      ['Admin không phải người tải', (i: FakeImage) => ({ actor: admin, image: i })],
      ['chưa đăng nhập', (i: FakeImage) => ({ actor: null, image: i })],
    ])('%s → RESOURCE_NOT_FOUND', async (_name, build) => {
      const { actor, image } = build(s.addImage());
      expect(await codeOf(get({ actorOrNull: actor, source: { kind: 'pending', imageId: image.id } }))).toBe('RESOURCE_NOT_FOUND');
    });

    it('đã gắn, hết 24 giờ, có lịch sử, đang bị dọn hoặc không tồn tại → 404', async () => {
      const attached = s.addImage({ isAttached: true, contextId: '70' });
      expect(await codeOf(get({ source: { kind: 'pending', imageId: attached.id } }))).toBe('RESOURCE_NOT_FOUND');
      const dying = s.addImage({ storageState: 'deleting' });
      expect(await codeOf(get({ source: { kind: 'pending', imageId: dying.id } }))).toBe('RESOURCE_NOT_FOUND');
      const withHistory = s.addImage();
      s.db.historyLinks.push({ historyId: '900', imageId: withHistory.id, entryId: '80', position: 0 });
      expect(await codeOf(get({ source: { kind: 'pending', imageId: withHistory.id } }))).toBe('RESOURCE_NOT_FOUND');
      expect(await codeOf(get({ source: { kind: 'pending', imageId: '99999' } }))).toBe('RESOURCE_NOT_FOUND');
      const fresh = s.addImage();
      s.db.advance(24 * HOUR);
      expect(await codeOf(get({ source: { kind: 'pending', imageId: fresh.id } }))).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('ảnh hiện hành (current)', () => {
    it('hỏi module chủ đối tượng; đủ quyền thì trả tệp', async () => {
      const image = s.addImage({ isAttached: true, contextId: '70' });
      s.access.currentAllowed.add(`product:70:${image.id}:anon`);
      const result = await get({ actorOrNull: null, source: { kind: 'current', contextType: 'product', contextId: '70', imageId: image.id } });
      expect(result.key).toBe(`w7/${image.id}/display.webp`);
      expect(s.access.calls[0]).toMatchObject({ kind: 'current', input: { workshopId: '7', contextId: '70', imageId: image.id } });
    });

    it('khách vãng lai bị từ chối khi module chủ không cho phép (ảnh riêng tư)', async () => {
      const image = s.addImage({ isAttached: true, contextId: '70' });
      expect(await codeOf(get({ actorOrNull: null, source: { kind: 'current', contextType: 'product', contextId: '70', imageId: image.id } }))).toBe('RESOURCE_NOT_FOUND');
    });

    it('sai đối tượng, sai ngữ cảnh hoặc ảnh đã gỡ → 404 và KHÔNG hỏi module chủ', async () => {
      const image = s.addImage({ isAttached: true, contextId: '70' });
      s.access.currentAllowed.add(`product:71:${image.id}:11`);
      expect(await codeOf(get({ source: { kind: 'current', contextType: 'product', contextId: '71', imageId: image.id } }))).toBe('RESOURCE_NOT_FOUND');
      expect(await codeOf(get({ source: { kind: 'current', contextType: 'journal_entry', contextId: '70', imageId: image.id } }))).toBe('RESOURCE_NOT_FOUND');
      const detached = s.addImage({ isAttached: false, contextId: '70' });
      s.access.currentAllowed.add(`product:70:${detached.id}:11`);
      expect(await codeOf(get({ source: { kind: 'current', contextType: 'product', contextId: '70', imageId: detached.id } }))).toBe('RESOURCE_NOT_FOUND');
      expect(s.access.calls).toHaveLength(0);
    });
  });

  describe('ảnh lịch sử (history)', () => {
    it('cần liên kết lịch sử và quyền từ Traceability; Buyer bị từ chối', async () => {
      const image = s.addImage({ contextType: 'journal_entry', isAttached: true, contextId: '80' });
      s.db.historyLinks.push({ historyId: '900', imageId: image.id, entryId: '80', position: 0 });
      const source = { kind: 'history', historyId: '900', imageId: image.id } as const;
      expect(await codeOf(get({ source }))).toBe('RESOURCE_NOT_FOUND');
      s.access.historyAllowed.add(`900:${image.id}:11`);
      expect((await get({ source })).key).toBe(`w7/${image.id}/display.webp`);
      expect(s.access.calls.at(-1)).toMatchObject({ kind: 'history', input: { entryId: '80', historyId: '900', imageId: image.id } });
      expect(await codeOf(get({ actorOrNull: buyer, source }))).toBe('RESOURCE_NOT_FOUND');
    });

    it('không có liên kết (historyId/ảnh không khớp) → 404 và KHÔNG hỏi module chủ', async () => {
      const image = s.addImage({ contextType: 'journal_entry', isAttached: true, contextId: '80' });
      s.db.historyLinks.push({ historyId: '900', imageId: image.id, entryId: '80', position: 0 });
      s.access.historyAllowed.add(`901:${image.id}:11`);
      const before = s.access.calls.length;
      expect(await codeOf(get({ source: { kind: 'history', historyId: '901', imageId: image.id } }))).toBe('RESOURCE_NOT_FOUND');
      expect(s.access.calls.length).toBe(before);
    });
  });
});

describe('CreateUploadScopeUseCase', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it('tạo phạm vi hết hạn sau 24 giờ cùng quota riêng 2 GiB; khóa Account Admin trước', async () => {
    const result = await s.createScope.execute({ actor: admin });
    expect(result.expiresAt.toISOString()).toBe('2026-11-22T10:00:00.000Z');
    expect(result.initialWorkshopKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.adminCalls).toEqual([admin]);
    const quota = [...s.db.quotas.values()].find(q => q.owner.kind === 'scope');
    expect(quota!.state.limitBytes).toBe(QUOTA_LIMIT_BYTES.initialScope);
    expect(s.db.scopes.get(result.initialWorkshopKey)).toMatchObject({ createdBy: '5', status: 'open' });
  });

  it('mỗi lần tạo ra một khóa khác nhau; tối đa 3 phạm vi còn hiệu lực mỗi Admin', async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 3; i++) keys.add((await s.createScope.execute({ actor: admin })).initialWorkshopKey);
    expect(keys.size).toBe(3);
    expect(await codeOf(s.createScope.execute({ actor: admin }))).toBe('UPLOAD_SCOPE_LIMIT_EXCEEDED');
    expect(s.db.scopes.size).toBe(3);
  });

  it('phạm vi hết hạn hoặc đã dùng không tính vào giới hạn; Admin khác có hạn mức riêng', async () => {
    const first = await s.createScope.execute({ actor: admin });
    await s.createScope.execute({ actor: admin });
    await s.createScope.execute({ actor: admin });
    expect(await codeOf(s.createScope.execute({ actor: admin }))).toBe('UPLOAD_SCOPE_LIMIT_EXCEEDED');
    expect(await codeOf(s.createScope.execute({ actor: { ...admin, accountId: '6' } }))).toBe('NO_ERROR');
    s.db.scopes.set(first.initialWorkshopKey, { ...s.db.scopes.get(first.initialWorkshopKey)!, status: 'attached', attachedWorkshopId: '7' });
    expect(await codeOf(s.createScope.execute({ actor: admin }))).toBe('NO_ERROR');
    s.db.advance(25 * HOUR);
    expect(await codeOf(s.createScope.execute({ actor: admin }))).toBe('NO_ERROR'); // tất cả đã hết hạn
  });

  it('chỉ Admin; phiên Admin không hợp lệ thì không tạo gì', async () => {
    expect(await codeOf(s.createScope.execute({ actor: artisan }))).toBe('PERMISSION_DENIED');
    expect(await codeOf(s.createScope.execute({ actor: buyer }))).toBe('PERMISSION_DENIED');
    const denied = new CreateUploadScopeUseCase({
      txRunner: new InMemoryTransactionRunner(s.db), scopes: new InMemoryScopeRepository(s.db), reservations: new InMemoryReservationRepository(s.db),
      admins: { lockAndAssertAdmin: async () => { throw new BusinessRuleException('SESSION_EXPIRED'); } },
    });
    expect(await codeOf(denied.execute({ actor: admin }))).toBe('SESSION_EXPIRED');
    expect(s.db.scopes.size).toBe(0);
  });

  it('phạm vi vừa tạo dùng được ngay cho attachInitialWorkshopScope (liên thông hai use case)', async () => {
    const { initialWorkshopKey } = await s.createScope.execute({ actor: admin });
    const quota = [...s.db.quotas.values()].find(q => q.owner.kind === 'scope' && q.owner.key === initialWorkshopKey)!;
    const image = s.addImage({ contextType: 'workshop_profile', uploadedBy: '5', quotaId: quota.id });
    await s.service.attachInitialWorkshopScope({ initialWorkshopKey, workshopId: '7', imageIds: [image.id], actor: admin }, tx);
    expect(s.db.scopes.get(initialWorkshopKey)!.status).toBe('attached');
    expect(s.db.images.get(image.id)).toMatchObject({ isAttached: true, contextId: '7' });
  });
});
