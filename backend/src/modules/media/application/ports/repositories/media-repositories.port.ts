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
  /** Chuyển CHÍNH dòng quota từ phạm vi sang hộ mới, giữ nguyên quota_id/used_bytes/reserved_bytes. */
  transferScopeQuotaToWorkshop(initialWorkshopKey: string, workshopId: Id, tx: TransactionContext): Promise<void>;
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
  /** Số phạm vi còn open và chưa hết hạn (theo `now`) của Admin này. */
  countOpenUnexpired(adminId: Id, now: Date, tx: TransactionContext): Promise<number>;
  /** Tạo phạm vi cùng dòng quota riêng (2 GiB) trong cùng giao dịch. Khóa là UUID v4 do server cấp. */
  create(input: { adminId: Id; expiresAt: Date; quotaLimitBytes: bigint }, tx: TransactionContext): Promise<UploadScopeRecord>;
  markAttached(initialWorkshopKey: string, workshopId: Id, tx: TransactionContext): Promise<void>;
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
  /** Số reservation còn reserved/cleanup_pending của quota (upload hoặc dọn đang chạy). */
  countActiveByQuota(quotaId: Id, tx: TransactionContext): Promise<number>;
  findCleanupCandidates(now: Date, limit: number, tx: TransactionContext): Promise<Id[]>;
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

/** Trạng thái ảnh phục vụ gắn/đọc. quotaWorkshopId = hộ chủ quota của ảnh (null nếu quota thuộc phạm vi/tài khoản). */
export interface ImageStateRecord {
  readonly id: Id;
  readonly uploadedBy: Id;
  readonly contextType: ImageContextType;
  readonly contextId: Id | null;
  readonly quotaId: Id;
  readonly quotaWorkshopId: Id | null;
  readonly isAttached: boolean;
  readonly storageState: 'ready' | 'deleting';
  readonly unreferencedAt: Date | null;
  readonly thumbnailKey: string;
  readonly displayKey: string;
  readonly thumbnailSizeBytes: bigint;
  readonly displaySizeBytes: bigint;
}

export interface ImageCleanupCandidate {
  readonly id: Id;
  readonly quotaId: Id;
}

export interface ImageCleanupRecord extends ImageCleanupCandidate {
  readonly thumbnailKey: string;
  readonly displayKey: string;
  readonly actualBytes: bigint;
}

export interface IImageRepository {
  create(input: NewImage, tx: TransactionContext): Promise<ImageRecord>;
  findById(imageId: Id, tx: TransactionContext): Promise<ImageStateRecord | null>;
  findImageCleanupCandidates(cutoff: Date, limit: number, tx: TransactionContext): Promise<ImageCleanupCandidate[]>;
  /** Locks an unattached, unreferenced image and changes ready → deleting before touching storage. */
  claimImageForCleanup(imageId: Id, cutoff: Date, tx: TransactionContext): Promise<ImageCleanupRecord | null>;
  /** Rechecks references under row lock and deletes the image row after its storage files are gone. */
  deleteClaimedImage(imageId: Id, cutoff: Date, tx: TransactionContext): Promise<ImageCleanupRecord | null>;
  /** Khóa các ảnh theo ID TĂNG DẦN (tránh deadlock) rồi trả trạng thái; ID không tồn tại bị bỏ qua. */
  lockByIds(imageIds: readonly Id[], tx: TransactionContext): Promise<ImageStateRecord[]>;
  /**
   * Khóa theo ĐỐI TƯỢNG (advisory, theo giao dịch) trước khi đọc danh sách ảnh hiện tại. Hai danh sách ảnh khác nhau
   * không tranh khóa dòng ảnh nào, nên không có khóa này thì hai lần thay đồng thời đều tưởng đối tượng đang trống.
   */
  lockContext(contextType: ImageContextType, contextId: Id, tx: TransactionContext): Promise<void>;
  /** ID các ảnh đang gắn với đối tượng, tăng dần (thứ tự hiển thị). */
  listAttachedIds(contextType: ImageContextType, contextId: Id, tx: TransactionContext): Promise<Id[]>;
  /** Gắn ảnh: is_attached = true, cố định context_id, bỏ mốc hết hạn. */
  markAttached(imageIds: readonly Id[], contextId: Id, tx: TransactionContext): Promise<void>;
  /** Gỡ ảnh khỏi đối tượng: is_attached = false, đặt mốc hết hạn 24 giờ; GIỮ NGUYÊN context_id. */
  markDetached(imageIds: readonly Id[], at: Date, tx: TransactionContext): Promise<void>;
  /** Ghi ảnh của phiên bản cũ vào lịch sử sửa (position theo thứ tự truyền vào). */
  addHistoryLinks(historyId: Id, imageIds: readonly Id[], tx: TransactionContext): Promise<void>;
  /** Mục nhật ký của một bản lịch sử nếu bản đó có ảnh này; ngược lại null. */
  findHistoryEntry(historyId: Id, imageId: Id, tx: TransactionContext): Promise<{ readonly entryId: Id } | null>;
  /** Mục nhật ký sở hữu historyId; null nếu history không tồn tại. */
  findJournalEntryForHistory(historyId: Id, tx: TransactionContext): Promise<Id | null>;
  isReferencedByHistory(imageId: Id, tx: TransactionContext): Promise<boolean>;
}
