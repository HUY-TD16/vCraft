import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import type { StorageQuotaState } from '../../../domain/entities/storage-quota.entity';
import type { UploadReservationState } from '../../../domain/entities/upload-reservation.entity';
import type { UploadScopeState } from '../../../domain/policies/upload-scope.policy';
import type { ImageContextType } from '../../../domain/value-objects/image-context';

export const STORAGE_QUOTA_REPOSITORY = Symbol('STORAGE_QUOTA_REPOSITORY');
export const UPLOAD_RESERVATION_REPOSITORY = Symbol('UPLOAD_RESERVATION_REPOSITORY');
export const UPLOAD_SCOPE_REPOSITORY = Symbol('UPLOAD_SCOPE_REPOSITORY');
export const IMAGE_REPOSITORY = Symbol('IMAGE_REPOSITORY');

export interface StorageQuotaRecord {
  readonly id: Id;
  readonly state: StorageQuotaState;
}

/**
 * Thứ tự khóa bắt buộc (data-design 2.27–2.28): kho chung → Account Admin → scope → quota
 * → reservation/ảnh theo ID tăng dần.
 */
export interface IStorageQuotaRepository {
  /** Khóa điều phối dung lượng kho dùng chung (advisory lock theo giao dịch). */
  lockStorageBudget(tx: TransactionContext): Promise<void>;
  /** Khóa quota của hộ; chưa có thì tạo với hạn mức `limitBytes`. */
  lockOrCreateWorkshopQuota(workshopId: Id, limitBytes: bigint, tx: TransactionContext): Promise<StorageQuotaRecord>;
  lockScopeQuota(initialWorkshopKey: string, tx: TransactionContext): Promise<StorageQuotaRecord | null>;
  lockById(quotaId: Id, tx: TransactionContext): Promise<StorageQuotaRecord | null>;
  save(record: StorageQuotaRecord, tx: TransactionContext): Promise<void>;
  /** Tổng reserved_bytes của MỌI quota (ngân sách chưa phản ánh vào tệp). */
  sumReservedBytes(tx: TransactionContext): Promise<bigint>;
  /** Tổng used + reserved của mọi quota còn initial_workshop_key do Admin này tạo (kể cả scope hết hạn chưa dọn). */
  sumInitialScopeBytes(adminId: Id, tx: TransactionContext): Promise<bigint>;
}

export interface UploadScopeRecord extends UploadScopeState {
  readonly initialWorkshopKey: string;
}

export interface IUploadScopeRepository {
  lockByKey(initialWorkshopKey: string, tx: TransactionContext): Promise<UploadScopeRecord | null>;
}

export interface UploadReservationRecord {
  readonly id: Id;
  readonly quotaId: Id;
  readonly uploadedBy: Id;
  readonly contextType: ImageContextType;
  readonly contextId: Id | null;
  readonly storagePrefix: string;
  readonly state: UploadReservationState;
}

export interface NewUploadReservation {
  readonly quotaId: Id;
  readonly uploadedBy: Id;
  readonly contextType: ImageContextType;
  readonly contextId: Id | null;
  readonly budgetBytes: bigint;
  readonly storagePrefix: string;
  readonly expiresAt: Date;
}

export interface IUploadReservationRepository {
  /** Giờ của DB: hạn lease và hạn scope luôn tính theo giờ này, không theo giờ máy chủ ứng dụng. */
  databaseNow(tx: TransactionContext): Promise<Date>;
  create(input: NewUploadReservation, tx: TransactionContext): Promise<UploadReservationRecord>;
  findById(reservationId: Id, tx: TransactionContext): Promise<UploadReservationRecord | null>;
  lockById(reservationId: Id, tx: TransactionContext): Promise<UploadReservationRecord | null>;
  saveState(reservationId: Id, state: UploadReservationState, tx: TransactionContext): Promise<void>;
}

export interface NewImage {
  readonly uploadedBy: Id;
  readonly contextType: ImageContextType;
  readonly contextId: Id | null;
  readonly thumbnailKey: string;
  readonly displayKey: string;
  readonly thumbnailSizeBytes: bigint;
  readonly displaySizeBytes: bigint;
  readonly quotaId: Id;
  readonly reservationId: Id;
  readonly width: number;
  readonly height: number;
  /** Ảnh mới chờ gắn lấy created_at làm mốc hết hạn 24 giờ. */
  readonly unreferencedAt: Date;
}

export interface ImageRecord extends NewImage {
  readonly id: Id;
}

export interface IImageRepository {
  create(input: NewImage, tx: TransactionContext): Promise<ImageRecord>;
}
