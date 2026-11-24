import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { Prisma } from '../../../../../generated/prisma/client';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type {
  IStorageQuotaRepository, StorageQuotaRecord,
} from '../../../application/ports/repositories/media-repositories.port';
import {
  idToBigInt, isUuid, toQuotaRecord, type QuotaRow,
} from '../mappers/media-persistence.mapper';

/** Khóa advisory dùng chung cho toàn bộ điều phối dung lượng kho ("khóa kho" trong data-design 2.27). */
export const STORAGE_BUDGET_LOCK_KEY = BigInt('7301000000001');

@Injectable()
export class PrismaStorageQuotaRepository implements IStorageQuotaRepository {
  constructor(@Inject(PrismaTransactionRunner) private readonly runner: PrismaTransactionRunner) {}

  async lockStorageBudget(tx: TransactionContext): Promise<void> {
    // ::text vì Prisma không giải mã được kiểu `void` mà pg_advisory_xact_lock trả về.
    await this.runner.getClient(tx).$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(${STORAGE_BUDGET_LOCK_KEY})::text AS locked`,
    );
  }

  async lockOrCreateWorkshopQuota(workshopId: Id, limitBytes: bigint, tx: TransactionContext): Promise<StorageQuotaRecord> {
    const client = this.runner.getClient(tx);
    const workshop = idToBigInt(workshopId);
    // updated_at do Prisma quản lý (@updatedAt) nên cột không có DEFAULT: phải truyền khi INSERT thô.
    await client.$executeRaw(Prisma.sql`
      INSERT INTO "StorageQuota" ("workshop_id", "limit_bytes", "used_bytes", "reserved_bytes", "updated_at")
      VALUES (${workshop}, ${limitBytes}, 0, 0, now())
      ON CONFLICT ("workshop_id") DO NOTHING`);
    const rows = await client.$queryRaw<QuotaRow[]>(Prisma.sql`
      SELECT "id", "limit_bytes", "used_bytes", "reserved_bytes" FROM "StorageQuota"
      WHERE "workshop_id" = ${workshop} FOR UPDATE`);
    const row = rows[0];
    if (!row) throw new Error('Workshop quota missing after upsert');
    return toQuotaRecord(row);
  }

  async lockScopeQuota(initialWorkshopKey: string, tx: TransactionContext): Promise<StorageQuotaRecord | null> {
    if (!isUuid(initialWorkshopKey)) return null;
    const rows = await this.runner.getClient(tx).$queryRaw<QuotaRow[]>(Prisma.sql`
      SELECT "id", "limit_bytes", "used_bytes", "reserved_bytes" FROM "StorageQuota"
      WHERE "initial_workshop_key" = ${initialWorkshopKey}::uuid FOR UPDATE`);
    return rows[0] ? toQuotaRecord(rows[0]) : null;
  }

  async lockById(quotaId: Id, tx: TransactionContext): Promise<StorageQuotaRecord | null> {
    const rows = await this.runner.getClient(tx).$queryRaw<QuotaRow[]>(Prisma.sql`
      SELECT "id", "limit_bytes", "used_bytes", "reserved_bytes" FROM "StorageQuota"
      WHERE "id" = ${idToBigInt(quotaId)} FOR UPDATE`);
    return rows[0] ? toQuotaRecord(rows[0]) : null;
  }

  async save(record: StorageQuotaRecord, tx: TransactionContext): Promise<void> {
    await this.runner.getClient(tx).storageQuota.update({
      where: { id: idToBigInt(record.id) },
      data: { used_bytes: record.state.usedBytes, reserved_bytes: record.state.reservedBytes },
    });
  }

  async sumReservedBytes(tx: TransactionContext): Promise<bigint> {
    const result = await this.runner.getClient(tx).storageQuota.aggregate({ _sum: { reserved_bytes: true } });
    return result._sum.reserved_bytes ?? BigInt(0);
  }

  async sumInitialScopeBytes(adminId: Id, tx: TransactionContext): Promise<bigint> {
    const result = await this.runner.getClient(tx).storageQuota.aggregate({
      _sum: { used_bytes: true, reserved_bytes: true },
      where: { initialWorkshop: { created_by: idToBigInt(adminId) } },
    });
    return (result._sum.used_bytes ?? BigInt(0)) + (result._sum.reserved_bytes ?? BigInt(0));
  }
}
