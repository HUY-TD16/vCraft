import { describe, expect, it } from 'vitest';
import { BusinessRuleException } from '../../../../src/common/domain/errors/business-rule.exception';
import { IMAGE_LIMITS, MIB } from '../../../../src/modules/media/domain/value-objects/image-limits';
import { MAX_IMAGES_PER_OBJECT, isImageContextType } from '../../../../src/modules/media/domain/value-objects/image-context';
import { fitWithin, planVariants } from '../../../../src/modules/media/domain/value-objects/image-variants';
import { assertCanUpload } from '../../../../src/modules/media/domain/policies/upload-permission.policy';
import { assertAcceptableImage } from '../../../../src/modules/media/domain/policies/image-validation.policy';
import {
  assertImagesAttachable, planReplacement, type ImageForAttach,
} from '../../../../src/modules/media/domain/policies/image-attachment.policy';
import {
  releaseReservation, releaseUsedBytes, reserveBytes, settleReservation, type StorageQuotaState,
} from '../../../../src/modules/media/domain/entities/storage-quota';
import {
  commitReservation, confirmReleased, markCleanupPending, needsCleanup, type UploadReservationState,
} from '../../../../src/modules/media/domain/entities/upload-reservation';

const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof BusinessRuleException ? e.code : `OTHER:${(e as Error).name}`; }
  return 'NO_ERROR';
};

describe('image-context', () => {
  it('nhận đúng 4 ngữ cảnh', () => {
    expect(isImageContextType('product')).toBe(true);
    expect(isImageContextType('avatar')).toBe(false);
    expect(isImageContextType(null)).toBe(false);
  });
  it('giới hạn số ảnh theo API 8.1', () => {
    expect(MAX_IMAGES_PER_OBJECT).toEqual({ product: 10, journal_entry: 10, workshop_profile: 10, certificate: 20 });
  });
});

