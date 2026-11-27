import { beforeEach, describe, expect, it } from 'vitest';
import type { TransactionContext } from '../../../../src/common/application/ports/transaction-runner';
import type { TrustedActor } from '../../../../src/common/application/types/contract-types';
import { BusinessRuleException } from '../../../../src/common/domain/errors/business-rule.exception';
import { MediaService } from '../../../../src/modules/media/application/services/media.service';
import type { ImageContext } from '../../../../src/modules/media/public/contracts/media.contract';
import {
  FakeImageAccessResolver, InMemoryImageRepository, InMemoryMediaDb, InMemoryQuotaRepository,
  InMemoryReservationRepository, InMemoryScopeRepository, InMemoryTransactionRunner, type FakeImage,
} from '../../../support/fakes/media-in-memory';

const tx = Object.freeze({}) as TransactionContext;
const KEY = '8c1f2c7e-5f0a-4d44-9a52-6d0d6b0f1a11';
const artisan: TrustedActor = { accountId: '11', role: 'artisan', workshopId: '7', authVersion: 1, sessionId: 's' };
const otherArtisan: TrustedActor = { ...artisan, accountId: '12', workshopId: '8' };
const admin: TrustedActor = { accountId: '5', role: 'admin', workshopId: null, authVersion: 1, sessionId: 's' };
const otherAdmin: TrustedActor = { ...admin, accountId: '6' };
const buyer: TrustedActor = { accountId: '20', role: 'buyer', workshopId: null, authVersion: 1, sessionId: 's' };

function setup() {
  const db = new InMemoryMediaDb();
  const images = new InMemoryImageRepository(db);
  const quotas = new InMemoryQuotaRepository(db);
  const scopes = new InMemoryScopeRepository(db);
  const reservations = new InMemoryReservationRepository(db);
  const access = new FakeImageAccessResolver();
  const admins = { lockAndAssertAdmin: async () => undefined };
  const service = new MediaService(images, quotas, scopes, reservations, access, admins);
  const runner = new InMemoryTransactionRunner(db);

  const workshopQuota = (workshopId: string) => {
    const id = db.nextId();
    db.quotas.set(id, { id, owner: { kind: 'workshop', workshopId }, state: { limitBytes: BigInt(1e9), usedBytes: BigInt(0), reservedBytes: BigInt(0) } });
    return id;
  };
  const scopeQuota = (key: string, over: Partial<{ createdBy: string; status: 'open' | 'attached' | 'expired'; expiresAt: Date }> = {}) => {
    db.scopes.set(key, { initialWorkshopKey: key, createdBy: '5', status: 'open', expiresAt: new Date('2026-11-22T10:00:00Z'), attachedWorkshopId: null, ...over });
    const id = db.nextId();
    db.quotas.set(id, { id, owner: { kind: 'scope', key }, state: { limitBytes: BigInt(1e9), usedBytes: BigInt(500), reservedBytes: BigInt(0) } });
    return id;
  };
  const addImage = (over: Partial<FakeImage> & { quotaId: string }): FakeImage => {
    const id = db.nextId();
    const image: FakeImage = {
      id, uploadedBy: '11', contextType: 'journal_entry', contextId: null, thumbnailKey: `p/${id}/t.webp`, displayKey: `p/${id}/d.webp`,
      thumbnailSizeBytes: BigInt(10), displaySizeBytes: BigInt(100), reservationId: `r${id}`, width: 10, height: 10,
      unreferencedAt: db.now, isAttached: false, storageState: 'ready', nullableUnreferencedAt: db.now, ...over,
    };
    db.images.set(id, image);
    return image;
  };
  return { db, service, runner, access, workshopQuota, scopeQuota, addImage, reservations };
}

const codeOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof BusinessRuleException ? e.code : `OTHER:${String(e)}`; }
  return 'NO_ERROR';
};
const replace = (s: ReturnType<typeof setup>, contextType: ImageContext, contextId: string, imageIds: string[], actor = artisan, workshopId = '7') =>
  s.service.replaceImages({ contextType, contextId, workshopId, imageIds, actor }, tx);

