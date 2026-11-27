import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id, TrustedActor } from '../../../../../common/application/types/contract-types';
import type { ImageContextType } from '../../../domain/value-objects/image-context';

export const IMAGE_ACCESS_RESOLVER = Symbol('IMAGE_ACCESS_RESOLVER');

/**
 * Hỏi module chủ của đối tượng xem ai được đọc ảnh (data-design/security SEC-10). Media không tự suy ra quyền:
 * sản phẩm → Catalog, nhật ký → Traceability, hồ sơ/chứng nhận → Workshops.
 */
export interface ImageAccessResolver {
  /** Confirms the target row really belongs to the supplied workshop before Media attaches or detaches images. */
  canManageTarget(input: {
    contextType: ImageContextType;
    contextId: Id;
    workshopId: Id;
  }, tx: TransactionContext): Promise<boolean>;

  canReadCurrent(input: {
    contextType: ImageContextType;
    contextId: Id;
    imageId: Id;
    /** Hộ chủ quota của ảnh; dùng cho ảnh hồ sơ/chứng nhận. */
    workshopId: Id | null;
    actorOrNull: TrustedActor | null;
  }, tx: TransactionContext): Promise<boolean>;

  canReadHistory(input: {
    entryId: Id;
    historyId: Id;
    imageId: Id;
    actorOrNull: TrustedActor | null;
  }, tx: TransactionContext): Promise<boolean>;
}
