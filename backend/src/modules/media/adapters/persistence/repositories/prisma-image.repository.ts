import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type { IImageRepository, ImageRecord, NewImage } from '../../../application/ports/repositories/media-repositories.port';
import { idToBigInt, nullableIdToBigInt, toImageRecord } from '../mappers/media-persistence.mapper';

@Injectable()
export class PrismaImageRepository implements IImageRepository {
  constructor(@Inject(PrismaTransactionRunner) private readonly runner: PrismaTransactionRunner) {}

  async create(input: NewImage, tx: TransactionContext): Promise<ImageRecord> {
    const row = await this.runner.getClient(tx).image.create({
      data: {
        uploaded_by: idToBigInt(input.uploadedBy),
        context_type: input.contextType,
        context_id: nullableIdToBigInt(input.contextId),
        // Không lưu ảnh gốc: storage_key để null, original_size_bytes = 0 (data-design 2.20).
        thumbnail_key: input.thumbnailKey,
        display_key: input.displayKey,
        original_size_bytes: 0,
        thumbnail_size_bytes: input.thumbnailSizeBytes,
        display_size_bytes: input.displaySizeBytes,
        quota_id: idToBigInt(input.quotaId),
        reservation_id: idToBigInt(input.reservationId),
        width: input.width,
        height: input.height,
        unreferenced_at: input.unreferencedAt,
        storage_state: 'ready',
        is_attached: false,
      },
    });
    return toImageRecord(row);
  }
}
