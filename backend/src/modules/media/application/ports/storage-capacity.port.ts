import type { StorageCapacitySnapshot } from '../../domain/policies/storage-capacity.policy';

export const STORAGE_CAPACITY = Symbol('STORAGE_CAPACITY');

export interface IStorageCapacity {
  /** Đo dung lượng thực của volume chứa kho ảnh. */
  measure(): Promise<StorageCapacitySnapshot>;
}
