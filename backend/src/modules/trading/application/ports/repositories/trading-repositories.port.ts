import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import type {
  Allocation,
  AllocationBatchLink,
  AllocationLogRecord,
  ContactEditRecord,
  Quote,
  QuoteRequest,
  QuoteSnapshotData,
  RecipientResponseRecord,
  RecipientResponseStatus,
  RequestRecipient,
  RequestStatus,
  StatusLogRecord,
} from '../../../domain';
import type {
  ActorDto,
  AllocationEventDto,
  BuyerRequestSummaryDto,
  CategoryRefDto,
  ContactEventDto,
  CreateIdempotencyRecordInput,
  IdempotencyScopeKey,
  InvitedRequestDto,
  PersistedAllocationLogRecord,
  PersistedContactEditRecord,
  PersistedIdempotencyRecord,
  PersistedRecipientResponseRecord,
  PersistedStatusLogRecord,
  RecipientEventDto,
  RequestEventDto,
  WorkshopRefDto,
} from '../../dtos/trading-persistence.dtos';

export const QUOTE_REQUEST_REPOSITORY = Symbol('QUOTE_REQUEST_REPOSITORY');
export const CONTACT_EDIT_HISTORY_REPOSITORY = Symbol(
  'CONTACT_EDIT_HISTORY_REPOSITORY',
);
export const REQUEST_RECIPIENT_REPOSITORY = Symbol(
  'REQUEST_RECIPIENT_REPOSITORY',
);
export const RECIPIENT_RESPONSE_HISTORY_REPOSITORY = Symbol(
  'RECIPIENT_RESPONSE_HISTORY_REPOSITORY',
);
export const QUOTE_REPOSITORY = Symbol('QUOTE_REPOSITORY');
export const ALLOCATION_REPOSITORY = Symbol('ALLOCATION_REPOSITORY');
export const ALLOCATION_BATCH_REPOSITORY = Symbol('ALLOCATION_BATCH_REPOSITORY');
export const ALLOCATION_LOG_REPOSITORY = Symbol('ALLOCATION_LOG_REPOSITORY');
export const STATUS_LOG_REPOSITORY = Symbol('STATUS_LOG_REPOSITORY');
export const IDEMPOTENCY_RECORD_REPOSITORY = Symbol(
  'IDEMPOTENCY_RECORD_REPOSITORY',
);

export interface IQuoteRequestRepository {
  createDraft(
    input: {
      readonly request: QuoteRequest;
      readonly statusLog: StatusLogRecord;
      readonly useEntityId?: boolean;
    },
    tx: TransactionContext,
  ): Promise<QuoteRequest>;
  update(
    input: {
      readonly request: QuoteRequest;
      readonly expectedVersion?: number;
      readonly statusLogs?: readonly StatusLogRecord[];
      readonly contactEditHistory?: ContactEditRecord;
    },
    tx: TransactionContext,
  ): Promise<QuoteRequest>;
  deleteDraft(
    input: {
      readonly requestId: Id;
      readonly buyerId: Id;
      readonly expectedVersion: number;
    },
    tx: TransactionContext,
  ): Promise<void>;
  findById(requestId: Id, tx: TransactionContext): Promise<QuoteRequest | null>;
  findDetailById(
    requestId: Id,
    tx?: TransactionContext,
  ): Promise<QuoteRequestDetailRecord | null>;
  lockById(requestId: Id, tx: TransactionContext): Promise<QuoteRequest | null>;
  lockByIds(
    requestIds: readonly Id[],
    tx: TransactionContext,
  ): Promise<readonly QuoteRequest[]>;
  findBuyerQuoteRequests(
    input: FindBuyerQuoteRequestsInput,
    tx: TransactionContext,
  ): Promise<FindBuyerQuoteRequestsResult>;
  findArtisanQuoteRequests(
    input: FindArtisanQuoteRequestsInput,
    tx: TransactionContext,
  ): Promise<FindArtisanQuoteRequestsResult>;
  findAdminQuoteRequests(
    input: FindAdminQuoteRequestsInput,
    tx: TransactionContext,
  ): Promise<FindAdminQuoteRequestsResult>;
}

export interface RequestRecipientDetailItem {
  readonly entity: RequestRecipient;
  readonly workshop: WorkshopRefDto & { readonly status?: string };
  readonly quote?: {
    readonly id: Id;
    readonly status: string;
    readonly bid_accept_deadline: Date;
  } | null;
}

export interface QuoteDetailItem {
  readonly entity: Quote;
  readonly workshop: WorkshopRefDto & { readonly status: string };
}

export interface AllocationDetailItem {
  readonly entity: Allocation;
}

export interface StatusLogDetailItem {
  readonly entity: PersistedStatusLogRecord;
  readonly performedBy: ActorDto | null;
}

export interface QuoteRequestDetailRecord {
  readonly entity: QuoteRequest;
  readonly category: CategoryRefDto | null;
  readonly recipients: readonly RequestRecipientDetailItem[];
  readonly quotes: readonly QuoteDetailItem[];
  readonly allocations: readonly AllocationDetailItem[];
  readonly statusLogs: readonly StatusLogDetailItem[];
}

