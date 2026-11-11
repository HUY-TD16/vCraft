import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type {
  AllocationEventDto,
  PersistedAllocationLogRecord,
} from '../../../application/dtos/trading-persistence.dtos';
import type { IAllocationLogRepository } from '../../../application/ports/repositories/trading-repositories.port';
import type { AllocationLogRecord } from '../../../domain';
import { AllocationLogMapper } from '../mappers/allocation-log.mapper';
import { idToBigInt } from '../mappers/shared-persistence.mapper';

@Injectable()
export class PrismaAllocationLogRepository implements IAllocationLogRepository {
  constructor(
    @Inject(PrismaTransactionRunner)
    private readonly txRunner: PrismaTransactionRunner,
  ) {}

  async create(
    record: AllocationLogRecord & { readonly id?: Id },
    tx: TransactionContext,
  ): Promise<PersistedAllocationLogRecord> {
    const client = this.txRunner.getClient(tx);
    const createdRow = await client.allocationLog.create({
      data: AllocationLogMapper.toPrismaCreateInput(record),
    });
    return AllocationLogMapper.toDomain(createdRow);
  }

  async createMany(
    records: readonly (AllocationLogRecord & { readonly id?: Id })[],
    tx: TransactionContext,
  ): Promise<readonly PersistedAllocationLogRecord[]> {
    const client = this.txRunner.getClient(tx);

    if (records.length === 0) {
      return [];
    }

    const created: PersistedAllocationLogRecord[] = [];
    for (const record of records) {
      const row = await client.allocationLog.create({
        data: AllocationLogMapper.toPrismaCreateInput(record),
      });
      created.push(AllocationLogMapper.toDomain(row));
    }

    return created;
  }

  async listByAllocationId(
    allocationId: Id,
    tx: TransactionContext,
  ): Promise<readonly PersistedAllocationLogRecord[]> {
    const client = this.txRunner.getClient(tx);
    const rows = await client.allocationLog.findMany({
      where: {
        allocation_id: idToBigInt(
          allocationId,
          'allocation_log.allocation_id',
        ),
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => AllocationLogMapper.toDomain(row));
  }

  async listEventsByAllocationId(
    allocationId: Id,
    tx: TransactionContext,
  ): Promise<readonly AllocationEventDto[]> {
    const client = this.txRunner.getClient(tx);
    const rows = await client.allocationLog.findMany({
      where: {
        allocation_id: idToBigInt(
          allocationId,
          'allocation_log.allocation_id',
        ),
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

    return rows.map((row) =>
      AllocationLogMapper.fromPrismaWithActorToDto(row),
    );
  }
}
