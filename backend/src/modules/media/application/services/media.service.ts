import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../common/application/types/contract-types';
import { BusinessRuleException } from '../../../../common/domain/errors/business-rule.exception';
import { assertImagesAttachable, planReplacement } from '../../domain/policies/image-attachment.policy';
import { isCurrentImageOf } from '../../domain/policies/image-reading.policy';
import { assertScopeUsable } from '../../domain/policies/upload-scope.policy';
import { MAX_IMAGES_PER_OBJECT } from '../../domain/value-objects/image-context';
import type { IMediaContract, ImageDto } from '../../public/contracts/media.contract';
import type { ImageAccessResolver } from '../ports/image-access-resolver.port';
import type {
  IImageRepository, IStorageQuotaRepository, IUploadReservationRepository, IUploadScopeRepository,
} from '../ports/repositories/media-repositories.port';
import { currentImageUrls, historyImageUrls } from './image-urls';

export interface MediaServiceDependencies {
  readonly images: IImageRepository;
  readonly quotas: IStorageQuotaRepository;
  readonly scopes: IUploadScopeRepository;
  readonly reservations: IUploadReservationRepository;
  readonly access: ImageAccessResolver;
}

type Input<K extends keyof IMediaContract> = Parameters<IMediaContract[K]>[0];

const byNumericId = (a: Id, b: Id) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
const sortedUnique = (ids: readonly Id[]) => [...new Set(ids)].sort(byNumericId);

/** Triển khai IMediaContract. Mọi thao tác ghi dùng `tx` của workflow gọi vào, không tự mở giao dịch. */
export class MediaService implements IMediaContract {
  constructor(private readonly deps: MediaServiceDependencies) {}

  async replaceImages(input: Input<'replaceImages'>, tx: TransactionContext): Promise<void> {
    const { contextType, contextId, workshopId, imageIds, actor } = input;
    if (actor.role !== 'artisan' || actor.workshopId !== workshopId) throw new BusinessRuleException('PERMISSION_DENIED');
    const { images, reservations } = this.deps;

    const now = await reservations.databaseNow(tx);
    // Thứ tự khóa: đối tượng → ảnh theo ID tăng dần. Phải khóa đối tượng TRƯỚC khi đọc danh sách ảnh hiện tại.
    await images.lockContext(contextType, contextId, tx);
    const current = await images.listAttachedIds(contextType, contextId, tx);
    // Khóa cả ảnh đang gắn lẫn ảnh mới, theo ID tăng dần.
    const locked = await images.lockByIds(sortedUnique([...current, ...imageIds]), tx);
    assertImagesAttachable(imageIds, locked, { contextType, contextId, workshopId });

    const plan = planReplacement(current, imageIds);
    if (plan.attach.length > 0) await images.markAttached(plan.attach, contextId, tx);
    if (plan.detach.length > 0) await images.markDetached(plan.detach, now, tx);
  }

  async retainHistoryImages(input: Input<'retainHistoryImages'>, tx: TransactionContext): Promise<void> {
    const { historyId, entryId, imageIds } = input;
    if (imageIds.length === 0) return;
    const { images } = this.deps;
    const unique = sortedUnique(imageIds);
    if (unique.length !== imageIds.length) throw new BusinessRuleException('INVALID_INPUT', 'INVALID_INPUT', { field: 'image_ids' });

    const locked = await images.lockByIds(unique, tx);
    if (locked.length !== unique.length) throw new BusinessRuleException('RESOURCE_NOT_FOUND');
    for (const image of locked) {
      if (!isCurrentImageOf(image, 'journal_entry', entryId)) throw new BusinessRuleException('IMAGE_CONTEXT_MISMATCH');
    }
    await images.addHistoryLinks(historyId, imageIds, tx);
  }

  async attachInitialWorkshopScope(input: Input<'attachInitialWorkshopScope'>, tx: TransactionContext): Promise<void> {
    const { initialWorkshopKey, workshopId, imageIds, actor } = input;
    if (actor.role !== 'admin') throw new BusinessRuleException('PERMISSION_DENIED');
    const { images, quotas, scopes, reservations } = this.deps;
    const unique = sortedUnique(imageIds);
    if (unique.length !== imageIds.length || imageIds.length > MAX_IMAGES_PER_OBJECT.workshop_profile) {
      throw new BusinessRuleException('INVALID_INPUT', 'INVALID_INPUT', { field: 'image_ids' });
    }

    // Thứ tự khóa: scope → quota → reservation (đếm) → ảnh theo ID tăng dần.
    const now = await reservations.databaseNow(tx);
    assertScopeUsable(await scopes.lockByKey(initialWorkshopKey, tx), actor.accountId, now);
    const quota = await quotas.lockScopeQuota(initialWorkshopKey, tx);
    if (quota === null) throw new BusinessRuleException('UPLOAD_SCOPE_UNAVAILABLE');
    if ((await reservations.countActiveByQuota(quota.id, tx)) > 0) throw new BusinessRuleException('UPLOAD_SCOPE_BUSY');

    const locked = await images.lockByIds(unique, tx);
    if (locked.length !== unique.length) throw new BusinessRuleException('RESOURCE_NOT_FOUND');
    for (const image of locked) {
      const chosen = image.quotaId === quota.id && image.contextType === 'workshop_profile'
        && image.contextId === null && !image.isAttached && image.storageState === 'ready';
      if (!chosen) throw new BusinessRuleException('IMAGE_CONTEXT_MISMATCH');
    }

    await quotas.transferScopeQuotaToWorkshop(initialWorkshopKey, workshopId, tx);
    await scopes.markAttached(initialWorkshopKey, workshopId, tx);
    if (imageIds.length > 0) await images.markAttached(imageIds, workshopId, tx); // ảnh hồ sơ có context_id = ID hộ
  }

  async getImageDto(input: Input<'getImageDto'>, tx: TransactionContext): Promise<ImageDto | null> {
    const { imageId, contextType, contextId, historyId, actorOrNull } = input;
    const { images, access } = this.deps;
    const image = await images.findById(imageId, tx);
    if (image === null) return null;

    if (historyId !== null) {
      if (contextType !== 'journal_entry') return null;
      const link = await images.findHistoryEntry(historyId, imageId, tx);
      if (link === null || link.entryId !== contextId) return null;
      if (!(await access.canReadHistory({ entryId: contextId, historyId, imageId, actorOrNull }, tx))) return null;
      return { id: imageId, ...historyImageUrls(historyId, imageId) };
    }

    if (!isCurrentImageOf(image, contextType, contextId)) return null;
    const allowed = await access.canReadCurrent({
      contextType, contextId, imageId, workshopId: image.quotaWorkshopId, actorOrNull,
    }, tx);
    return allowed ? { id: imageId, ...currentImageUrls(contextType, contextId, imageId) } : null;
  }
}