export interface FindAdminQuoteRequestsInput {
  readonly buyerId?: Id;
  readonly categoryId?: Id;
  readonly page: number;
  readonly limit: number;
  readonly status?: RequestStatus | string | readonly string[];
  readonly cancelled?: boolean;
  readonly sortBy?: string;
  readonly order?: 'asc' | 'desc';
  readonly search?: string;
  readonly now?: Date;
}

export interface FindAdminQuoteRequestsResult {
  readonly items: readonly BuyerRequestSummaryDto[];
  readonly total: number;
}

export interface FindBuyerQuoteRequestsInput {
  readonly buyerId: Id;
  readonly page: number;
  readonly limit: number;
  readonly status?: RequestStatus | string | readonly string[];
  readonly cancelled?: boolean;
  readonly sortBy?: string;
  readonly order?: 'asc' | 'desc';
  readonly search?: string;
  readonly now?: Date;
}

export interface FindBuyerQuoteRequestsResult {
  readonly items: readonly BuyerRequestSummaryDto[];
  readonly total: number;
}

export interface FindArtisanQuoteRequestsInput {
  readonly workshopId: Id;
  readonly page: number;
  readonly limit: number;
  readonly status?: RequestStatus | string | readonly string[];
  readonly responseStatus?: string;
  readonly sortBy?: string;
  readonly order?: 'asc' | 'desc';
  readonly search?: string;
  readonly now?: Date;
}

export interface FindArtisanQuoteRequestsResult {
  readonly items: readonly InvitedRequestDto[];
  readonly total: number;
}

export interface FindContactEventsInput {
  readonly requestId: Id;
  readonly page?: number;
  readonly limit?: number;
}

export interface FindContactEventsResult {
  readonly rows: readonly ContactEventDto[];
  readonly totalRecords: number;
}

export interface IContactEditHistoryRepository {
  create(
    record: ContactEditRecord & { readonly id?: Id },
    tx: TransactionContext,
  ): Promise<PersistedContactEditRecord>;
  listByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly PersistedContactEditRecord[]>;
  listEventsByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly ContactEventDto[]>;
  findEventsWithPagination(
    input: FindContactEventsInput,
    tx?: TransactionContext,
  ): Promise<FindContactEventsResult>;
}

export interface IRequestRecipientRepository {
  createMany(
    recipients: readonly (Omit<
      {
        readonly id?: Id;
        readonly request_id: Id;
        readonly workshop_id: Id;
        readonly sent_at: Date;
      },
      never
    >)[],
    tx: TransactionContext,
  ): Promise<readonly RequestRecipient[]>;
  update(
    input: {
      readonly recipient: RequestRecipient;
      readonly expectedVersion?: number;
      readonly history?: RecipientResponseRecord;
    },
    tx: TransactionContext,
  ): Promise<RequestRecipient>;
  findById(
    recipientId: Id,
    tx: TransactionContext,
  ): Promise<RequestRecipient | null>;
  findByRequestAndWorkshop(
    requestId: Id,
    workshopId: Id,
    tx: TransactionContext,
  ): Promise<RequestRecipient | null>;
  listByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly RequestRecipient[]>;
  lockById(
    recipientId: Id,
    tx: TransactionContext,
  ): Promise<RequestRecipient | null>;
  lockByRequestAndWorkshop(
    requestId: Id,
    workshopId: Id,
    tx: TransactionContext,
  ): Promise<RequestRecipient | null>;
  lockByIds(
    recipientIds: readonly Id[],
    tx: TransactionContext,
  ): Promise<readonly RequestRecipient[]>;
  findRecipientsWithDetails(
    input: {
      readonly requestId: string;
      readonly responseStatus?: RecipientResponseStatus;
      readonly page?: number;
      readonly limit?: number;
    },
    tx?: TransactionContext,
  ): Promise<{
    readonly rows: readonly RequestRecipientDetailItem[];
    readonly totalRecords: number;
  }>;
}

export interface IRecipientResponseHistoryRepository {
  create(
    record: RecipientResponseRecord & { readonly id?: Id },
    tx: TransactionContext,
  ): Promise<PersistedRecipientResponseRecord>;
  listByRecipientId(
    recipientId: Id,
    tx: TransactionContext,
  ): Promise<readonly PersistedRecipientResponseRecord[]>;
  listEventsByRecipientId(
    recipientId: Id,
    tx: TransactionContext,
  ): Promise<readonly RecipientEventDto[]>;
  findSnapshotByQuoteVersion(
    quoteId: Id,
    quoteVersion: number,
    tx: TransactionContext,
  ): Promise<QuoteSnapshotData | null>;
}

