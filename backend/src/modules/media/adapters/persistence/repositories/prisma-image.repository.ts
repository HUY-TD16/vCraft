import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { Prisma } from '../../../../../generated/prisma/client';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type {
  IImageRepository, ImageRecord, ImageStateRecord, NewImage,
} from '../../../application/ports/repositories/media-repositories.port';
import type { ImageContextType } from '../../../domain/value-objects/image-context';
import {
  bigintToId, idToBigInt, nullableIdToBigInt, toImageRecord, toImageStateRecord,
} from '../mappers/media-persistence.mapper';

/** Vùng khóa advisory dành cho khóa theo đối tượng của media (khác khóa kho dùng bigint đơn). */
export const CONTEXT_LOCK_NAMESPACE = 7302;

const WITH_QUOTA_WORKSHOP = { quota: { select: { workshop_id: true } } } as const;

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

  async findById(imageId: Id, tx: TransactionContext): Promise<ImageStateRecord | null> {
    const row = await this.runner.getClient(tx).image.findUnique({
      where: { id: idToBigInt(imageId) }, include: WITH_QUOTA_WORKSHOP,
    });
    return row ? toImageStateRecord(row) : null;
  }

  async lockByIds(imageIds: readonly Id[], tx: TransactionContext): Promise<ImageStateRecord[]> {
    if (imageIds.length === 0) return [];
    const client = this.runner.getClient(tx);
    const ids = imageIds.map(idToBigInt);
    // ORDER BY id: mọi giao dịch khóa cùng một thứ tự nên không tạo deadlock. Dữ liệu đọc qua model sau khi đã khóa.
    const locked = await client.$queryRaw<Array<{ id: bigint }>>(Prisma.sql`
      SELECT "id" FROM "Image" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`);
    if (locked.length === 0) return [];
    const rows = await client.image.findMany({
      where: { id: { in: locked.map(row => row.id) } }, orderBy: { id: 'asc' }, include: WITH_QUOTA_WORKSHOP,
    });
    return rows.map(toImageStateRecord);
  }

  async lockContext(contextType: ImageContextType, contextId: Id, tx: TransactionContext): Promise<void> {
    // Hai số nguyên: (vùng khóa riêng của media, băm đối tượng). Va chạm băm chỉ gây tuần tự hóa thừa, không sai.
    await this.runner.getClient(tx).$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(${CONTEXT_LOCK_NAMESPACE}, hashtext(${`${contextType}:${contextId}`}))::text AS locked`);
  }

  async listAttachedIds(contextType: ImageContextType, contextId: Id, tx: TransactionContext): Promise<Id[]> {
    const rows = await this.runner.getClient(tx).image.findMany({
      where: { context_type: contextType, context_id: idToBigInt(contextId), is_attached: true },
      select: { id: true }, orderBy: { id: 'asc' },
    });
    return rows.map(row => bigintToId(row.id));
  }

  async markAttached(imageIds: readonly Id[], contextId: Id, tx: TransactionContext): Promise<void> {
    await this.runner.getClient(tx).image.updateMany({
      where: { id: { in: imageIds.map(idToBigInt) } },
      data: { is_attached: true, context_id: idToBigInt(contextId), unreferenced_at: null },
    });
  }

  async markDetached(imageIds: readonly Id[], at: Date, tx: TransactionContext): Promise<void> {
    await this.runner.getClient(tx).image.updateMany({
      where: { id: { in: imageIds.map(idToBigInt) } },
      data: { is_attached: false, unreferenced_at: at },
    });
  }

  async addHistoryLinks(historyId: Id, imageIds: readonly Id[], tx: TransactionContext): Promise<void> {
    if (imageIds.length === 0) return;
    await this.runner.getClient(tx).journalHistoryImage.createMany({
      data: imageIds.map((imageId, position) => ({
        history_id: idToBigInt(historyId), image_id: idToBigInt(imageId), position,
      })),
    });
  }

  async findHistoryEntry(historyId: Id, imageId: Id, tx: TransactionContext): Promise<{ readonly entryId: Id } | null> {
    const row = await this.runner.getClient(tx).journalHistoryImage.findUnique({
      where: { history_id_image_id: { history_id: idToBigInt(historyId), image_id: idToBigInt(imageId) } },
      select: { history: { select: { journal_entry_id: true } } },
    });
    return row ? { entryId: bigintToId(row.history.journal_entry_id) } : null;
  }

  async isReferencedByHistory(imageId: Id, tx: TransactionContext): Promise<boolean> {
    return (await this.runner.getClient(tx).journalHistoryImage.count({ where: { image_id: idToBigInt(imageId) } })) > 0;
  }
}
