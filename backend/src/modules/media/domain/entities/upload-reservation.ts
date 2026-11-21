import { BusinessRuleException } from '../../../../common/domain/errors/business-rule.exception';

export type ReservationStatus = 'reserved' | 'committed' | 'cleanup_pending' | 'released';

export interface UploadReservationState {
  readonly status: ReservationStatus;
  readonly budgetBytes: bigint;
  readonly actualBytes: bigint | null;
  readonly expiresAt: Date;
}

const ZERO = BigInt(0);
const invalidState = () => new BusinessRuleException('INVALID_STATE');

/** `now` do máy chủ truyền vào (không dùng giờ client). */
export function isLeaseExpired(r: UploadReservationState, now: Date): boolean {
  return now.getTime() >= r.expiresAt.getTime();
}

/** Giữ chỗ bị bỏ dở: còn 'reserved' nhưng hết lease → cần dọn. */
export function needsCleanup(r: UploadReservationState, now: Date): boolean {
  return r.status === 'reserved' && isLeaseExpired(r, now);
}

/**
 * Thành công: reserved → committed. Worker cũ KHÔNG được commit sau khi tác vụ dọn đã
 * nhận quyền (status đã đổi hoặc lease hết hạn).
 */
export function commitReservation(r: UploadReservationState, actualBytes: bigint, now: Date): UploadReservationState {
  if (r.status !== 'reserved' || isLeaseExpired(r, now)) throw invalidState();
  if (actualBytes < ZERO || actualBytes > r.budgetBytes) throw new RangeError('Actual bytes exceed budget');
  return { ...r, status: 'committed', actualBytes };
}

/** Thất bại/timeout: reserved → cleanup_pending. Gọi lặp là an toàn. */
export function markCleanupPending(r: UploadReservationState): UploadReservationState {
  if (r.status === 'cleanup_pending') return r;
  if (r.status !== 'reserved') throw invalidState();
  return { ...r, status: 'cleanup_pending' };
}

/** Chỉ sau khi xác nhận dọn sạch: cleanup_pending → released. Gọi lặp là an toàn. */
export function confirmReleased(r: UploadReservationState): UploadReservationState {
  if (r.status === 'released') return r;
  if (r.status !== 'cleanup_pending') throw invalidState();
  return { ...r, status: 'released' };
}
