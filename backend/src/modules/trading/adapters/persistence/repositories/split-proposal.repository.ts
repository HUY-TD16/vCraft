import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../../../generated/prisma/client';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type { ISplitProposalRepository } from '../../../application/ports/repositories/trading-repositories.port';
import {
  ConcurrencyConflictError,
  EntityId,
  type SplitProposal,
  type SplitProposalExpireReason,
  TRADING_INVARIANTS,
} from '../../../domain';
import { bigintToId, idToBigInt } from '../mappers/shared-persistence.mapper';
import { SplitProposalItemMapper } from '../mappers/split-proposal-item.mapper';
import { SplitProposalMapper } from '../mappers/split-proposal.mapper';

@Injectable()
export class PrismaSplitProposalRepository implements ISplitProposalRepository {
  constructor(
    @Inject(PrismaTransactionRunner)
    private readonly txRunner: PrismaTransactionRunner,
  ) {}

  async createProposal(
    input: {
      readonly proposal: SplitProposal;
      readonly replacedProposal?: SplitProposal | null;
    },
    tx: TransactionContext,
  ): Promise<SplitProposal> {
    const client = this.txRunner.getClient(tx);

    if (input.replacedProposal) {
      const expectedPrevVersion = input.replacedProposal.version - 1;
      const expireResult = await client.splitProposal.updateMany({
        where: {
          id: idToBigInt(input.replacedProposal.id, 'split_proposal.id'),
          status: 'proposed',
          version: expectedPrevVersion,
        },
        data: SplitProposalMapper.toPrismaUpdateInput(input.replacedProposal),
      });

      if (expireResult.count !== 1) {
        throw new ConcurrencyConflictError(
          `Previous SplitProposal ${input.replacedProposal.id} state changed concurrently before replacement.`,
          {
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
            entity: 'SplitProposal',
          },
        );
      }
    }

    let createdProposalRow;
    try {
      createdProposalRow = await client.splitProposal.create({
        data: SplitProposalMapper.toPrismaCreateInput(input.proposal),
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConcurrencyConflictError(
          `An active "proposed" SplitProposal already exists for request ${input.proposal.request_id}.`,
          {
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
            entity: 'SplitProposal',
          },
        );
      }
      throw error;
    }

    const sortedItems = [...input.proposal.items].sort((a, b) =>
      EntityId.compare(a.workshop_id, b.workshop_id),
    );

    const createdItemRows = [];
    for (const item of sortedItems) {
      const itemRow = await client.splitProposalItem.create({
        data: {
          ...SplitProposalItemMapper.toPrismaCreateInput(item),
          proposal_id: createdProposalRow.id,
        },
      });
      createdItemRows.push(itemRow);
    }

    return SplitProposalMapper.toDomain({
      ...createdProposalRow,
      splitProposalItems: createdItemRows,
    });
  }

  async updateStatus(
    input: {
      readonly proposal: SplitProposal;
      readonly expectedVersion?: number;
    },
    tx: TransactionContext,
  ): Promise<SplitProposal> {
    const client = this.txRunner.getClient(tx);
    const proposalIdBigInt = idToBigInt(
      input.proposal.id,
      'split_proposal.id',
    );
    const expectedVersion =
      input.expectedVersion ?? input.proposal.version - 1;

    if (expectedVersion < 1) {
      throw new ConcurrencyConflictError(
        `Invalid expectedVersion (${expectedVersion}) when updating SplitProposal ${input.proposal.id}.`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'SplitProposal',
        },
      );
    }

    const updateResult = await client.splitProposal.updateMany({
      where: {
        id: proposalIdBigInt,
        version: expectedVersion,
      },
      data: SplitProposalMapper.toPrismaUpdateInput(input.proposal),
    });

    if (updateResult.count !== 1) {
      throw new ConcurrencyConflictError(
        `SplitProposal ${input.proposal.id} version conflict (expected version ${expectedVersion}).`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'SplitProposal',
        },
      );
    }

    const updatedRow = await client.splitProposal.findUnique({
      where: { id: proposalIdBigInt },
      include: {
        splitProposalItems: {
          orderBy: { id: 'asc' },
        },
      },
    });

