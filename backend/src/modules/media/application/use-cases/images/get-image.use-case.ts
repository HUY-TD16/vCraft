import type { TransactionRunner } from '../../../../../common/application/ports/transaction-runner';
import type { Id, TrustedActor } from '../../../../../common/application/types/contract-types';
import { BusinessRuleException } from '../../../../../common/domain/errors/business-rule.exception';
import { canReadPendingImage, isCurrentImageOf } from '../../../domain/policies/image-reading.policy';
import type { ImageContextType } from '../../../domain/value-objects/image-context';
import type { ImageVariant } from '../../../domain/value-objects/image-variant';
import type { ImageAccessResolver } from '../../ports/image-access-resolver.port';
import type { IImageRepository, IUploadReservationRepository } from '../../ports/repositories/media-repositories.port';

export type ImageSource =
  | { readonly kind: 'pending'; readonly imageId: Id }
  | { readonly kind: 'current'; readonly contextType: ImageContextType; readonly contextId: Id; readonly imageId: Id }
  | { readonly kind: 'history'; readonly historyId: Id; readonly imageId: Id };

export interface GetImageCommand {
  readonly actorOrNull: TrustedActor | null;
  readonly source: ImageSource;
  readonly variant: ImageVariant;
}

/** Tệp cần trả về. Controller đọc `key` từ kho; `key` không bao giờ ra khỏi backend. */
export interface ImageReadTarget {
  readonly key: string;
  readonly sizeBytes: bigint;
  readonly contentType: 'image/webp';
}

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
