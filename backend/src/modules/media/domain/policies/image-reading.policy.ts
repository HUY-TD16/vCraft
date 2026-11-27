import { UPLOAD_LIMITS } from '../value-objects/image-limits';
import type { ImageContextType } from '../value-objects/image-context';

/** Phần trạng thái ảnh mà các quy tắc đọc cần (ImageStateRecord thỏa cấu trúc này). */
export interface ReadableImageState {
  readonly uploadedBy: string;
  readonly contextType: ImageContextType;
  readonly contextId: string | null;
  readonly isAttached: boolean;
  readonly storageState: 'ready' | 'deleting';
  readonly unreferencedAt: Date | null;
}

const WINDOW_MS = UPLOAD_LIMITS.unattachedTtlHours * 60 * 60 * 1000;

/**
 * Ảnh chờ gắn (API 8.2): chỉ người tải, chưa gắn, chưa có lịch sử, còn trong cửa sổ 24 giờ.
 * Hết hạn hoặc đã gắn thì coi như không tồn tại (404).
 */
export function canReadPendingImage(
  image: ReadableImageState, actorAccountId: string, hasHistory: boolean, now: Date,
): boolean {
  return image.uploadedBy === actorAccountId
    && !image.isAttached
    && !hasHistory
    && image.storageState === 'ready'
    && image.unreferencedAt !== null
    && now.getTime() < image.unreferencedAt.getTime() + WINDOW_MS;
}

/** Ảnh hiện hành phải THỰC SỰ thuộc đối tượng: không lấy quyền của ảnh đã gỡ hoặc của đối tượng khác. */
export function isCurrentImageOf(image: ReadableImageState, contextType: ImageContextType, contextId: string): boolean {
  return image.isAttached
    && image.storageState === 'ready'
    && image.contextType === contextType
    && image.contextId === contextId;
}