    if (!updatedRow) {
      throw new ConcurrencyConflictError(
        `SplitProposal ${input.proposal.id} was not found after update.`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'SplitProposal',
        },
      );
    }

    return SplitProposalMapper.toDomain(updatedRow);
  }

  async expireProposedByRequestId(
    input: {
      readonly requestId: Id;
      readonly reason: SplitProposalExpireReason;
      readonly now: Date;
      readonly expiredAt?: Date;
    },
    tx: TransactionContext,
  ): Promise<SplitProposal | null> {
    const lockedProposal = await this.lockProposedByRequestId(
      input.requestId,
      tx,
    );
    if (!lockedProposal) {
      return null;
    }

    const expired = lockedProposal.expire(
      input.reason,
      input.now,
      input.expiredAt,
    );
    return this.updateStatus(
      {
        proposal: expired,
        expectedVersion: lockedProposal.version,
      },
      tx,
    );
  }

  async findProposedRequestIdsByWorkshopId(
    workshopId: Id,
    tx: TransactionContext,
  ): Promise<readonly Id[]> {
    const client = this.txRunner.getClient(tx);
    const wsBigInt = idToBigInt(
      workshopId,
      'split_proposal_item.workshop_id',
    );

    const rows = await client.splitProposal.findMany({
      where: {
        status: 'proposed',
        splitProposalItems: {
          some: {
            workshop_id: wsBigInt,
          },
        },
      },
      select: {
        request_id: true,
      },
      orderBy: {
        request_id: 'asc',
      },
    });

    const ids = rows.map((row) =>
      bigintToId(row.request_id, 'split_proposal.request_id'),
    );
    return EntityId.sortAscending(Array.from(new Set(ids)));
  }

  async findById(
    proposalId: Id,
    tx: TransactionContext,
  ): Promise<SplitProposal | null> {
    const client = this.txRunner.getClient(tx);
    const row = await client.splitProposal.findUnique({
      where: { id: idToBigInt(proposalId, 'split_proposal.id') },
      include: {
        splitProposalItems: {
          orderBy: { id: 'asc' },
        },
      },
    });
    return row ? SplitProposalMapper.toDomain(row) : null;
  }

  async findProposedByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<SplitProposal | null> {
    const client = this.txRunner.getClient(tx);
    const row = await client.splitProposal.findFirst({
      where: {
        request_id: idToBigInt(requestId, 'split_proposal.request_id'),
        status: 'proposed',
      },
      include: {
        splitProposalItems: {
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { id: 'desc' },
    });
    return row ? SplitProposalMapper.toDomain(row) : null;
  }

  async listByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly SplitProposal[]> {
    const client = this.txRunner.getClient(tx);
    const rows = await client.splitProposal.findMany({
      where: {
        request_id: idToBigInt(requestId, 'split_proposal.request_id'),
      },
      include: {
        splitProposalItems: {
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => SplitProposalMapper.toDomain(row));
  }

  async lockById(
    proposalId: Id,
    tx: TransactionContext,
  ): Promise<SplitProposal | null> {
    const client = this.txRunner.getClient(tx);
    const idBigInt = idToBigInt(proposalId, 'split_proposal.id');

    const lockedRows = await client.$queryRaw<Array<{ id: bigint }>>(
      Prisma.sql`SELECT "id" FROM "SplitProposal" WHERE "id" = ${idBigInt} FOR UPDATE`,
    );

    if (lockedRows.length === 0) {
      return null;
    }

    const row = await client.splitProposal.findUnique({
      where: { id: idBigInt },
      include: {
        splitProposalItems: {
          orderBy: { id: 'asc' },
        },
      },
    });
    return row ? SplitProposalMapper.toDomain(row) : null;
  }

  async lockProposedByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<SplitProposal | null> {
    const client = this.txRunner.getClient(tx);
    const reqBigInt = idToBigInt(requestId, 'split_proposal.request_id');

    const lockedRows = await client.$queryRaw<Array<{ id: bigint }>>(
      Prisma.sql`SELECT "id" FROM "SplitProposal" WHERE "request_id" = ${reqBigInt} AND "status" = 'proposed' ORDER BY "id" ASC FOR UPDATE`,
    );

    if (lockedRows.length === 0) {
      return null;
    }

    const row = await client.splitProposal.findUnique({
      where: { id: lockedRows[0].id },
      include: {
        splitProposalItems: {
          orderBy: { id: 'asc' },
        },
      },
    });
    return row ? SplitProposalMapper.toDomain(row) : null;
  }

  async lockByIds(
    proposalIds: readonly Id[],
    tx: TransactionContext,
  ): Promise<readonly SplitProposal[]> {
    const client = this.txRunner.getClient(tx);
    const uniqueSortedIds = EntityId.sortAscending(
      Array.from(new Set(proposalIds)),
    );

    if (uniqueSortedIds.length === 0) {
      return [];
    }

    const idBigInts = uniqueSortedIds.map((id) =>
      idToBigInt(id, 'split_proposal.id'),
    );

    const lockedRows = await client.$queryRaw<Array<{ id: bigint }>>(
      Prisma.sql`SELECT "id" FROM "SplitProposal" WHERE "id" IN (${Prisma.join(idBigInts)}) ORDER BY "id" ASC FOR UPDATE`,
    );

    if (lockedRows.length === 0) {
      return [];
    }

    const rows = await client.splitProposal.findMany({
      where: { id: { in: lockedRows.map((r) => r.id) } },
      include: {
        splitProposalItems: {
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
    });

    return rows.map((row) => SplitProposalMapper.toDomain(row));
  }
}
