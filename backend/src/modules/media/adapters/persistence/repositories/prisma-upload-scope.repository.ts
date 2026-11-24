import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import { Prisma } from '../../../../../generated/prisma/client';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type { IUploadScopeRepository, UploadScopeRecord } from '../../../application/ports/repositories/media-repositories.port';
import { isUuid, toScopeRecord, type ScopeRow } from '../mappers/media-persistence.mapper';

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
}