describe('MediaService.replaceImages', () => {
  let s: ReturnType<typeof setup>;
  let quota: string;
  beforeEach(() => { s = setup(); quota = s.workshopQuota('7'); });

  it('gắn ảnh mới: cố định context_id, bỏ mốc hết hạn', async () => {
    const a = s.addImage({ quotaId: quota });
    await replace(s, 'journal_entry', '70', [a.id]);
    expect(s.db.images.get(a.id)).toMatchObject({ isAttached: true, contextId: '70', nullableUnreferencedAt: null });
  });

  it('thay danh sách: gắn ảnh mới, gỡ ảnh bị bỏ (đặt mốc 24 giờ, giữ context_id), giữ ảnh còn lại', async () => {
    const [a, b, c] = [s.addImage({ quotaId: quota }), s.addImage({ quotaId: quota }), s.addImage({ quotaId: quota })];
    await replace(s, 'journal_entry', '70', [a.id, b.id]);
    s.db.advance(3_600_000);
    await replace(s, 'journal_entry', '70', [b.id, c.id]);
    expect(s.db.images.get(a.id)).toMatchObject({ isAttached: false, contextId: '70', nullableUnreferencedAt: s.db.now });
    expect(s.db.images.get(b.id)).toMatchObject({ isAttached: true, contextId: '70' });
    expect(s.db.images.get(c.id)).toMatchObject({ isAttached: true, contextId: '70' });
  });

  it('ảnh đã gỡ có thể gắn lại vào CHÍNH đối tượng đó', async () => {
    const a = s.addImage({ quotaId: quota });
    await replace(s, 'journal_entry', '70', [a.id]);
    await replace(s, 'journal_entry', '70', []);
    expect(s.db.images.get(a.id)!.isAttached).toBe(false);
    await replace(s, 'journal_entry', '70', [a.id]);
    expect(s.db.images.get(a.id)).toMatchObject({ isAttached: true, nullableUnreferencedAt: null });
  });

  it('không dùng cùng một ảnh cho đối tượng khác, kể cả khi đã gỡ khỏi đối tượng cũ', async () => {
    const a = s.addImage({ quotaId: quota });
    await replace(s, 'journal_entry', '70', [a.id]);
    expect(await codeOf(replace(s, 'journal_entry', '71', [a.id]))).toBe('IMAGE_CONTEXT_MISMATCH');
    await replace(s, 'journal_entry', '70', []);
    expect(await codeOf(replace(s, 'journal_entry', '71', [a.id]))).toBe('IMAGE_CONTEXT_MISMATCH');
  });

  it('sai ngữ cảnh, ảnh của hộ khác, ảnh không tồn tại hoặc đang bị dọn', async () => {
    const wrongType = s.addImage({ quotaId: quota, contextType: 'product' });
    expect(await codeOf(replace(s, 'journal_entry', '70', [wrongType.id]))).toBe('IMAGE_CONTEXT_MISMATCH');
    const foreign = s.addImage({ quotaId: s.workshopQuota('8') });
    expect(await codeOf(replace(s, 'journal_entry', '70', [foreign.id]))).toBe('IMAGE_CONTEXT_MISMATCH');
    expect(await codeOf(replace(s, 'journal_entry', '70', ['99999']))).toBe('RESOURCE_NOT_FOUND');
    const dying = s.addImage({ quotaId: quota, storageState: 'deleting' });
    expect(await codeOf(replace(s, 'journal_entry', '70', [dying.id]))).toBe('RESOURCE_NOT_FOUND');
  });

  it('tối đa 10 ảnh cho mốc nhật ký; ID trùng bị từ chối', async () => {
    const ids = Array.from({ length: 11 }, () => s.addImage({ quotaId: quota }).id);
    expect(await codeOf(replace(s, 'journal_entry', '70', ids))).toBe('INVALID_INPUT');
    expect(await codeOf(replace(s, 'journal_entry', '70', [ids[0]!, ids[0]!]))).toBe('INVALID_INPUT');
    expect(await codeOf(replace(s, 'journal_entry', '70', ids.slice(0, 10)))).toBe('NO_ERROR');
  });

  it('chỉ Artisan đúng hộ mới thay ảnh', async () => {
    const a = s.addImage({ quotaId: quota });
    expect(await codeOf(replace(s, 'journal_entry', '70', [a.id], otherArtisan))).toBe('PERMISSION_DENIED');
    expect(await codeOf(replace(s, 'journal_entry', '70', [a.id], admin))).toBe('PERMISSION_DENIED');
    expect(await codeOf(replace(s, 'journal_entry', '70', [a.id], buyer))).toBe('PERMISSION_DENIED');
    expect(s.db.images.get(a.id)!.isAttached).toBe(false);
  });

  it('khóa đối tượng TRƯỚC, rồi ảnh theo ID tăng dần', async () => {
    const a = s.addImage({ quotaId: quota });
    s.db.locks.length = 0;
    await replace(s, 'journal_entry', '70', [a.id]);
    expect(s.db.locks).toEqual(['context:journal_entry:70', `images:${a.id}`]);
  });

  it('khóa ảnh theo ID tăng dần, gồm cả ảnh đang gắn lẫn ảnh mới', async () => {
    const [a, b, c] = [s.addImage({ quotaId: quota }), s.addImage({ quotaId: quota }), s.addImage({ quotaId: quota })];
    await replace(s, 'journal_entry', '70', [c.id, a.id]);
    s.db.locks.length = 0;
    await replace(s, 'journal_entry', '70', [b.id, a.id]);
    const ids = s.db.locks.find(l => l.startsWith('images:'))!.slice(7).split(',');
    expect(ids).toEqual([a.id, b.id, c.id]);
  });
});

