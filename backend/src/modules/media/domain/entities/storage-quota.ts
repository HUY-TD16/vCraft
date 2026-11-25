import { BusinessRuleException } from '../../../../common/domain/errors/business-rule.exception';

const ZERO = BigInt(0);

/** Sổ dung lượng. Bất biến: mọi số ≥ 0 và used + reserved ≤ limit (data-design 2.26). */
export interface StorageQuotaState {
  readonly limitBytes: bigint;
  readonly usedBytes: bigint;
  readonly reservedBytes: bigint;
}

function assertInvariant(q: StorageQuotaState): StorageQuotaState {
  if (q.limitBytes < ZERO || q.usedBytes < ZERO || q.reservedBytes < ZERO
    || q.usedBytes + q.reservedBytes > q.limitBytes) {
    throw new RangeError('Storage quota invariant violated');
  }
  return q;
}

function assertPositive(bytes: bigint): void {
  if (bytes <= ZERO) throw new RangeError('Byte amount must be positive');
}

/** Giữ chỗ trước khi nhận tệp. Vượt hạn mức → 409 STORAGE_QUOTA_EXCEEDED. */
export function reserveBytes(q: StorageQuotaState, budget: bigint): StorageQuotaState {
  assertInvariant(q);
  assertPositive(budget);
  if (q.usedBytes + q.reservedBytes + budget > q.limitBytes) {
    throw new BusinessRuleException('STORAGE_QUOTA_EXCEEDED', 'STORAGE_QUOTA_EXCEEDED', {
      limit_bytes: q.limitBytes.toString(),
      free_bytes: (q.limitBytes - q.usedBytes - q.reservedBytes).toString(),
    });
  }
  return assertInvariant({ ...q, reservedBytes: q.reservedBytes + budget });
}

/** Quyết toán: bỏ ngân sách giữ chỗ, ghi byte thực (0 ≤ actual ≤ budget). */
export function settleReservation(q: StorageQuotaState, budget: bigint, actual: bigint): StorageQuotaState {
  assertPositive(budget);
  if (actual < ZERO || actual > budget) throw new RangeError('Actual bytes exceed reservation budget');
  if (budget > q.reservedBytes) throw new RangeError('Reservation not held by this quota');
  return assertInvariant({ ...q, reservedBytes: q.reservedBytes - budget, usedBytes: q.usedBytes + actual });
}

/** Giải phóng giữ chỗ — CHỈ gọi sau khi đã xác nhận dọn sạch tệp (data-design 2.27). */
export function releaseReservation(q: StorageQuotaState, budget: bigint): StorageQuotaState {
  assertPositive(budget);
  if (budget > q.reservedBytes) throw new RangeError('Reservation not held by this quota');
  return assertInvariant({ ...q, reservedBytes: q.reservedBytes - budget });
}

/** Trừ byte đã dùng — CHỈ sau khi xác nhận xóa tệp thành công. */
export function releaseUsedBytes(q: StorageQuotaState, bytes: bigint): StorageQuotaState {
  assertPositive(bytes);
  if (bytes > q.usedBytes) throw new RangeError('Cannot release more than used');
  return assertInvariant({ ...q, usedBytes: q.usedBytes - bytes });
}
