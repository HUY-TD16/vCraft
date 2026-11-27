import type { TransactionRunner } from '../../../../../common/application/ports/transaction-runner';
import { BusinessRuleException } from '../../../../../common/domain/errors/business-rule.exception';
import { canReadPendingImage, isCurrentImageOf } from '../../../domain/policies/image-reading.policy';
import type { ImageAccessResolver } from '../../ports/queries/image-access-resolver.port';
import type { IImageRepository, IUploadReservationRepository } from '../../ports/repositories/media-repositories.port';
import type { GetImageCommand, ImageReadTarget } from '../../dtos/media-use-case.dtos';

export type { GetImageCommand, ImageReadTarget, ImageSource } from '../../dtos/media-use-case.dtos';

export interface GetImageDependencies {
  readonly txRunner: TransactionRunner;
  readonly images: IImageRepository;
  readonly reservations: IUploadReservationRepository;
  readonly access: ImageAccessResolver;
}

/**
 * Đọc ảnh theo ba ngữ cảnh (API 8.2). Mọi trường hợp không đủ quyền hoặc không đúng quan hệ đều trả
 * RESOURCE_NOT_FOUND để không lộ ảnh có tồn tại. Kiểm tra quyền và đọc metadata trong cùng một giao dịch.
 */
export class GetImageUseCase {
  constructor(private readonly deps: GetImageDependencies) {}

  execute(command: GetImageCommand): Promise<ImageReadTarget> {
    const { txRunner, images, reservations, access } = this.deps;
    const { actorOrNull, source, variant } = command;
    const notFound = () => new BusinessRuleException('RESOURCE_NOT_FOUND');

    return txRunner.run(async (tx) => {
      const image = await images.findById(source.imageId, tx);
      if (image === null) throw notFound();

      let allowed = false;
      if (source.kind === 'pending') {
        if (actorOrNull !== null) {
          const now = await reservations.databaseNow(tx);
          const hasHistory = await images.isReferencedByHistory(image.id, tx);
          allowed = canReadPendingImage(image, actorOrNull.accountId, hasHistory, now);
        }
      } else if (source.kind === 'current') {
        allowed = isCurrentImageOf(image, source.contextType, source.contextId)
          && await access.canReadCurrent({
            contextType: source.contextType, contextId: source.contextId, imageId: image.id,
            workshopId: image.quotaWorkshopId, actorOrNull,
          }, tx);
      } else {
        const link = await images.findHistoryEntry(source.historyId, image.id, tx);
        allowed = link !== null && image.storageState === 'ready'
          && await access.canReadHistory({
            entryId: link.entryId, historyId: source.historyId, imageId: image.id, actorOrNull,
          }, tx);
      }
      if (!allowed) throw notFound();

      return variant === 'thumbnail'
        ? { key: image.thumbnailKey, sizeBytes: image.thumbnailSizeBytes, contentType: 'image/webp' }
        : { key: image.displayKey, sizeBytes: image.displaySizeBytes, contentType: 'image/webp' };
    });
  }
}
