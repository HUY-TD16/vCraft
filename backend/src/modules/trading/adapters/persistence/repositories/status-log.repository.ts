import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import type { Prisma } from '../../../../../generated/prisma/client';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type {
  PersistedStatusLogRecord,
  RequestEventDto,
} from '../../../application/dtos/trading-persistence.dtos';
import type {
  FindStatusLogEventsInput,
  FindStatusLogEventsResult,
  IStatusLogRepository,
} from '../../../application/ports/repositories/trading-repositories.port';
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

  async findEventsWithPagination(
    input: FindStatusLogEventsInput,
    tx?: TransactionContext,
  ): Promise<FindStatusLogEventsResult> {
    if (tx) {
      return this.executeFindEventsWithPagination(
        this.txRunner.getClient(tx),
        input,
      );
    }
    return this.txRunner.run(async (innerTx) => {
      return this.executeFindEventsWithPagination(
        this.txRunner.getClient(innerTx),
        input,
      );
    });
  }

  private async executeFindEventsWithPagination(
    client: Prisma.TransactionClient,
    input: FindStatusLogEventsInput,
  ): Promise<FindStatusLogEventsResult> {
    const requestIdBigInt = idToBigInt(
      input.requestId,
      'status_log.request_id',
    );
    const page = input.page && input.page > 0 ? input.page : 1;
    const limit = input.limit && input.limit > 0 ? input.limit : 20;
    const skip = (page - 1) * limit;
    const take = limit;

    const where = {
      request_id: requestIdBigInt,
    };

    const [totalRecords, rows] = await Promise.all([
      client.statusLog.count({ where }),
      client.statusLog.findMany({
        where,
        include: {
          performedBy: {
            select: {
              id: true,
              display_name: true,
            },
          },
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
    ]);

    const items = rows.map((row) =>
      StatusLogMapper.fromPrismaWithActorToDto(row),
    );

    return {
      rows: items,
      totalRecords,
      items,
      total: totalRecords,
    };
  }
}
