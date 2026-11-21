import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '../../../../../generated/prisma/client';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { PAGINATION } from '../../../../../common/application/types/pagination';
import { PrismaService } from '../../../../../infrastructure/database/prisma/prisma.service';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type {
  FindQuotesWithDetailsInput,
  FindQuotesWithDetailsResult,
  IQuoteRepository,
  QuoteDetailItem,
} from '../../../application/ports/repositories/trading-repositories.port';
import {
  ConcurrencyConflictError,
  EntityId,
  type Quote,
  type RecipientResponseRecord,
  type RequestRecipient,
  TRADING_INVARIANTS,
} from '../../../domain';
import { QuoteMapper } from '../mappers/quote.mapper';
import { RecipientResponseHistoryMapper } from '../mappers/recipient-response-history.mapper';
import { RequestRecipientMapper } from '../mappers/request-recipient.mapper';
import {
  idToBigInt,
  toWorkshopRefDto,
} from '../mappers/shared-persistence.mapper';

@Injectable()
export class PrismaQuoteRepository implements IQuoteRepository {
  constructor(
    @Inject(PrismaTransactionRunner)
    private readonly txRunner: PrismaTransactionRunner,
    @Optional()
    @Inject(PrismaService)
    private readonly prisma?: PrismaService,
  ) {}

  async create(
    input: {
      readonly quote: Quote;
      readonly recipient?: RequestRecipient;
      readonly recipientHistory?: RecipientResponseRecord;
      readonly useEntityId?: boolean;
    },
    tx: TransactionContext,
  ): Promise<Quote> {
    const client = this.txRunner.getClient(tx);

    let createdRow;
    try {
      createdRow = await client.quote.create({
        data: QuoteMapper.toPrismaCreateInput(
          input.quote,
          input.useEntityId ?? false,
        ),
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConcurrencyConflictError(
          `A Quote already exists for request ${input.quote.request_id} and workshop ${input.quote.workshop_id}.`,
          {
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
            entity: 'Quote',
          },
        );
      }
      throw error;
    }

    if (input.recipient) {
      const expectedRecipientVersion = input.recipient.version - 1;
      const recipientUpdate = await client.requestRecipient.updateMany({
        where: {
          id: idToBigInt(input.recipient.id, 'request_recipient.id'),
          version: expectedRecipientVersion,
        },
        data: RequestRecipientMapper.toPrismaUpdateInput(input.recipient),
      });

      if (recipientUpdate.count !== 1) {
        throw new ConcurrencyConflictError(
          `RequestRecipient ${input.recipient.id} version conflict when submitting quote.`,
          {
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
            entity: 'RequestRecipient',
          },
        );
      }
    }

    if (input.recipientHistory) {
      await client.recipientResponseHistory.create({
        data: RecipientResponseHistoryMapper.toPrismaCreateInput(
          {
            ...input.recipientHistory,
            quote_id: createdRow.id.toString(),
          },
          Prisma.DbNull,
        ),
      });
    }

    return QuoteMapper.toDomain(createdRow);
  }

  async update(
    input: {
      readonly quote: Quote;
      readonly expectedVersion?: number;
      readonly recipient?: RequestRecipient;
      readonly recipientHistory?: RecipientResponseRecord;
    },
    tx: TransactionContext,
  ): Promise<Quote> {
    const client = this.txRunner.getClient(tx);
    const quoteIdBigInt = idToBigInt(input.quote.id, 'quote.id');
    const expectedVersion = input.expectedVersion ?? input.quote.version - 1;

    if (expectedVersion < 1) {
      throw new ConcurrencyConflictError(
        `Invalid expectedVersion (${expectedVersion}) when updating Quote ${input.quote.id}.`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'Quote',
        },
      );
    }

    const updateResult = await client.quote.updateMany({
      where: {
        id: quoteIdBigInt,
        version: expectedVersion,
      },
      data: QuoteMapper.toPrismaUpdateInput(input.quote),
    });

    if (updateResult.count !== 1) {
      throw new ConcurrencyConflictError(
        `Quote ${input.quote.id} version conflict (expected version ${expectedVersion}).`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'Quote',
        },
      );
    }

    if (input.recipient) {
      const expectedRecipientVersion = input.recipient.version - 1;
      const recipientUpdate = await client.requestRecipient.updateMany({
        where: {
          id: idToBigInt(input.recipient.id, 'request_recipient.id'),
          version: expectedRecipientVersion,
        },
        data: RequestRecipientMapper.toPrismaUpdateInput(input.recipient),
      });

      if (recipientUpdate.count !== 1) {
        throw new ConcurrencyConflictError(
          `RequestRecipient ${input.recipient.id} version conflict when updating quote.`,
          {
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
            entity: 'RequestRecipient',
          },
        );
      }
    }

    if (input.recipientHistory) {
      await client.recipientResponseHistory.create({
        data: RecipientResponseHistoryMapper.toPrismaCreateInput(
          input.recipientHistory,
          Prisma.DbNull,
        ),
      });
    }

    const updatedRow = await client.quote.findUnique({
      where: { id: quoteIdBigInt },
    });

