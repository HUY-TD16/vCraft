import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { PAGINATION } from '../../../../../common/application/types/pagination';
import type { Prisma } from '../../../../../generated/prisma/client';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type {
  FindAllocationBatchesInput,
  FindAllocationBatchesResult,
  IAllocationBatchRepository,
} from '../../../application/ports/repositories/trading-repositories.port';
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

    const createInputs = sortedLinks.map((link) =>
      AllocationBatchMapper.toPrismaCreateInput(link),
    );

    if (typeof client.allocationBatch.createManyAndReturn === 'function') {
      const rows = await client.allocationBatch.createManyAndReturn({
        data: createInputs,
      });
      return rows.map((row) => AllocationBatchMapper.toDomain(row));
    }

    const created: AllocationBatchLink[] = [];
    for (const data of createInputs) {
      const row = await client.allocationBatch.create({ data });
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

  async findBatchesWithPagination(
    input: FindAllocationBatchesInput,
    tx?: TransactionContext,
  ): Promise<FindAllocationBatchesResult> {
    if (tx) {
      return this.executeFindBatchesWithPagination(
        this.txRunner.getClient(tx),
        input,
      );
    }
    return this.txRunner.run(async (innerTx) => {
      return this.executeFindBatchesWithPagination(
        this.txRunner.getClient(innerTx),
        input,
      );
    });
  }

  private async executeFindBatchesWithPagination(
    client: Prisma.TransactionClient,
    input: FindAllocationBatchesInput,
  ): Promise<FindAllocationBatchesResult> {
    const allocationIdBigInt = idToBigInt(
      input.allocationId,
      'allocation_batch.allocation_id',
    );
    const page =
      input.page && Number.isSafeInteger(input.page) && input.page > 0
        ? input.page
        : PAGINATION.defaultPage;
    const limit =
      input.limit && Number.isSafeInteger(input.limit) && input.limit > 0
        ? Math.min(input.limit, PAGINATION.maxLimit)
        : PAGINATION.defaultLimit;
    const skip = (page - 1) * limit;
    const take = limit;

    const where = {
      allocation_id: allocationIdBigInt,
    };

    const [totalRecords, rows] = await Promise.all([
      client.allocationBatch.count({ where }),
      client.allocationBatch.findMany({
        where,
        include: {
          batch: {
            select: {
              id: true,
              name: true,
              status: true,
              qr_token: true,
            },
          },
        },
        orderBy: [{ linked_at: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
    ]);

    return {
      rows: rows.map((row) =>
        AllocationBatchMapper.fromPrismaWithBatchToDto(row),
      ),
      totalRecords,
    };
  }
}