describe('MediaService.retainHistoryImages', () => {
  it('ghi ảnh hiện hành vào lịch sử theo thứ tự; từ chối ảnh không thuộc mốc nhật ký đó', async () => {
    const s = setup();
    const quota = s.workshopQuota('7');
    const [a, b] = [s.addImage({ quotaId: quota }), s.addImage({ quotaId: quota })];
    await replace(s, 'journal_entry', '70', [a.id, b.id]);
    s.db.historyEntries.set('900', '70');
    await s.service.retainHistoryImages({ historyId: '900', entryId: '70', imageIds: [b.id, a.id] }, tx);
    expect(s.db.historyLinks.map(l => [l.imageId, l.position])).toEqual([[b.id, 0], [a.id, 1]]);

    s.db.historyEntries.set('901', '70');
    const other = s.addImage({ quotaId: quota });
    expect(await codeOf(s.service.retainHistoryImages({ historyId: '901', entryId: '70', imageIds: [other.id] }, tx))).toBe('IMAGE_CONTEXT_MISMATCH');
    expect(await codeOf(s.service.retainHistoryImages({ historyId: '901', entryId: '70', imageIds: ['9999'] }, tx))).toBe('RESOURCE_NOT_FOUND');
    expect(await codeOf(s.service.retainHistoryImages({ historyId: '901', entryId: '70', imageIds: [a.id, a.id] }, tx))).toBe('INVALID_INPUT');
  });
  it('từ chối history không có ảnh theo quy tắc nhật ký', async () => {
    const s = setup();
    expect(await codeOf(s.service.retainHistoryImages({ historyId: '900', entryId: '70', imageIds: [] }, tx))).toBe('INVALID_INPUT');
    expect(s.db.historyLinks).toHaveLength(0);
  });

  it('từ chối history thuộc nhật ký khác', async () => {
    const s = setup();
    const quota = s.workshopQuota('7');
    const image = s.addImage({ quotaId: quota, contextType: 'journal_entry', contextId: '70', isAttached: true });
    s.db.historyEntries.set('900', '71');
    expect(await codeOf(s.service.retainHistoryImages({ historyId: '900', entryId: '70', imageIds: [image.id] }, tx)))
      .toBe('IMAGE_CONTEXT_MISMATCH');
  });
});

