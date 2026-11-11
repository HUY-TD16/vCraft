import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type { IAllocationBatchRepository } from '../../../application/ports/repositories/trading-repositories.port';
import {
  type AllocationBatchLink,
  EntityId,
  InvalidTradingInputError,
  TRADING_INVARIANTS,
} from '../../../domain';
import { AllocationBatchMapper } from '../mappers/allocation-batch.mapper';
import { idToBigInt } from '../mappers/shared-persistence.mapper';

@Injectable()
export class PrismaAllocationBatchRepository
  implements IAllocationBatchRepository
{
  constructor(
    @Inject(PrismaTransactionRunner)
    private readonly txRunner: PrismaTransactionRunner,
  ) {}

  async replaceForAllocation(
    input: {
      readonly allocationId: Id;
      readonly workshopId: Id;
      readonly links: readonly AllocationBatchLink[];
    },
    tx: TransactionContext,
  ): Promise<readonly AllocationBatchLink[]> {
    const client = this.txRunner.getClient(tx);
    const normalizedAllocationId = EntityId.of(
      input.allocationId,
      'allocation_batch.allocation_id',
    ).value;
    const normalizedWorkshopId = EntityId.of(
      input.workshopId,
      'allocation_batch.workshop_id',
    ).value;

    const seenBatches = new Set<string>();
    for (const link of input.links) {
      if (
        link.allocation_id !== normalizedAllocationId ||
        link.workshop_id !== normalizedWorkshopId
      ) {
        throw new InvalidTradingInputError(
          'All AllocationBatchLink items must match allocationId and workshopId.',
          {
            invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
            entity: 'AllocationBatchLink',
          },
        );
      }
      if (seenBatches.has(link.batch_id)) {
        throw new InvalidTradingInputError(
          `Duplicate batch_id (${link.batch_id}) in AllocationBatchLink replacement set.`,
          {
            invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
            field: 'batch_id',
          },
        );
      }
      seenBatches.add(link.batch_id);
    }

    const allocationIdBigInt = idToBigInt(
      normalizedAllocationId,
      'allocation_batch.allocation_id',
    );

    await client.allocationBatch.deleteMany({
      where: {
        allocation_id: allocationIdBigInt,
      },
    });

    if (input.links.length === 0) {
      return [];
    }

    const sortedLinks = [...input.links].sort((a, b) =>
      EntityId.compare(a.batch_id, b.batch_id),
    );

    const created: AllocationBatchLink[] = [];
    for (const link of sortedLinks) {
      const row = await client.allocationBatch.create({
        data: AllocationBatchMapper.toPrismaCreateInput(link),
      });
      created.push(AllocationBatchMapper.toDomain(row));
    }

    return created;
  }

  async listByAllocationId(
    allocationId: Id,
    tx: TransactionContext,
  ): Promise<readonly AllocationBatchLink[]> {
    const client = this.txRunner.getClient(tx);
    const rows = await client.allocationBatch.findMany({
      where: {
        allocation_id: idToBigInt(
          allocationId,
          'allocation_batch.allocation_id',
        ),
      },
      orderBy: [{ linked_at: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => AllocationBatchMapper.toDomain(row));
  }
}
