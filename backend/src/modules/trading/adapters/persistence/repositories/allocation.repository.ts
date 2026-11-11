import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../../../generated/prisma/client';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type { IAllocationRepository } from '../../../application/ports/repositories/trading-repositories.port';
import {
  type Allocation,
  type AllocationLogRecord,
  ConcurrencyConflictError,
  EntityId,
  TRADING_INVARIANTS,
} from '../../../domain';
import { AllocationBatchMapper } from '../mappers/allocation-batch.mapper';
import { AllocationLogMapper } from '../mappers/allocation-log.mapper';
import { AllocationMapper } from '../mappers/allocation.mapper';
import { idToBigInt } from '../mappers/shared-persistence.mapper';

@Injectable()
export class PrismaAllocationRepository implements IAllocationRepository {
  constructor(
    @Inject(PrismaTransactionRunner)
    private readonly txRunner: PrismaTransactionRunner,
  ) {}

  async create(
    input: {
      readonly allocation: Allocation;
      readonly log?: AllocationLogRecord;
    },
    tx: TransactionContext,
  ): Promise<Allocation> {
    const client = this.txRunner.getClient(tx);

    let createdRow;
    try {
      createdRow = await client.allocation.create({
        data: AllocationMapper.toPrismaCreateInput(input.allocation),
        include: {
          allocationBatches: {
            orderBy: { id: 'asc' },
          },
        },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConcurrencyConflictError(
          `An Allocation already exists for request ${input.allocation.request_id} and workshop ${input.allocation.workshop_id}.`,
          {
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
            entity: 'Allocation',
          },
        );
      }
      throw error;
    }

    if (input.log) {
      await client.allocationLog.create({
        data: AllocationLogMapper.toPrismaCreateInput({
          ...input.log,
          allocation_id: createdRow.id.toString(),
        }),
      });
    }

    return AllocationMapper.toDomain(createdRow);
  }

  async createMany(
    entries: readonly {
      readonly allocation: Allocation;
      readonly log: AllocationLogRecord;
    }[],
    tx: TransactionContext,
  ): Promise<readonly Allocation[]> {
    const client = this.txRunner.getClient(tx);

    if (entries.length === 0) {
      return [];
    }

    const sortedEntries = [...entries].sort((a, b) =>
      EntityId.compare(a.allocation.workshop_id, b.allocation.workshop_id),
    );

    const created: Allocation[] = [];
    for (const entry of sortedEntries) {
      const item = await this.create(entry, tx);
      created.push(item);
    }

    // Keep reference to client to verify tx even if loop is skipped
    void client;
    return created;
  }

  async update(
    input: {
      readonly allocation: Allocation;
      readonly expectedVersion?: number;
      readonly logs?: readonly AllocationLogRecord[];
      readonly syncBatchLinks?: boolean;
    },
    tx: TransactionContext,
  ): Promise<Allocation> {
    const client = this.txRunner.getClient(tx);
    const allocationIdBigInt = idToBigInt(
      input.allocation.id,
      'allocation.id',
    );
    const expectedVersion =
      input.expectedVersion ?? input.allocation.version - 1;

    if (expectedVersion < 1) {
      throw new ConcurrencyConflictError(
        `Invalid expectedVersion (${expectedVersion}) when updating Allocation ${input.allocation.id}.`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'Allocation',
        },
      );
    }

    const updateResult = await client.allocation.updateMany({
      where: {
        id: allocationIdBigInt,
        version: expectedVersion,
      },
      data: AllocationMapper.toPrismaUpdateInput(input.allocation),
    });

    if (updateResult.count !== 1) {
      throw new ConcurrencyConflictError(
        `Allocation ${input.allocation.id} version conflict (expected version ${expectedVersion}).`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'Allocation',
        },
      );
    }

    if (input.syncBatchLinks) {
      await client.allocationBatch.deleteMany({
        where: { allocation_id: allocationIdBigInt },
      });

      const sortedLinks = [...input.allocation.batch_links].sort((a, b) =>
        EntityId.compare(a.batch_id, b.batch_id),
      );
      for (const link of sortedLinks) {
        await client.allocationBatch.create({
          data: AllocationBatchMapper.toPrismaCreateInput(link, false),
        });
      }
    }

    if (input.logs && input.logs.length > 0) {
      for (const log of input.logs) {
        await client.allocationLog.create({
          data: AllocationLogMapper.toPrismaCreateInput(log),
        });
      }
    }

    const updatedRow = await client.allocation.findUnique({
      where: { id: allocationIdBigInt },
      include: {
        allocationBatches: {
          orderBy: { id: 'asc' },
        },
      },
    });

