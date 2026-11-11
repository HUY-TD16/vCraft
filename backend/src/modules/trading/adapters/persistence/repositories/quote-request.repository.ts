import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../../../generated/prisma/client';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type { IQuoteRequestRepository } from '../../../application/ports/repositories/trading-repositories.port';
import {
  ConcurrencyConflictError,
   type ContactEditRecord,
  EntityId,
  InvalidStateTransitionError,
  type QuoteRequest,
  type StatusLogRecord,
  TRADING_INVARIANTS,
  TradingPermissionDeniedError,
} from '../../../domain';
import { ContactEditHistoryMapper } from '../mappers/contact-edit-history.mapper';
import { QuoteRequestMapper } from '../mappers/quote-request.mapper';
import { idToBigInt } from '../mappers/shared-persistence.mapper';
import { StatusLogMapper } from '../mappers/status-log.mapper';

@Injectable()
export class PrismaQuoteRequestRepository implements IQuoteRequestRepository {
  constructor(
    @Inject(PrismaTransactionRunner)
    private readonly txRunner: PrismaTransactionRunner,
  ) {}

  async createDraft(
    input: {
      readonly request: QuoteRequest;
      readonly statusLog: StatusLogRecord;
      readonly useEntityId?: boolean;
    },
    tx: TransactionContext,
  ): Promise<QuoteRequest> {
    const client = this.txRunner.getClient(tx);

    const createdRow = await client.quoteRequest.create({
      data: QuoteRequestMapper.toPrismaCreateInput(
        input.request,
        input.useEntityId ?? false,
      ),
    });

    await client.statusLog.create({
      data: StatusLogMapper.toPrismaCreateInput({
        ...input.statusLog,
        request_id: createdRow.id.toString(),
      }),
    });

    return QuoteRequestMapper.toDomain(createdRow);
  }

  async update(
    input: {
      readonly request: QuoteRequest;
      readonly expectedVersion?: number;
      readonly statusLogs?: readonly StatusLogRecord[];
      readonly contactEditHistory?: ContactEditRecord;
    },
    tx: TransactionContext,
  ): Promise<QuoteRequest> {
    const client = this.txRunner.getClient(tx);
    const requestIdBigInt = idToBigInt(input.request.id, 'quote_request.id');
    const expectedVersion =
      input.expectedVersion ?? input.request.version - 1;

    if (expectedVersion < 1) {
      throw new ConcurrencyConflictError(
        `Invalid expectedVersion (${expectedVersion}) when updating QuoteRequest ${input.request.id}.`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'QuoteRequest',
        },
      );
    }

    const updateResult = await client.quoteRequest.updateMany({
      where: {
        id: requestIdBigInt,
        version: expectedVersion,
      },
      data: QuoteRequestMapper.toPrismaUpdateInput(input.request),
    });