describe('MediaService.attachInitialWorkshopScope', () => {
  let s: ReturnType<typeof setup>;
  let quota: string;
  const attach = (imageIds: string[], actor = admin, key = KEY) =>
    s.service.attachInitialWorkshopScope({ initialWorkshopKey: key, workshopId: '7', imageIds, actor }, tx);
  const scopeImage = (over: Partial<FakeImage> = {}) => s.addImage({ quotaId: quota, contextType: 'workshop_profile', uploadedBy: '5', ...over });
  beforeEach(() => { s = setup(); quota = s.scopeQuota(KEY); });

  it('chuyển CHÍNH dòng quota sang hộ, đánh dấu scope attached, gắn ảnh được chọn với context_id = ID hộ', async () => {
    const [chosen, unchosen] = [scopeImage(), scopeImage()];
    await attach([chosen.id]);
    expect(s.db.quotas.get(quota)).toMatchObject({ owner: { kind: 'workshop', workshopId: '7' }, state: { usedBytes: BigInt(500) } });
    expect(s.db.scopes.get(KEY)).toMatchObject({ status: 'attached', attachedWorkshopId: '7' });
    expect(s.db.images.get(chosen.id)).toMatchObject({ isAttached: true, contextId: '7', nullableUnreferencedAt: null });
    // Ảnh không chọn vẫn thuộc quota của hộ mới, chưa gắn (chỉ dọn khi hết hạn)
    expect(s.db.images.get(unchosen.id)).toMatchObject({ isAttached: false, quotaId: quota });
    expect(s.db.workshopOfQuota(unchosen.quotaId)).toBe('7');
  });

  it('không có ảnh: vẫn chuyển quota và đóng phạm vi', async () => {
    await attach([]);
    expect(s.db.scopes.get(KEY)!.status).toBe('attached');
    expect(s.db.quotas.get(quota)!.owner).toEqual({ kind: 'workshop', workshopId: '7' });
  });

  it('khóa không tồn tại hoặc của Admin khác → 404; hết hạn hoặc đã dùng → 422', async () => {
    expect(await codeOf(attach([], admin, 'khong-ton-tai'))).toBe('RESOURCE_NOT_FOUND');
    expect(await codeOf(attach([], otherAdmin))).toBe('RESOURCE_NOT_FOUND');
    s.db.advance(25 * 3_600_000);
    expect(await codeOf(attach([]))).toBe('UPLOAD_SCOPE_UNAVAILABLE');
    const s2 = setup(); s2.scopeQuota(KEY, { status: 'attached' });
    expect(await codeOf(s2.service.attachInitialWorkshopScope({ initialWorkshopKey: KEY, workshopId: '7', imageIds: [], actor: admin }, tx))).toBe('UPLOAD_SCOPE_UNAVAILABLE');
  });

  it('còn upload hoặc dọn đang xử lý → 409 UPLOAD_SCOPE_BUSY, không đổi gì', async () => {
    for (const status of ['reserved', 'cleanup_pending'] as const) {
      const id = s.db.nextId();
      s.db.reservations.set(id, { id, quotaId: quota, uploadedBy: '5', contextType: 'workshop_profile', contextId: null, storagePrefix: `s/${id}/`,
        state: { status, budgetBytes: BigInt(1), actualBytes: null, expiresAt: s.db.now } });
      expect(await codeOf(attach([]))).toBe('UPLOAD_SCOPE_BUSY');
      s.db.reservations.delete(id);
    }
    expect(s.db.scopes.get(KEY)!.status).toBe('open');
    expect(s.db.quotas.get(quota)!.owner).toEqual({ kind: 'scope', key: KEY });
  });

  it('ảnh phải thuộc đúng quota phạm vi, là ảnh hồ sơ, chưa gắn, còn sẵn sàng', async () => {
    const foreignQuota = s.scopeQuota('11111111-2222-4333-8444-555555555555');
    const cases: Array<[string, FakeImage, string]> = [
      ['quota khác', s.addImage({ quotaId: foreignQuota, contextType: 'workshop_profile' }), 'IMAGE_CONTEXT_MISMATCH'],
      ['sai ngữ cảnh', scopeImage({ contextType: 'product' }), 'IMAGE_CONTEXT_MISMATCH'],
      ['đã gắn', scopeImage({ isAttached: true, contextId: '99' }), 'IMAGE_CONTEXT_MISMATCH'],
      ['đã có context_id', scopeImage({ contextId: '99' }), 'IMAGE_CONTEXT_MISMATCH'],
      ['đang bị dọn', scopeImage({ storageState: 'deleting' }), 'IMAGE_CONTEXT_MISMATCH'],
    ];
    for (const [, image, code] of cases) expect(await codeOf(attach([image.id]))).toBe(code);
    expect(await codeOf(attach(['99999']))).toBe('RESOURCE_NOT_FOUND');
    expect(s.db.scopes.get(KEY)!.status).toBe('open');
  });

  it('tối đa 10 ảnh hồ sơ, không trùng; chỉ Admin được gọi', async () => {
    const ids = Array.from({ length: 11 }, () => scopeImage().id);
    expect(await codeOf(attach(ids))).toBe('INVALID_INPUT');
    expect(await codeOf(attach([ids[0]!, ids[0]!]))).toBe('INVALID_INPUT');
    expect(await codeOf(attach([], artisan))).toBe('PERMISSION_DENIED');
  });

  it('lỗi giữa chừng: giao dịch của workflow rollback nên quota và phạm vi giữ nguyên', async () => {
    const good = scopeImage();
    const bad = scopeImage({ contextType: 'product' });
    await expect(s.runner.run(() => attach([good.id, bad.id]))).rejects.toBeInstanceOf(BusinessRuleException);
    expect(s.db.quotas.get(quota)!.owner).toEqual({ kind: 'scope', key: KEY });
    expect(s.db.images.get(good.id)!.isAttached).toBe(false);
  });
});