describe('image-variants', () => {
  it('không phóng to ảnh nhỏ', () => {
    expect(fitWithin({ width: 200, height: 100 }, 320)).toEqual({ width: 200, height: 100 });
  });
  it('thu nhỏ giữ tỉ lệ, cạnh dài đúng bằng maxEdge', () => {
    expect(fitWithin({ width: 4000, height: 3000 }, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin({ width: 3000, height: 4000 }, 320)).toEqual({ width: 240, height: 320 });
  });
  it('ảnh cực dẹt vẫn có cạnh ngắn ≥ 1px', () => {
    expect(fitWithin({ width: 20000, height: 1 }, 320)).toEqual({ width: 320, height: 1 });
  });
  it('planVariants cho cả thumbnail và display', () => {
    expect(planVariants({ width: 4000, height: 3000 })).toEqual({
      thumbnail: { width: 320, height: 240 }, display: { width: 1600, height: 1200 },
    });
  });
  it('từ chối kích thước không hợp lệ', () => {
    expect(() => fitWithin({ width: 0, height: 10 }, 320)).toThrow(RangeError);
  });
});

describe('upload-permission', () => {
  const own = { kind: 'workshop', workshopId: '7' } as const;
  it('Buyer không được upload', () => {
    expect(code(() => assertCanUpload({ role: 'buyer', workshopId: null }, 'product', own))).toBe('PERMISSION_DENIED');
  });
  it('Artisan chỉ upload cho hộ của mình', () => {
    expect(code(() => assertCanUpload({ role: 'artisan', workshopId: '7' }, 'product', own))).toBe('NO_ERROR');
    expect(code(() => assertCanUpload({ role: 'artisan', workshopId: '8' }, 'product', own))).toBe('PERMISSION_DENIED');
    expect(code(() => assertCanUpload({ role: 'artisan', workshopId: null }, 'product', own))).toBe('PERMISSION_DENIED');
  });
  it('Artisan không dùng phạm vi khởi tạo', () => {
    expect(code(() => assertCanUpload({ role: 'artisan', workshopId: '7' }, 'workshop_profile',
      { kind: 'initial_scope', initialWorkshopKey: 'k' }))).toBe('PERMISSION_DENIED');
  });
  it('Admin chỉ tải ảnh hồ sơ trong phạm vi khởi tạo', () => {
    const scope = { kind: 'initial_scope', initialWorkshopKey: 'k' } as const;
    expect(code(() => assertCanUpload({ role: 'admin', workshopId: null }, 'workshop_profile', scope))).toBe('NO_ERROR');
    expect(code(() => assertCanUpload({ role: 'admin', workshopId: null }, 'product', scope))).toBe('INVALID_INPUT');
    expect(code(() => assertCanUpload({ role: 'admin', workshopId: null }, 'workshop_profile', own))).toBe('PERMISSION_DENIED');
  });
});

describe('image-validation', () => {
  const ok = { format: 'jpeg', width: 4000, height: 3000 };
  it('chấp nhận ảnh hợp lệ', () => {
    expect(code(() => assertAcceptableImage(1 * MIB, ok))).toBe('NO_ERROR');
    expect(code(() => assertAcceptableImage(IMAGE_LIMITS.maxFileBytes, { ...ok, format: 'webp', pages: 1 }))).toBe('NO_ERROR');
  });
  it.each([
    ['quá 5 MiB', () => assertAcceptableImage(IMAGE_LIMITS.maxFileBytes + 1, ok), 'file_too_large'],
    ['tệp rỗng', () => assertAcceptableImage(0, ok), 'file_too_large'],
    ['định dạng gif', () => assertAcceptableImage(1000, { ...ok, format: 'gif' }), 'unsupported_format'],
    ['không rõ định dạng', () => assertAcceptableImage(1000, { ...ok, format: undefined }), 'unsupported_format'],
    ['ảnh động nhiều khung', () => assertAcceptableImage(1000, { ...ok, format: 'webp', pages: 12 }), 'multi_frame'],
    ['kích thước 0', () => assertAcceptableImage(1000, { ...ok, width: 0 }), 'invalid_dimensions'],
    ['vượt 25 triệu pixel', () => assertAcceptableImage(1000, { ...ok, width: 6000, height: 5000 }), 'too_many_pixels'],
  ])('từ chối: %s', (_name, fn, reason) => {
    try { fn(); expect.unreachable(); } catch (e) {
      expect((e as BusinessRuleException).code).toBe('INVALID_IMAGE_FORMAT');
      expect((e as BusinessRuleException).details).toEqual({ reason });
    }
  });
});

describe('image-attachment', () => {
  const target = { contextType: 'product', contextId: '70', workshopId: '7' } as const;
  const img = (over: Partial<ImageForAttach> = {}): ImageForAttach => ({
    id: '1', contextType: 'product', contextId: null, quotaWorkshopId: '7', storageState: 'ready', ...over,
  });
  it('chấp nhận ảnh chờ gắn hoặc đã thuộc chính đối tượng này', () => {
    expect(code(() => assertImagesAttachable(['1', '2'], [img(), img({ id: '2', contextId: '70' })], target))).toBe('NO_ERROR');
  });
  it('danh sách rỗng hợp lệ (gỡ hết ảnh)', () => {
    expect(code(() => assertImagesAttachable([], [], target))).toBe('NO_ERROR');
  });
  it('từ chối ID trùng và vượt 10 ảnh', () => {
    expect(code(() => assertImagesAttachable(['1', '1'], [img()], target))).toBe('INVALID_INPUT');
    const ids = Array.from({ length: 11 }, (_, i) => String(i + 1));
    expect(code(() => assertImagesAttachable(ids, ids.map(id => img({ id })), target))).toBe('INVALID_INPUT');
  });
  it('ảnh thiếu hoặc đang bị dọn → RESOURCE_NOT_FOUND', () => {
    expect(code(() => assertImagesAttachable(['1'], [], target))).toBe('RESOURCE_NOT_FOUND');
    expect(code(() => assertImagesAttachable(['1'], [img({ storageState: 'deleting' })], target))).toBe('RESOURCE_NOT_FOUND');
  });
  it('sai ngữ cảnh/đối tượng khác/hộ khác → IMAGE_CONTEXT_MISMATCH', () => {
    expect(code(() => assertImagesAttachable(['1'], [img({ contextType: 'journal_entry' })], target))).toBe('IMAGE_CONTEXT_MISMATCH');
    expect(code(() => assertImagesAttachable(['1'], [img({ contextId: '99' })], target))).toBe('IMAGE_CONTEXT_MISMATCH');
    expect(code(() => assertImagesAttachable(['1'], [img({ quotaWorkshopId: '8' })], target))).toBe('IMAGE_CONTEXT_MISMATCH');
    expect(code(() => assertImagesAttachable(['1'], [img({ quotaWorkshopId: null })], target))).toBe('IMAGE_CONTEXT_MISMATCH');
  });
  it('planReplacement tách gắn/gỡ/giữ và giữ thứ tự mới', () => {
    expect(planReplacement(['1', '2', '3'], ['3', '4', '1'])).toEqual({ attach: ['4'], detach: ['2'], keep: ['3', '1'] });
    expect(planReplacement([], [])).toEqual({ attach: [], detach: [], keep: [] });
  });
});

describe('storage-quota', () => {
  const q = (limit: number, used: number, reserved: number): StorageQuotaState =>
    ({ limitBytes: BigInt(limit), usedBytes: BigInt(used), reservedBytes: BigInt(reserved) });
  it('giữ chỗ khi còn chỗ, không đổi dữ liệu gốc', () => {
    const before = q(100, 50, 10);
    expect(reserveBytes(before, BigInt(40))).toEqual(q(100, 50, 50));
    expect(before).toEqual(q(100, 50, 10));
  });
  it('vượt hạn mức → STORAGE_QUOTA_EXCEEDED, details là chuỗi', () => {
    try { reserveBytes(q(100, 50, 10), BigInt(41)); expect.unreachable(); } catch (e) {
      expect((e as BusinessRuleException).code).toBe('STORAGE_QUOTA_EXCEEDED');
      expect((e as BusinessRuleException).details).toEqual({ limit_bytes: '100', free_bytes: '40' });
    }
  });
  it('quyết toán: giảm reserved theo budget, tăng used theo byte thực', () => {
    expect(settleReservation(q(100, 50, 40), BigInt(40), BigInt(25))).toEqual(q(100, 75, 0));
  });
  it('quyết toán sai: vượt budget hoặc giữ chỗ không thuộc quota', () => {
    expect(() => settleReservation(q(100, 0, 40), BigInt(40), BigInt(41))).toThrow(RangeError);
    expect(() => settleReservation(q(100, 0, 10), BigInt(40), BigInt(5))).toThrow(RangeError);
  });
  it('giải phóng giữ chỗ và byte đã dùng', () => {
    expect(releaseReservation(q(100, 0, 40), BigInt(40))).toEqual(q(100, 0, 0));
    expect(releaseUsedBytes(q(100, 30, 0), BigInt(30))).toEqual(q(100, 0, 0));
    expect(() => releaseUsedBytes(q(100, 30, 0), BigInt(31))).toThrow(RangeError);
    expect(() => releaseReservation(q(100, 0, 10), BigInt(11))).toThrow(RangeError);
  });
  it('trạng thái vi phạm bất biến bị phát hiện', () => {
    expect(() => reserveBytes(q(100, 90, 20), BigInt(1))).toThrow(RangeError);
    expect(() => reserveBytes(q(100, 0, 0), BigInt(0))).toThrow(RangeError);
  });
});

describe('upload-reservation', () => {
  const now = new Date('2026-11-21T10:00:00Z');
  const base = (over: Partial<UploadReservationState> = {}): UploadReservationState => ({
    status: 'reserved', budgetBytes: BigInt(16 * MIB), actualBytes: null,
    expiresAt: new Date('2026-11-21T10:05:00Z'), ...over,
  });
  it('commit thành công trong lease', () => {
    expect(commitReservation(base(), BigInt(1000), now)).toMatchObject({ status: 'committed', actualBytes: BigInt(1000) });
  });
  it('worker cũ không commit được sau khi hết lease hoặc đã bị dọn', () => {
    const late = new Date('2026-11-21T10:05:00Z');
    expect(code(() => commitReservation(base(), BigInt(1), late))).toBe('INVALID_STATE');
    expect(code(() => commitReservation(base({ status: 'cleanup_pending' }), BigInt(1), now))).toBe('INVALID_STATE');
    expect(code(() => commitReservation(base({ status: 'committed' }), BigInt(1), now))).toBe('INVALID_STATE');
  });
  it('byte thực vượt budget là lỗi lập trình', () => {
    expect(() => commitReservation(base(), BigInt(17 * MIB), now)).toThrow(RangeError);
  });
  it('needsCleanup chỉ đúng khi reserved + hết lease', () => {
    expect(needsCleanup(base(), now)).toBe(false);
    expect(needsCleanup(base(), new Date('2026-11-21T10:06:00Z'))).toBe(true);
    expect(needsCleanup(base({ status: 'committed' }), new Date('2026-11-21T10:06:00Z'))).toBe(false);
  });
  it('chuỗi dọn dẹp: reserved → cleanup_pending → released, lặp lại an toàn', () => {
    const pending = markCleanupPending(base());
    expect(pending.status).toBe('cleanup_pending');
    expect(markCleanupPending(pending)).toBe(pending);
    const released = confirmReleased(pending);
    expect(released.status).toBe('released');
    expect(confirmReleased(released)).toBe(released);
  });
  it('không nhảy cóc trạng thái', () => {
    expect(code(() => confirmReleased(base()))).toBe('INVALID_STATE');
    expect(code(() => markCleanupPending(base({ status: 'committed' })))).toBe('INVALID_STATE');
  });
});