    if (!updatedRow) {
      throw new ConcurrencyConflictError(
        `Allocation ${input.allocation.id} was not found after update.`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'Allocation',
        },
      );
    }

    return AllocationMapper.toDomain(updatedRow);
  }

  async findById(
    allocationId: Id,
    tx: TransactionContext,
  ): Promise<Allocation | null> {
    const client = this.txRunner.getClient(tx);
    const row = await client.allocation.findUnique({
      where: { id: idToBigInt(allocationId, 'allocation.id') },
      include: {
        allocationBatches: {
          orderBy: { id: 'asc' },
        },
      },
    });
    return row ? AllocationMapper.toDomain(row) : null;
  }

  async findByRequestAndWorkshop(
    requestId: Id,
    workshopId: Id,
    tx: TransactionContext,
  ): Promise<Allocation | null> {
    const client = this.txRunner.getClient(tx);
    const row = await client.allocation.findUnique({
      where: {
        request_id_workshop_id: {
          request_id: idToBigInt(requestId, 'allocation.request_id'),
          workshop_id: idToBigInt(workshopId, 'allocation.workshop_id'),
        },
      },
      include: {
        allocationBatches: {
          orderBy: { id: 'asc' },
        },
      },
    });
    return row ? AllocationMapper.toDomain(row) : null;
  }

  async listByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly Allocation[]> {
    const client = this.txRunner.getClient(tx);
    const rows = await client.allocation.findMany({
      where: { request_id: idToBigInt(requestId, 'allocation.request_id') },
      include: {
        allocationBatches: {
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => AllocationMapper.toDomain(row));
  }

  async listByWorkshopId(
    workshopId: Id,
    tx: TransactionContext,
  ): Promise<readonly Allocation[]> {
    const client = this.txRunner.getClient(tx);
    const rows = await client.allocation.findMany({
      where: { workshop_id: idToBigInt(workshopId, 'allocation.workshop_id') },
      include: {
        allocationBatches: {
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { id: 'desc' },
    });
    return rows.map((row) => AllocationMapper.toDomain(row));
  }

  async lockById(
    allocationId: Id,
    tx: TransactionContext,
  ): Promise<Allocation | null> {
    const client = this.txRunner.getClient(tx);
    const idBigInt = idToBigInt(allocationId, 'allocation.id');

    const lockedRows = await client.$queryRaw<Array<{ id: bigint }>>(
      Prisma.sql`SELECT "id" FROM "Allocation" WHERE "id" = ${idBigInt} FOR UPDATE`,
    );

    if (lockedRows.length === 0) {
      return null;
    }

    const row = await client.allocation.findUnique({
      where: { id: idBigInt },
      include: {
        allocationBatches: {
          orderBy: { id: 'asc' },
        },
      },
    });
    return row ? AllocationMapper.toDomain(row) : null;
  }

  async lockByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly Allocation[]> {
    const client = this.txRunner.getClient(tx);
    const reqBigInt = idToBigInt(requestId, 'allocation.request_id');

    const lockedRows = await client.$queryRaw<Array<{ id: bigint }>>(
      Prisma.sql`SELECT "id" FROM "Allocation" WHERE "request_id" = ${reqBigInt} ORDER BY "id" ASC FOR UPDATE`,
    );

    if (lockedRows.length === 0) {
      return [];
    }

    const rows = await client.allocation.findMany({
      where: { id: { in: lockedRows.map((r) => r.id) } },
      include: {
        allocationBatches: {
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
    });

    return rows.map((row) => AllocationMapper.toDomain(row));
  }

  async lockByIds(
    allocationIds: readonly Id[],
    tx: TransactionContext,
  ): Promise<readonly Allocation[]> {
    const client = this.txRunner.getClient(tx);
    const uniqueSortedIds = EntityId.sortAscending(
      Array.from(new Set(allocationIds)),
    );

    if (uniqueSortedIds.length === 0) {
      return [];
    }

    const idBigInts = uniqueSortedIds.map((id) =>
      idToBigInt(id, 'allocation.id'),
    );

    const lockedRows = await client.$queryRaw<Array<{ id: bigint }>>(
      Prisma.sql`SELECT "id" FROM "Allocation" WHERE "id" IN (${Prisma.join(idBigInts)}) ORDER BY "id" ASC FOR UPDATE`,
    );

    if (lockedRows.length === 0) {
      return [];
    }

    const rows = await client.allocation.findMany({
      where: { id: { in: lockedRows.map((r) => r.id) } },
      include: {
        allocationBatches: {
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
    });

    return rows.map((row) => AllocationMapper.toDomain(row));
  }
}