describe('MediaService.getImageDto', () => {
  let s: ReturnType<typeof setup>;
  let image: FakeImage;
  const dto = (over: Partial<Parameters<MediaService['getImageDto']>[0]> = {}) =>
    s.service.getImageDto({ imageId: image.id, contextType: 'product', contextId: '70', historyId: null, actorOrNull: artisan, ...over }, tx);
  beforeEach(async () => {
    s = setup();
    image = s.addImage({ quotaId: s.workshopQuota('7'), contextType: 'product' });
    await replace(s, 'product', '70', [image.id]);
  });

  it('ảnh hiện hành đủ quyền: trả URL qua cổng media', async () => {
    s.access.currentAllowed.add(`product:70:${image.id}:11`);
    expect(await dto()).toEqual({
      id: image.id,
      thumbnail_url: `/api/v1/media/current/product/70/images/${image.id}/thumbnail`,
      display_url: `/api/v1/media/current/product/70/images/${image.id}/display`,
    });
    expect(s.access.calls[0]).toMatchObject({ kind: 'current', input: { workshopId: '7', contextId: '70' } });
  });

  it('không đủ quyền, sai đối tượng hoặc ảnh không tồn tại → null', async () => {
    expect(await dto()).toBeNull();
    s.access.currentAllowed.add(`product:70:${image.id}:11`);
    expect(await dto({ contextId: '71' })).toBeNull();
    expect(await dto({ contextType: 'journal_entry' })).toBeNull();
    expect(await dto({ imageId: '99999' })).toBeNull();
    expect(await dto({ actorOrNull: null })).toBeNull();
  });

  it('ảnh đã gỡ khỏi đối tượng không còn là ảnh hiện hành, dù người đọc từng có quyền', async () => {
    s.access.currentAllowed.add(`product:70:${image.id}:11`);
    await replace(s, 'product', '70', []);
    expect(await dto()).toBeNull();
  });

  it('ảnh lịch sử: cần liên kết lịch sử đúng mục nhật ký và quyền từ Traceability', async () => {
    const quota = [...s.db.quotas.keys()][0]!;
    const h = s.addImage({ quotaId: quota, contextType: 'journal_entry' });
    await replace(s, 'journal_entry', '80', [h.id]);
    s.db.historyEntries.set('900', '80');
    await s.service.retainHistoryImages({ historyId: '900', entryId: '80', imageIds: [h.id] }, tx);
    const ask = (over = {}) => s.service.getImageDto({ imageId: h.id, contextType: 'journal_entry', contextId: '80', historyId: '900', actorOrNull: artisan, ...over }, tx);
    expect(await ask()).toBeNull();
    s.access.historyAllowed.add(`900:${h.id}:11`);
    expect(await ask()).toEqual({
      id: h.id,
      thumbnail_url: `/api/v1/media/history/900/images/${h.id}/thumbnail`,
      display_url: `/api/v1/media/history/900/images/${h.id}/display`,
    });
    expect(await ask({ contextId: '81' })).toBeNull();
    expect(await ask({ contextType: 'product' })).toBeNull();
    expect(await ask({ historyId: '901' })).toBeNull();
  });
});