export interface IQuoteRepository {
  create(
    input: {
      readonly quote: Quote;
      readonly recipient?: RequestRecipient;
      readonly recipientHistory?: RecipientResponseRecord;
    },
    tx: TransactionContext,
  ): Promise<Quote>;
  update(
    input: {
      readonly quote: Quote;
      readonly expectedVersion?: number;
      readonly recipient?: RequestRecipient;
      readonly recipientHistory?: RecipientResponseRecord;
    },
    tx: TransactionContext,
  ): Promise<Quote>;
  findById(quoteId: Id, tx: TransactionContext): Promise<Quote | null>;
  findByRequestAndWorkshop(
    requestId: Id,
    workshopId: Id,
    tx: TransactionContext,
  ): Promise<Quote | null>;
  listByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly Quote[]>;
  lockById(quoteId: Id, tx: TransactionContext): Promise<Quote | null>;
  lockByRequestAndWorkshop(
    requestId: Id,
    workshopId: Id,
    tx: TransactionContext,
  ): Promise<Quote | null>;
  lockByIds(
    quoteIds: readonly Id[],
    tx: TransactionContext,
  ): Promise<readonly Quote[]>;
}

export interface IAllocationRepository {
  create(
    input: {
      readonly allocation: Allocation;
      readonly log?: AllocationLogRecord;
    },
    tx: TransactionContext,
  ): Promise<Allocation>;
  createMany(
    entries: readonly {
      readonly allocation: Allocation;
      readonly log: AllocationLogRecord;
    }[],
    tx: TransactionContext,
  ): Promise<readonly Allocation[]>;
  update(
    input: {
      readonly allocation: Allocation;
      readonly expectedVersion?: number;
      readonly logs?: readonly AllocationLogRecord[];
      readonly syncBatchLinks?: boolean;
    },
    tx: TransactionContext,
  ): Promise<Allocation>;
  findById(allocationId: Id, tx: TransactionContext): Promise<Allocation | null>;
  findByRequestAndWorkshop(
    requestId: Id,
    workshopId: Id,
    tx: TransactionContext,
  ): Promise<Allocation | null>;
  listByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly Allocation[]>;
  listByWorkshopId(
    workshopId: Id,
    tx: TransactionContext,
  ): Promise<readonly Allocation[]>;
  lockById(allocationId: Id, tx: TransactionContext): Promise<Allocation | null>;
  lockByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly Allocation[]>;
  lockByIds(
    allocationIds: readonly Id[],
    tx: TransactionContext,
  ): Promise<readonly Allocation[]>;
}

export interface IAllocationBatchRepository {
  replaceForAllocation(
    input: {
      readonly allocationId: Id;
      readonly workshopId: Id;
      readonly links: readonly AllocationBatchLink[];
    },
    tx: TransactionContext,
  ): Promise<readonly AllocationBatchLink[]>;
  listByAllocationId(
    allocationId: Id,
    tx: TransactionContext,
  ): Promise<readonly AllocationBatchLink[]>;
}

export interface IAllocationLogRepository {
  create(
    record: AllocationLogRecord & { readonly id?: Id },
    tx: TransactionContext,
  ): Promise<PersistedAllocationLogRecord>;
  createMany(
    records: readonly (AllocationLogRecord & { readonly id?: Id })[],
    tx: TransactionContext,
  ): Promise<readonly PersistedAllocationLogRecord[]>;
  listByAllocationId(
    allocationId: Id,
    tx: TransactionContext,
  ): Promise<readonly PersistedAllocationLogRecord[]>;
  listEventsByAllocationId(
    allocationId: Id,
    tx: TransactionContext,
  ): Promise<readonly AllocationEventDto[]>;
}

export interface IStatusLogRepository {
  create(
    record: StatusLogRecord & { readonly id?: Id },
    tx: TransactionContext,
  ): Promise<PersistedStatusLogRecord>;
  createMany(
    records: readonly (StatusLogRecord & { readonly id?: Id })[],
    tx: TransactionContext,
  ): Promise<readonly PersistedStatusLogRecord[]>;
  listByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly PersistedStatusLogRecord[]>;
  listEventsByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly RequestEventDto[]>;
}

export interface IIdempotencyRecordRepository {
  findByScope<TSnapshot = unknown>(
    scope: IdempotencyScopeKey,
    tx: TransactionContext,
    snapshotParser?: (raw: unknown) => TSnapshot,
  ): Promise<PersistedIdempotencyRecord<TSnapshot> | null>;
  findAndVerifyReplay<TSnapshot = unknown>(
    input: IdempotencyScopeKey & {
      readonly request_fingerprint: string;
    },
    tx: TransactionContext,
    snapshotParser?: (raw: unknown) => TSnapshot,
  ): Promise<PersistedIdempotencyRecord<TSnapshot> | null>;
  save<TSnapshot = unknown>(
    input: CreateIdempotencyRecordInput<TSnapshot>,
    tx: TransactionContext,
    snapshotParser?: (raw: unknown) => TSnapshot,
  ): Promise<PersistedIdempotencyRecord<TSnapshot>>;
  deleteExpiredBefore(
    cutoff: Date,
    tx: TransactionContext,
  ): Promise<number>;
}
