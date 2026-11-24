import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { Prisma } from '../../../../../generated/prisma/client';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type {
  IUploadReservationRepository, NewUploadReservation, UploadReservationRecord,
} from '../../../application/ports/repositories/media-repositories.port';
import type { UploadReservationState } from '../../../domain/entities/upload-reservation.entity';
import {
  idToBigInt, nullableIdToBigInt, toReservationRecord, type ReservationRow,
} from '../mappers/media-persistence.mapper';

@Injectable()
export class PrismaUploadReservationRepository implements IUploadReservationRepository {
  constructor(@Inject(PrismaTransactionRunner) private readonly runner: PrismaTransactionRunner) {}

  async databaseNow(tx: TransactionContext): Promise<Date> {
    // clock_timestamp() là giờ thực tại thời điểm gọi; now() chỉ là giờ BẮT ĐẦU giao dịch (cũ nếu phải chờ khóa).
    const rows = await this.runner.getClient(tx).$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT clock_timestamp() AS "now"`);
    const row = rows[0];
    if (!row) throw new Error('Database clock unavailable');
    return row.now;
  }

  async create(input: NewUploadReservation, tx: TransactionContext): Promise<UploadReservationRecord> {
    const row = await this.runner.getClient(tx).uploadReservation.create({
      data: {
        quota_id: idToBigInt(input.quotaId),
        uploaded_by: idToBigInt(input.uploadedBy),
        context_type: input.contextType,
        context_id: nullableIdToBigInt(input.contextId),
        budget_bytes: input.budgetBytes,
        status: 'reserved',
        storage_prefix: input.storagePrefix,
        expires_at: input.expiresAt,
      },
    });
    return toReservationRecord(row);
  }

  async findById(reservationId: Id, tx: TransactionContext): Promise<UploadReservationRecord | null> {
    const row = await this.runner.getClient(tx).uploadReservation.findUnique({ where: { id: idToBigInt(reservationId) } });
    return row ? toReservationRecord(row) : null;
  }

  async lockById(reservationId: Id, tx: TransactionContext): Promise<UploadReservationRecord | null> {
    const rows = await this.runner.getClient(tx).$queryRaw<ReservationRow[]>(Prisma.sql`
      SELECT "id", "quota_id", "uploaded_by", "context_type", "context_id", "budget_bytes", "actual_bytes",
             "status", "storage_prefix", "expires_at"
      FROM "UploadReservation" WHERE "id" = ${idToBigInt(reservationId)} FOR UPDATE`);
    return rows[0] ? toReservationRecord(rows[0]) : null;
  }

  async saveState(reservationId: Id, state: UploadReservationState, tx: TransactionContext): Promise<void> {
    await this.runner.getClient(tx).uploadReservation.update({
      where: { id: idToBigInt(reservationId) },
      data: { status: state.status, actual_bytes: state.actualBytes },
    });
  }
}
