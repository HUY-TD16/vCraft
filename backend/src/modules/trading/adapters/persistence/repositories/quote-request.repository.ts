import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../../../generated/prisma/client';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type {
  FindAdminQuoteRequestsInput,
  FindAdminQuoteRequestsResult,
  FindArtisanQuoteRequestsInput,
  FindArtisanQuoteRequestsResult,
  FindBuyerQuoteRequestsInput,
  FindBuyerQuoteRequestsResult,
  IQuoteRequestRepository,
  QuoteRequestDetailRecord,
} from '../../../application/ports/repositories/trading-repositories.port';
import {
  ConcurrencyConflictError,
  type ContactEditRecord,
  EntityId,
  InvalidStateTransitionError,
  type QuoteRequest,
  type RequestStatus,
  type StatusLogRecord,
  TRADING_INVARIANTS,
  TradingPermissionDeniedError,
} from '../../../domain';
import type { QuoteDto } from '../../../application/dtos/trading-persistence.dtos';
import { AllocationMapper } from '../mappers/allocation.mapper';
import { ContactEditHistoryMapper } from '../mappers/contact-edit-history.mapper';
import { QuoteMapper } from '../mappers/quote.mapper';
import { QuoteRequestMapper } from '../mappers/quote-request.mapper';
import { RequestRecipientMapper } from '../mappers/request-recipient.mapper';
import {
  bigintToId,
  idToBigInt,
  toCategoryRefDto,
  toNullableActorDto,
  toWorkshopRefDto,
} from '../mappers/shared-persistence.mapper';
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

  async findDetailById(
    requestId: Id,
    tx?: TransactionContext,
  ): Promise<QuoteRequestDetailRecord | null> {
    if (tx) {
      const client = this.txRunner.getClient(tx);
      return this.executeFindDetailById(client, requestId);
    }
    return this.txRunner.run(async (innerTx) => {
      const client = this.txRunner.getClient(innerTx);
      return this.executeFindDetailById(client, requestId);
    });
  }

  private async executeFindDetailById(
    client: Prisma.TransactionClient,
    requestId: Id,
  ): Promise<QuoteRequestDetailRecord | null> {
    const idBigInt = idToBigInt(requestId, 'quote_request.id');
    const row = await client.quoteRequest.findUnique({
      where: { id: idBigInt },
      include: {
        category: true,
        requestRecipients: {
          include: { workshop: true },
        },
        quotes: {
          include: { workshop: true },
        },
        allocations: true,
        statusLogs: {
          include: { performedBy: true },
          orderBy: { created_at: 'desc' },
        },
      },
    });

    if (!row) {
      return null;
    }

    const entity = QuoteRequestMapper.toDomain(row);
    const category = toCategoryRefDto(row.category);

    const recipients = row.requestRecipients.map((r) => ({
      entity: RequestRecipientMapper.toDomain(r),
      workshop: toWorkshopRefDto(r.workshop),
    }));

    const quotes = row.quotes.map((q) => ({
      entity: QuoteMapper.toDomain(q),
      workshop: {
        ...toWorkshopRefDto(q.workshop),
        status: q.workshop.status,
      },
    }));

    const allocations = row.allocations.map((a) => ({
      entity: AllocationMapper.toDomain(a),
    }));

    const statusLogs = row.statusLogs.map((log) => ({
      entity: StatusLogMapper.toDomain(log),
      performedBy: toNullableActorDto(log.performedBy),
    }));

    return {
      entity,
      category,
      recipients,
      quotes,
      allocations,
      statusLogs,
    };
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

  private buildStatusConditions(
    status?: string | readonly string[],
    cancelled?: boolean,
  ): Prisma.QuoteRequestWhereInput {
    const hasExplicitCancelled = typeof cancelled === 'boolean';
    const explicitCancelledAt = hasExplicitCancelled
      ? cancelled
        ? { not: null }
        : null
      : undefined;

    const cancelledClause =
      explicitCancelledAt !== undefined ? explicitCancelledAt : null;

    if (status === 'cancelled') {
      return { cancelled_at: { not: null } };
    }
    if (Array.isArray(status)) {
      return {
        status: { in: [...status] as RequestStatus[] },
        cancelled_at: cancelledClause,
      };
    }
    if (status === 'draft' || status === 'draft_request') {
      return { status: 'draft_request', cancelled_at: cancelledClause };
    }
    if (status === 'bidding') {
      return {
        status: { in: ['sent_to_artisans', 'artisans_bidding'] },
        cancelled_at: cancelledClause,
      };
    }
    if (status === 'sent_to_artisans') {
      return { status: 'sent_to_artisans', cancelled_at: cancelledClause };
    }
    if (status === 'artisans_bidding') {
      return { status: 'artisans_bidding', cancelled_at: cancelledClause };
    }
    if (status === 'accepted' || status === 'buyer_accepted') {
      return { status: 'buyer_accepted', cancelled_at: cancelledClause };
    }
    if (status === 'in_production') {
      return { status: 'in_production', cancelled_at: cancelledClause };
    }
    if (status === 'delivered') {
      return { status: 'delivered', cancelled_at: cancelledClause };
    }
    if (hasExplicitCancelled) {
      return { cancelled_at: explicitCancelledAt };
    }
    return {};
  }

  private buildSearchConditions(search?: string): Prisma.QuoteRequestWhereInput {
    const trimmedSearch = search?.trim();
    if (!trimmedSearch || trimmedSearch.length === 0) {
      return {};
    }

    const searchOr: Prisma.QuoteRequestWhereInput[] = [
      { spec: { contains: trimmedSearch, mode: 'insensitive' } },
      {
        category: {
          is: {
            name: { contains: trimmedSearch, mode: 'insensitive' },
          },
        },
      },
    ];

    if (/^[1-9][0-9]*$/.test(trimmedSearch)) {
      const parsedId = BigInt(trimmedSearch);
      if (parsedId <= 9223372036854775807n) {
        searchOr.push({ id: parsedId });
      }
    }

    return { OR: searchOr };
  }

  private buildDeterministicOrderBy(
    sortBy: string | undefined,
    order: 'asc' | 'desc' | undefined,
    allowedSortFields: readonly string[],
  ): Prisma.QuoteRequestOrderByWithRelationInput[] {
    const sortField =
      sortBy !== undefined && allowedSortFields.includes(sortBy)
        ? sortBy
        : 'created_at';
    const sortOrder: Prisma.SortOrder = order === 'asc' ? 'asc' : 'desc';

    return sortField === 'id'
      ? [{ id: sortOrder }]
      : [{ [sortField]: sortOrder }, { id: 'desc' }];
  }

  async findBuyerQuoteRequests(
    input: FindBuyerQuoteRequestsInput,
    tx: TransactionContext,
  ): Promise<FindBuyerQuoteRequestsResult> {
    const client = this.txRunner.getClient(tx);
    const buyerIdBigInt = idToBigInt(input.buyerId, 'quote_request.buyer_id');
    const now = input.now ?? new Date();

    const statusConditions = this.buildStatusConditions(
      input.status,
      input.cancelled,
    );
    const searchConditions = this.buildSearchConditions(input.search);

    const whereAnd: Prisma.QuoteRequestWhereInput[] = [
      { buyer_id: buyerIdBigInt },
    ];
    if (Object.keys(statusConditions).length > 0) {
      whereAnd.push(statusConditions);
    }
    if (Object.keys(searchConditions).length > 0) {
      whereAnd.push(searchConditions);
    }

    const where: Prisma.QuoteRequestWhereInput =
      whereAnd.length === 1 ? whereAnd[0] : { AND: whereAnd };

    const orderBy = this.buildDeterministicOrderBy(input.sortBy, input.order, [
      'created_at',
      'updated_at',
      'bidding_deadline',
      'delivery_deadline',
      'quantity',
      'id',
    ]);

    const page = Math.max(1, input.page);
    const limit = Math.max(1, input.limit);
    const skip = (page - 1) * limit;
    const take = limit;

    const [total, rows] = await Promise.all([
      client.quoteRequest.count({ where }),
      client.quoteRequest.findMany({
        where,
        orderBy,
        skip,
        take,
        include: {
          category: true,
          quotes: {
            include: {
              workshop: true,
            },
          },
        },
      }),
    ]);

    const items = rows.map((row) => {
      const entity = QuoteRequestMapper.toDomain(row);
      const categoryDto = toCategoryRefDto(row.category);

      return QuoteRequestMapper.toSummaryDto(entity, {
        category: categoryDto,
        now,
        quotes: row.quotes,
      });
    });

    return {
      items,
      total,
    };
  }

  async findAdminQuoteRequests(
    input: FindAdminQuoteRequestsInput,
    tx: TransactionContext,
  ): Promise<FindAdminQuoteRequestsResult> {
    const client = this.txRunner.getClient(tx);
    const now = input.now ?? new Date();

    const statusConditions = this.buildStatusConditions(
      input.status,
      input.cancelled,
    );
    const searchConditions = this.buildSearchConditions(input.search);

    const whereAnd: Prisma.QuoteRequestWhereInput[] = [];

    if (input.buyerId !== undefined) {
      const buyerIdBigInt = idToBigInt(input.buyerId, 'quote_request.buyer_id');
      whereAnd.push({ buyer_id: buyerIdBigInt });
    }

    if (input.categoryId !== undefined) {
      const categoryIdBigInt = idToBigInt(input.categoryId, 'quote_request.category_id');
      whereAnd.push({ category_id: categoryIdBigInt });
    }

    if (Object.keys(statusConditions).length > 0) {
      whereAnd.push(statusConditions);
    }
    if (Object.keys(searchConditions).length > 0) {
      whereAnd.push(searchConditions);
    }

    const where: Prisma.QuoteRequestWhereInput =
      whereAnd.length === 0
        ? {}
        : whereAnd.length === 1
          ? whereAnd[0]
          : { AND: whereAnd };

    const orderBy = this.buildDeterministicOrderBy(input.sortBy, input.order, [
      'created_at',
      'updated_at',
      'bidding_deadline',
      'delivery_deadline',
      'quantity',
      'id',
    ]);

    const page = Math.max(1, input.page);
    const limit = Math.max(1, input.limit);
    const skip = (page - 1) * limit;
    const take = limit;

    const [total, rows] = await Promise.all([
      client.quoteRequest.count({ where }),
      client.quoteRequest.findMany({
        where,
        orderBy,
        skip,
        take,
        include: {
          category: true,
          quotes: {
            include: {
              workshop: true,
            },
          },
        },
      }),
    ]);

    const items = rows.map((row) => {
      const entity = QuoteRequestMapper.toDomain(row);
      const categoryDto = toCategoryRefDto(row.category);

      return QuoteRequestMapper.toSummaryDto(entity, {
        category: categoryDto,
        now,
        quotes: row.quotes,
      });
    });

    return {
      items,
      total,
    };
  }

  async findArtisanQuoteRequests(
    input: FindArtisanQuoteRequestsInput,
    tx: TransactionContext,
  ): Promise<FindArtisanQuoteRequestsResult> {
    const client = this.txRunner.getClient(tx);
    const workshopIdBigInt = idToBigInt(
      input.workshopId,
      'request_recipient.workshop_id',
    );
    const now = input.now ?? new Date();

    const statusConditions = this.buildStatusConditions(input.status);
    const searchConditions = this.buildSearchConditions(input.search);

    const recipientWhere: Prisma.RequestRecipientWhereInput = {
      workshop_id: workshopIdBigInt,
      ...(input.responseStatus ? { response_status: input.responseStatus } : {}),
    };

    const whereAnd: Prisma.QuoteRequestWhereInput[] = [
      { requestRecipients: { some: recipientWhere } },
    ];
    if (Object.keys(statusConditions).length > 0) {
      whereAnd.push(statusConditions);
    }
    if (Object.keys(searchConditions).length > 0) {
      whereAnd.push(searchConditions);
    }

    const where: Prisma.QuoteRequestWhereInput =
      whereAnd.length === 1 ? whereAnd[0] : { AND: whereAnd };

    const orderBy = this.buildDeterministicOrderBy(input.sortBy, input.order, [
      'created_at',
      'bidding_deadline',
      'delivery_deadline',
      'quantity',
      'id',
    ]);

    const page = Math.max(1, input.page);
    const limit = Math.max(1, input.limit);
    const skip = (page - 1) * limit;
    const take = limit;

    // 7. Parallel execution (Strict isolation: only load own recipient, quote, allocation)
    const [total, rows] = await Promise.all([
      client.quoteRequest.count({ where }),
      client.quoteRequest.findMany({
        where,
        orderBy,
        skip,
        take,
        include: {
          category: true,
          requestRecipients: {
            where: { workshop_id: workshopIdBigInt },
            include: { workshop: true },
          },
          quotes: {
            where: { workshop_id: workshopIdBigInt },
            include: { workshop: true },
          },
          allocations: {
            where: { workshop_id: workshopIdBigInt },
          },
        },
      }),
    ]);

    // 8. Map to InvitedRequestDto (BR-04 Data Masking enforced by mapper)
    const items = rows.map((row) => {
      const entity = QuoteRequestMapper.toDomain(row);
      const categoryDto = toCategoryRefDto(row.category);

      const recipientRow = row.requestRecipients[0];
      if (!recipientRow) {
        throw new Error(
          `Integrity invariant violated: missing RequestRecipient for workshop ${input.workshopId} on request ${entity.id}`,
        );
      }
      const recipientEntity = RequestRecipientMapper.toDomain(recipientRow);
      const recipientWorkshopRef = toWorkshopRefDto(recipientRow.workshop);
      const ownRecipientDto = RequestRecipientMapper.toDto(recipientEntity, {
        workshop: recipientWorkshopRef,
      });

      const quoteRow = row.quotes[0] ?? null;
      let ownQuoteDto: QuoteDto | null = null;
      if (quoteRow) {
        const quoteEntity = QuoteMapper.toDomain(quoteRow);
        const quoteWorkshopRef = toWorkshopRefDto(quoteRow.workshop);
        ownQuoteDto = QuoteMapper.toDto(quoteEntity, {
          workshop: quoteWorkshopRef,
          evaluationContext: {
            request: entity,
            workshopIsActive: quoteRow.workshop.status === 'active',
            now,
          },
        });
      }

      const allocationRow = row.allocations[0] ?? null;
      const ownAllocationId = allocationRow
        ? bigintToId(allocationRow.id, 'allocation.id')
        : null;

      return QuoteRequestMapper.toInvitedRequestDto(entity, {
        category: categoryDto,
        now,
        ownRecipient: ownRecipientDto,
        ownQuote: ownQuoteDto,
        ownAllocationId,
      });
    });

    return {
      items,
      total,
    };
  }
}
