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
  RequestRecipient,
  SplitProposal,
  SplitProposalExpireReason,
  SplitProposalItem,
  StatusLogRecord,
} from '../../../domain';
import type {
  AllocationEventDto,
  ContactEventDto,
  CreateIdempotencyRecordInput,
  IdempotencyScopeKey,
  PersistedAllocationLogRecord,
  PersistedContactEditRecord,
  PersistedIdempotencyRecord,
  PersistedRecipientResponseRecord,
  PersistedStatusLogRecord,
  RecipientEventDto,
  RequestEventDto,
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
export const SPLIT_PROPOSAL_REPOSITORY = Symbol('SPLIT_PROPOSAL_REPOSITORY');
export const SPLIT_PROPOSAL_ITEM_REPOSITORY = Symbol(
  'SPLIT_PROPOSAL_ITEM_REPOSITORY',
);
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
  lockById(requestId: Id, tx: TransactionContext): Promise<QuoteRequest | null>;
  lockByIds(
    requestIds: readonly Id[],
    tx: TransactionContext,
  ): Promise<readonly QuoteRequest[]>;
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

export interface ISplitProposalRepository {
  createProposal(
    input: {
      readonly proposal: SplitProposal;
      readonly replacedProposal?: SplitProposal | null;
    },
    tx: TransactionContext,
  ): Promise<SplitProposal>;
  updateStatus(
    input: {
      readonly proposal: SplitProposal;
      readonly expectedVersion?: number;
    },
    tx: TransactionContext,
  ): Promise<SplitProposal>;
  expireProposedByRequestId(
    input: {
      readonly requestId: Id;
      readonly reason: SplitProposalExpireReason;
      readonly now: Date;
      readonly expiredAt?: Date;
    },
    tx: TransactionContext,
  ): Promise<SplitProposal | null>;
  findProposedRequestIdsByWorkshopId(
    workshopId: Id,
    tx: TransactionContext,
  ): Promise<readonly Id[]>;
  findById(
    proposalId: Id,
    tx: TransactionContext,
  ): Promise<SplitProposal | null>;
  findProposedByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<SplitProposal | null>;
  listByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly SplitProposal[]>;
  lockById(
    proposalId: Id,
    tx: TransactionContext,
  ): Promise<SplitProposal | null>;
  lockProposedByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<SplitProposal | null>;
  lockByIds(
    proposalIds: readonly Id[],
    tx: TransactionContext,
  ): Promise<readonly SplitProposal[]>;
}

export interface ISplitProposalItemRepository {
  createMany(
    items: readonly SplitProposalItem[],
    tx: TransactionContext,
  ): Promise<readonly SplitProposalItem[]>;
  listByProposalId(
    proposalId: Id,
    tx: TransactionContext,
  ): Promise<readonly SplitProposalItem[]>;
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