    if (updateResult.count !== 1) {
      throw new ConcurrencyConflictError(
        `QuoteRequest ${input.request.id} version conflict (expected version ${expectedVersion}).`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'QuoteRequest',
        },
      );
    }

    if (input.contactEditHistory) {
      await client.contactEditHistory.create({
        data: ContactEditHistoryMapper.toPrismaCreateInput(
          input.contactEditHistory,
        ),
      });
    }

    if (input.statusLogs && input.statusLogs.length > 0) {
      for (const log of input.statusLogs) {
        await client.statusLog.create({
          data: StatusLogMapper.toPrismaCreateInput(log),
        });
      }
    }

    const updatedRow = await client.quoteRequest.findUnique({
      where: { id: requestIdBigInt },
    });

    if (!updatedRow) {
      throw new ConcurrencyConflictError(
        `QuoteRequest ${input.request.id} was not found after update.`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'QuoteRequest',
        },
      );
    }

    return QuoteRequestMapper.toDomain(updatedRow);
  }

  async deleteDraft(
    input: {
      readonly requestId: Id;
      readonly buyerId: Id;
      readonly expectedVersion: number;
    },
    tx: TransactionContext,
  ): Promise<void> {
    const client = this.txRunner.getClient(tx);
    const requestIdBigInt = idToBigInt(input.requestId, 'quote_request.id');
    const buyerIdBigInt = idToBigInt(input.buyerId, 'quote_request.buyer_id');

    if (typeof client.$queryRaw === 'function') {
      await client.$queryRaw<Array<{ id: bigint }>>(
        Prisma.sql`SELECT "id" FROM "QuoteRequest" WHERE "id" = ${requestIdBigInt} FOR UPDATE`,
      );
    }

    const existing = await client.quoteRequest.findUnique({
      where: { id: requestIdBigInt },
    });

    if (!existing) {
      throw new ConcurrencyConflictError(
        `Draft QuoteRequest ${input.requestId} no longer exists.`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'QuoteRequest',
        },
      );
    }

    if (existing.buyer_id !== buyerIdBigInt) {
      throw new TradingPermissionDeniedError(
        'Actor is not the Buyer owner of this QuoteRequest.',
        { entity: 'QuoteRequest' },
      );
    }

    if (existing.status !== 'draft_request') {
      throw new InvalidStateTransitionError(
        `Only QuoteRequests in "draft_request" status can be deleted (current: "${existing.status}").`,
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }

    if (existing.version !== input.expectedVersion) {
      throw new ConcurrencyConflictError(
        `QuoteRequest ${input.requestId} version mismatch (expected ${input.expectedVersion}, actual ${existing.version}).`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'QuoteRequest',
        },
      );
    }

    // Per data-design.md §4.3: clean up draft creation StatusLog rows within the valid draft deletion flow
    // before deleting the draft QuoteRequest (StatusLog -> QuoteRequest FK is RESTRICT).
    if (client.statusLog && typeof client.statusLog.deleteMany === 'function') {
      await client.statusLog.deleteMany({
        where: { request_id: requestIdBigInt },
      });
    }

    const deleteResult = await client.quoteRequest.deleteMany({
      where: {
        id: requestIdBigInt,
        buyer_id: buyerIdBigInt,
        status: 'draft_request',
        version: input.expectedVersion,
      },
    });

    if (deleteResult.count !== 1) {
      throw new ConcurrencyConflictError(
        `QuoteRequest ${input.requestId} could not be deleted due to concurrent modification.`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'QuoteRequest',
        },
      );
    }
  }

  async findById(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<QuoteRequest | null> {
    const client = this.txRunner.getClient(tx);
    const row = await client.quoteRequest.findUnique({
      where: { id: idToBigInt(requestId, 'quote_request.id') },
    });
    return row ? QuoteRequestMapper.toDomain(row) : null;
  }

  async lockById(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<QuoteRequest | null> {
    const client = this.txRunner.getClient(tx);
    const idBigInt = idToBigInt(requestId, 'quote_request.id');

    const lockedRows = await client.$queryRaw<Array<{ id: bigint }>>(
      Prisma.sql`SELECT "id" FROM "QuoteRequest" WHERE "id" = ${idBigInt} FOR UPDATE`,
    );

    if (lockedRows.length === 0) {
      return null;
    }

    const row = await client.quoteRequest.findUnique({
      where: { id: idBigInt },
    });
    return row ? QuoteRequestMapper.toDomain(row) : null;
  }

  async lockByIds(
    requestIds: readonly Id[],
    tx: TransactionContext,
  ): Promise<readonly QuoteRequest[]> {
    const client = this.txRunner.getClient(tx);
    const uniqueSortedIds = EntityId.sortAscending(
      Array.from(new Set(requestIds)),
    );

    if (uniqueSortedIds.length === 0) {
      return [];
    }

    const idBigInts = uniqueSortedIds.map((id) =>
      idToBigInt(id, 'quote_request.id'),
    );

    const lockedRows = await client.$queryRaw<Array<{ id: bigint }>>(
      Prisma.sql`SELECT "id" FROM "QuoteRequest" WHERE "id" IN (${Prisma.join(idBigInts)}) ORDER BY "id" ASC FOR UPDATE`,
    );

    if (lockedRows.length === 0) {
      return [];
    }

    const rows = await client.quoteRequest.findMany({
      where: { id: { in: lockedRows.map((r) => r.id) } },
      orderBy: { id: 'asc' },
    });

    return rows.map((row) => QuoteRequestMapper.toDomain(row));
  }
}
