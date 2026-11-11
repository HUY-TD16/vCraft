import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type {
  PersistedStatusLogRecord,
  RequestEventDto,
} from '../../../application/dtos/trading-persistence.dtos';
import type { IStatusLogRepository } from '../../../application/ports/repositories/trading-repositories.port';
import type { StatusLogRecord } from '../../../domain';
import { idToBigInt } from '../mappers/shared-persistence.mapper';
import { StatusLogMapper } from '../mappers/status-log.mapper';

@Injectable()
export class PrismaStatusLogRepository implements IStatusLogRepository {
  constructor(
    @Inject(PrismaTransactionRunner)
    private readonly txRunner: PrismaTransactionRunner,
  ) {}

  async create(
    record: StatusLogRecord & { readonly id?: Id },
    tx: TransactionContext,
  ): Promise<PersistedStatusLogRecord> {
    const client = this.txRunner.getClient(tx);
    const createdRow = await client.statusLog.create({
      data: StatusLogMapper.toPrismaCreateInput(record),
    });
    return StatusLogMapper.toDomain(createdRow);
  }

  async createMany(
    records: readonly (StatusLogRecord & { readonly id?: Id })[],
    tx: TransactionContext,
  ): Promise<readonly PersistedStatusLogRecord[]> {
    const client = this.txRunner.getClient(tx);

    if (records.length === 0) {
      return [];
    }

    const created: PersistedStatusLogRecord[] = [];
    for (const record of records) {
      const row = await client.statusLog.create({
        data: StatusLogMapper.toPrismaCreateInput(record),
      });
      created.push(StatusLogMapper.toDomain(row));
    }

    return created;
  }

  async listByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly PersistedStatusLogRecord[]> {
    const client = this.txRunner.getClient(tx);
    const rows = await client.statusLog.findMany({
      where: {
        request_id: idToBigInt(requestId, 'status_log.request_id'),
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => StatusLogMapper.toDomain(row));
  }

  async listEventsByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly RequestEventDto[]> {
    const client = this.txRunner.getClient(tx);
    const rows = await client.statusLog.findMany({
      where: {
        request_id: idToBigInt(requestId, 'status_log.request_id'),
      },
      include: {
        performedBy: {
          select: {
            id: true,
            display_name: true,
          },
        },
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });

    return rows.map((row) => StatusLogMapper.fromPrismaWithActorToDto(row));
  }
}
