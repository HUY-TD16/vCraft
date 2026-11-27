import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { Prisma } from '../../../../../generated/prisma/client';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type { IUploadScopeRepository, UploadScopeRecord } from '../../../application/ports/repositories/media-repositories.port';
import { idToBigInt, isUuid, toScopeRecord, type ScopeRow } from '../mappers/media-persistence.mapper';

@Injectable()
export class PrismaUploadScopeRepository implements IUploadScopeRepository {
  constructor(@Inject(PrismaTransactionRunner) private readonly runner: PrismaTransactionRunner) {}

  async lockByKey(initialWorkshopKey: string, tx: TransactionContext): Promise<UploadScopeRecord | null> {
    // Khóa sai định dạng UUID coi như không tồn tại (404), không để Postgres ném lỗi cú pháp.
    if (!isUuid(initialWorkshopKey)) return null;
    const rows = await this.runner.getClient(tx).$queryRaw<ScopeRow[]>(Prisma.sql`
      SELECT "initial_workshop_key"::text AS "initial_workshop_key", "created_by", "status", "expires_at"
      FROM "InitialWorkshopUploadScope"
      WHERE "initial_workshop_key" = ${initialWorkshopKey}::uuid FOR UPDATE`);
    return rows[0] ? toScopeRecord(rows[0]) : null;
  }

  async countOpenUnexpired(adminId: Id, now: Date, tx: TransactionContext): Promise<number> {
    return this.runner.getClient(tx).initialWorkshopUploadScope.count({
      where: { created_by: idToBigInt(adminId), status: 'open', expires_at: { gt: now } },
    });
  }

  async create(
    input: { adminId: Id; expiresAt: Date; quotaLimitBytes: bigint },
    tx: TransactionContext,
  ): Promise<UploadScopeRecord> {
    const client = this.runner.getClient(tx);
    const scope = await client.initialWorkshopUploadScope.create({
      data: { created_by: idToBigInt(input.adminId), status: 'open', expires_at: input.expiresAt },
    });
    await client.storageQuota.create({
      data: { initial_workshop_key: scope.initial_workshop_key, limit_bytes: input.quotaLimitBytes },
    });
    return toScopeRecord(scope);
  }

  async markAttached(initialWorkshopKey: string, workshopId: Id, tx: TransactionContext): Promise<void> {
    await this.runner.getClient(tx).initialWorkshopUploadScope.update({
      where: { initial_workshop_key: initialWorkshopKey },
      data: { status: 'attached', attached_workshop_id: idToBigInt(workshopId) },
    });
  }
}
