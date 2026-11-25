import { GIB } from '../value-objects/image-limits';

export interface StorageCapacitySnapshot {
  readonly freeBytes: bigint;
  readonly totalBytes: bigint;
}

/** Giữ trống tối thiểu max(2 GiB, 10% dung lượng volume) SAU khi đặt trước (data-design 2.27). */
export function requiredFreeBytes(totalBytes: bigint): bigint {
  const tenthOfVolume = totalBytes / BigInt(10);
  const floor = BigInt(2 * GIB);
  return tenthOfVolume > floor ? tenthOfVolume : floor;
}

/**
 * `reservedBytes` là tổng ngân sách đã giữ chỗ của MỌI quota nhưng chưa phản ánh vào tệp thật,
 * nên phải trừ thêm khỏi dung lượng trống đo được.
 */
export function hasEnoughFreeSpace(
  snapshot: StorageCapacitySnapshot,
  reservedBytes: bigint,
  budgetBytes: bigint,
): boolean {
  return snapshot.freeBytes - reservedBytes - budgetBytes >= requiredFreeBytes(snapshot.totalBytes);
}
