import type { Id } from '../../../../common/application/types/contract-types';
import type { ImageContextType } from '../../domain/value-objects/image-context';

const BASE = '/api/v1/media';

export interface ImageUrls {
  readonly thumbnail_url: string;
  readonly display_url: string;
}

const both = (prefix: string): ImageUrls => ({ thumbnail_url: `${prefix}/thumbnail`, display_url: `${prefix}/display` });

/** URL luôn đi qua cổng media (kiểm tra quyền mỗi lần đọc); không bao giờ lộ storage key. */
export const pendingImageUrls = (imageId: Id): ImageUrls => both(`${BASE}/pending/${imageId}`);

export const currentImageUrls = (contextType: ImageContextType, contextId: Id, imageId: Id): ImageUrls =>
  both(`${BASE}/current/${contextType}/${contextId}/images/${imageId}`);

export const historyImageUrls = (historyId: Id, imageId: Id): ImageUrls =>
  both(`${BASE}/history/${historyId}/images/${imageId}`);
