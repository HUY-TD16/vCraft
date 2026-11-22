import { describe, expect, it } from 'vitest';
import { BusinessRuleException } from '../../../../src/common/domain/errors/business-rule.exception';
import { assertFitsWithin } from '../../../../src/modules/media/domain/entities/storage-quota.entity';
import { hasEnoughFreeSpace, requiredFreeBytes } from '../../../../src/modules/media/domain/policies/storage-capacity.policy';
import { assertScopeUsable } from '../../../../src/modules/media/domain/policies/upload-scope.policy';
import { GIB, MIB } from '../../../../src/modules/media/domain/value-objects/image-limits';

const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof BusinessRuleException ? e.code : `OTHER:${(e as Error).name}`; }
  return 'NO_ERROR';
};
const B = (n: number) => BigInt(n);

describe('assertFitsWithin', () => {
  it('đủ chỗ thì qua, vừa chạm hạn mức vẫn qua', () => {
    expect(code(() => assertFitsWithin(B(90), B(10), B(100)))).toBe('NO_ERROR');
  });
  it('vượt hạn mức gộp → STORAGE_QUOTA_EXCEEDED', () => {
    expect(code(() => assertFitsWithin(B(91), B(10), B(100)))).toBe('STORAGE_QUOTA_EXCEEDED');
  });
  it('đầu vào sai là lỗi lập trình', () => {
    expect(() => assertFitsWithin(B(-1), B(10), B(100))).toThrow(RangeError);
    expect(() => assertFitsWithin(B(0), B(0), B(100))).toThrow(RangeError);
  });
});

describe('storage-capacity policy', () => {
  it('yêu cầu giữ trống max(2 GiB, 10% volume)', () => {
    expect(requiredFreeBytes(B(10 * GIB))).toBe(B(2 * GIB));      // 10% = 1 GiB < 2 GiB
    expect(requiredFreeBytes(B(100 * GIB))).toBe(B(10 * GIB));    // 10% = 10 GiB > 2 GiB
  });
  it('trừ cả ngân sách đang giữ chỗ lẫn ngân sách mới', () => {
    const snap = { freeBytes: B(12 * GIB), totalBytes: B(100 * GIB) }; // cần giữ trống 10 GiB
    expect(hasEnoughFreeSpace(snap, B(0), B(16 * MIB))).toBe(true);
    expect(hasEnoughFreeSpace(snap, B(2 * GIB - 16 * MIB), B(16 * MIB))).toBe(true);  // vừa đúng ngưỡng
    expect(hasEnoughFreeSpace(snap, B(2 * GIB), B(16 * MIB))).toBe(false);
  });
});

describe('upload-scope policy', () => {
  const now = new Date('2026-11-21T10:00:00Z');
  const open = { createdBy: '5', status: 'open', expiresAt: new Date('2026-11-22T10:00:00Z') } as const;
  it('scope open, đúng chủ, chưa hết hạn → qua', () => {
    expect(code(() => assertScopeUsable(open, '5', now))).toBe('NO_ERROR');
  });
  it('không tồn tại hoặc của Admin khác → 404 (không lộ sự tồn tại)', () => {
    expect(code(() => assertScopeUsable(null, '5', now))).toBe('RESOURCE_NOT_FOUND');
    expect(code(() => assertScopeUsable(open, '6', now))).toBe('RESOURCE_NOT_FOUND');
  });
  it('đã dùng, đã expired hoặc quá hạn theo giờ DB → UPLOAD_SCOPE_UNAVAILABLE', () => {
    expect(code(() => assertScopeUsable({ ...open, status: 'attached' }, '5', now))).toBe('UPLOAD_SCOPE_UNAVAILABLE');
    expect(code(() => assertScopeUsable({ ...open, status: 'expired' }, '5', now))).toBe('UPLOAD_SCOPE_UNAVAILABLE');
    expect(code(() => assertScopeUsable(open, '5', open.expiresAt))).toBe('UPLOAD_SCOPE_UNAVAILABLE'); // đúng mốc hết hạn
  });
});
