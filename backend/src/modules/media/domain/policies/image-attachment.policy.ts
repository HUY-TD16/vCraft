import { BusinessRuleException } from '../../../../common/domain/errors/business-rule.exception';
import { MediaDomainError } from '../errors/media-domain.error';
import { MAX_IMAGES_PER_OBJECT, type ImageContextType } from '../value-objects/image-context';

export interface ImageForAttach {
  readonly id: string;
  readonly contextType: ImageContextType;
  /** null = ảnh chờ gắn lần đầu; sau lần gắn đầu thì cố định (SEC-10). */
  readonly contextId: string | null;
  /** Hộ chủ quota của ảnh (StorageQuota.workshop_id); null nếu quota không thuộc hộ. */
  readonly quotaWorkshopId: string | null;
  readonly storageState: 'ready' | 'deleting';
}

export interface AttachTarget {
  readonly contextType: ImageContextType;
  readonly contextId: string;
  readonly workshopId: string;
}

/**
 * Điều kiện để gắn danh sách ảnh vào một đối tượng (dùng cho replaceImages):
 * không trùng ID, không vượt số lượng tối đa, đủ ảnh, ảnh ready, đúng ngữ cảnh,
 * đúng hộ chủ, và chưa thuộc đối tượng khác.
 */
export function assertImagesAttachable(
  requestedIds: readonly string[],
  found: readonly ImageForAttach[],
  target: AttachTarget,
): void {
  if (new Set(requestedIds).size !== requestedIds.length) {
    throw new BusinessRuleException('INVALID_INPUT', 'INVALID_INPUT', { field: 'image_ids' });
  }
  if (requestedIds.length > MAX_IMAGES_PER_OBJECT[target.contextType]) {
    throw new BusinessRuleException('INVALID_INPUT', 'INVALID_INPUT', { field: 'image_ids' });
  }
  const byId = new Map(found.map(image => [image.id, image]));
  for (const id of requestedIds) {
    const image = byId.get(id);
    if (!image || image.storageState !== 'ready') throw new BusinessRuleException('RESOURCE_NOT_FOUND');
    const sameContext = image.contextType === target.contextType
      && (image.contextId === null || image.contextId === target.contextId);
    if (!sameContext || image.quotaWorkshopId !== target.workshopId) {
      throw new MediaDomainError('IMAGE_CONTEXT_MISMATCH');
    }
  }
}

export interface ReplacementPlan {
  readonly attach: readonly string[];
  readonly detach: readonly string[];
  readonly keep: readonly string[];
}

/** So sánh danh sách ảnh hiện hành với danh sách mới để biết gắn/gỡ/giữ ảnh nào. */
export function planReplacement(currentIds: readonly string[], nextIds: readonly string[]): ReplacementPlan {
  const current = new Set(currentIds);
  const next = new Set(nextIds);
  return {
    attach: nextIds.filter(id => !current.has(id)),
    detach: currentIds.filter(id => !next.has(id)),
    keep: nextIds.filter(id => current.has(id)),
  };
}