    if (!updatedRow) {
      throw new ConcurrencyConflictError(
        `Quote ${input.quote.id} was not found after update.`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'Quote',
        },
      );
    }

    return QuoteMapper.toDomain(updatedRow);
  }

  async findById(quoteId: Id, tx: TransactionContext): Promise<Quote | null> {
    const client = this.txRunner.getClient(tx);
    const row = await client.quote.findUnique({
      where: { id: idToBigInt(quoteId, 'quote.id') },
    });
    return row ? QuoteMapper.toDomain(row) : null;
  }

  async findByRequestAndWorkshop(
    requestId: Id,
    workshopId: Id,
    tx: TransactionContext,
  ): Promise<Quote | null> {
    const client = this.txRunner.getClient(tx);
    const row = await client.quote.findUnique({
      where: {
        request_id_workshop_id: {
          request_id: idToBigInt(requestId, 'quote.request_id'),
          workshop_id: idToBigInt(workshopId, 'quote.workshop_id'),
        },
      },
    });
    return row ? QuoteMapper.toDomain(row) : null;
  }

  async listByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly Quote[]> {
    const client = this.txRunner.getClient(tx);
    const rows = await client.quote.findMany({
      where: { request_id: idToBigInt(requestId, 'quote.request_id') },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => QuoteMapper.toDomain(row));
  }

  async findQuotesWithDetails(
    input: FindQuotesWithDetailsInput,
    tx?: TransactionContext,
  ): Promise<FindQuotesWithDetailsResult> {
    if (tx) {
      const client = this.txRunner.getClient(tx);
      return this.executeFindQuotesWithDetails(client, input);
    }
    if (this.prisma) {
      return this.executeFindQuotesWithDetails(this.prisma, input);
    }
    return this.txRunner.run(async (innerTx) => {
      const client = this.txRunner.getClient(innerTx);
      return this.executeFindQuotesWithDetails(client, input);
    });
  }

  private async executeFindQuotesWithDetails(
    client: Prisma.TransactionClient | PrismaService,
    input: FindQuotesWithDetailsInput,
  ): Promise<FindQuotesWithDetailsResult> {
    const requestIdBigInt = idToBigInt(input.requestId, 'quote.request_id');
    const where: Prisma.QuoteWhereInput = {
      request_id: requestIdBigInt,
      ...(input.workshopId !== undefined
        ? { workshop_id: idToBigInt(input.workshopId, 'quote.workshop_id') }
        : {}),
    };

    const page =
      input.page !== undefined && input.page > 0
        ? input.page
        : PAGINATION.defaultPage;
    const limit =
      input.limit !== undefined && input.limit > 0
        ? Math.min(input.limit, PAGINATION.maxLimit)
        : PAGINATION.defaultLimit;
    const skip = (page - 1) * limit;

    const [totalRecords, rows] = await Promise.all([
      client.quote.count({ where }),
      client.quote.findMany({
        where,
        include: {
          workshop: {
            select: {
              id: true,
              name: true,
              status: true,
            },
          },
        },
        orderBy: { id: 'asc' },
        skip,
        take: limit,
      }),
    ]);

    const items: QuoteDetailItem[] = rows.map((row) => ({
      entity: QuoteMapper.toDomain(row),
      workshop: {
        ...toWorkshopRefDto(row.workshop),
        status: row.workshop.status,
      },
    }));

    return {
      rows: items,
      totalRecords,
    };
  }

  async lockById(quoteId: Id, tx: TransactionContext): Promise<Quote | null> {
    const client = this.txRunner.getClient(tx);
    const idBigInt = idToBigInt(quoteId, 'quote.id');

    const lockedRows = await client.$queryRaw<Array<{ id: bigint }>>(
      Prisma.sql`SELECT "id" FROM "Quote" WHERE "id" = ${idBigInt} FOR UPDATE`,
    );

    if (lockedRows.length === 0) {
      return null;
    }

    const row = await client.quote.findUnique({
      where: { id: idBigInt },
    });
    return row ? QuoteMapper.toDomain(row) : null;
  }

  async lockByRequestAndWorkshop(
    requestId: Id,
    workshopId: Id,
    tx: TransactionContext,
  ): Promise<Quote | null> {
    const client = this.txRunner.getClient(tx);
    const reqBigInt = idToBigInt(requestId, 'quote.request_id');
    const wsBigInt = idToBigInt(workshopId, 'quote.workshop_id');

    const lockedRows = await client.$queryRaw<Array<{ id: bigint }>>(
      Prisma.sql`SELECT "id" FROM "Quote" WHERE "request_id" = ${reqBigInt} AND "workshop_id" = ${wsBigInt} ORDER BY "id" ASC FOR UPDATE`,
    );

    if (lockedRows.length === 0) {
      return null;
    }

    const row = await client.quote.findUnique({
      where: { id: lockedRows[0].id },
    });
    return row ? QuoteMapper.toDomain(row) : null;
  }

  async lockByIds(
    quoteIds: readonly Id[],
    tx: TransactionContext,
  ): Promise<readonly Quote[]> {
    const client = this.txRunner.getClient(tx);
    const uniqueSortedIds = EntityId.sortAscending(
      Array.from(new Set(quoteIds)),
    );

    if (uniqueSortedIds.length === 0) {
      return [];
    }

    const idBigInts = uniqueSortedIds.map((id) => idToBigInt(id, 'quote.id'));

    const lockedRows = await client.$queryRaw<Array<{ id: bigint }>>(
      Prisma.sql`SELECT "id" FROM "Quote" WHERE "id" IN (${Prisma.join(idBigInts)}) ORDER BY "id" ASC FOR UPDATE`,
    );

    if (lockedRows.length === 0) {
      return [];
    }

    const rows = await client.quote.findMany({
      where: { id: { in: lockedRows.map((r) => r.id) } },
      orderBy: { id: 'asc' },
    });

    return rows.map((row) => QuoteMapper.toDomain(row));
  }
}
