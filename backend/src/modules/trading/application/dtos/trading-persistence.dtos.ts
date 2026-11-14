import type { Id, Instant } from '../../../../common/application/types/contract-types';
import type { OperationMetadata } from '../../../../common/application/types/operation-metadata';
import type {
  ActorDto,
  AllocationDto,
  AllocationStatus,
  RequestStatus,
} from '../../public/dtos/acceptance.dto';
import type {
  AllocationLogEventType,
  AllocationLogRecord,
  ContactEditRecord,
  CoordinationState,
  DeliveryMode,
  IneligibleQuoteReason,
  QuoteSnapshotData,
  QuoteStatus,
  RecipientEventType,
  RecipientResponseRecord,
  RecipientResponseStatus,
  RequestUnit,
  StatusLogEventType,
  StatusLogRecord,
  TraceabilityWarning,
} from '../../domain';

export type {
  ActorDto,
  AllocationDto,
  AllocationStatus,
  RequestStatus,
};

export interface CategoryRefDto {
  readonly id: Id;
  readonly name: string;
}

export interface WorkshopRefDto {
  readonly id: Id;
  readonly name: string;
}

export interface DeliveryConfirmationDto {
  readonly performed_by: ActorDto;
  readonly performed_at: Instant;
  readonly is_admin_action: boolean;
  readonly reason: string | null;
  readonly evidence: string | null;
}

/**
 * Base DTO shared by QuoteRequest views (`docsAI/04-architecture/api-dtos.md` §2.2).
 */
export interface RequestBaseDto {
  readonly id: Id;
  readonly status: RequestStatus;
  readonly version: number;
  readonly category: CategoryRefDto | null;
  readonly spec: string | null;
  readonly quantity: number | null;
  readonly unit: RequestUnit | null;
  readonly unit_set_description: string | null;
  readonly delivery_mode: DeliveryMode | null;
  readonly delivery_region: string | null;
  readonly bidding_deadline: Instant | null;
  readonly delivery_deadline: Instant | null;
  readonly bidding_closed_at: Instant | null;
  readonly is_bidding_open: boolean;
  readonly cancelled_at: Instant | null;
  readonly created_at: Instant;
  readonly updated_at: Instant;
}

/**
 * Full QuoteRequest DTO for Buyer owner and Admin (`docsAI/04-architecture/api-dtos.md` §2.2).
 */
export interface BuyerRequestDto extends RequestBaseDto {
  readonly buyer_id: Id;
  readonly recipient_name: string | null;
  readonly recipient_phone: string | null;
  readonly delivery_address: string | null;
  readonly cancel_reason: string | null;
  readonly split_requested_at: Instant | null;
  readonly coordination_state: CoordinationState | null;
  readonly no_valid_quotes: boolean;
  readonly nearest_accept_deadline: Instant | null;
  readonly delivery_confirmation: DeliveryConfirmationDto | null;
}

export type AdminRequestDto = BuyerRequestDto;

/**
 * Summary QuoteRequest DTO for Buyer/Admin paginated lists (`docsAI/04-architecture/api-dtos.md` §2.2).
 * Does not embed delivery_address or recipient contact details.
 */
export interface BuyerRequestSummaryDto {
  readonly id: Id;
  readonly status: RequestStatus;
  readonly version: number;
  readonly category: CategoryRefDto | null;
  readonly quantity: number | null;
  readonly unit: RequestUnit | null;
  readonly bidding_deadline: Instant | null;
  readonly delivery_deadline: Instant | null;
  readonly is_bidding_open: boolean;
  readonly cancelled_at: Instant | null;
  readonly split_requested_at: Instant | null;
  readonly coordination_state: CoordinationState | null;
  readonly no_valid_quotes: boolean;
  readonly nearest_accept_deadline: Instant | null;
  readonly created_at: Instant;
}

/**
 * RequestRecipient DTO (`docsAI/04-architecture/api-dtos.md` §2.3).
 */
export interface RecipientDto {
  readonly id: Id;
  readonly request_id: Id;
  readonly workshop: WorkshopRefDto;
  readonly response_status: RecipientResponseStatus;
  readonly version: number;
  readonly sent_at: Instant;
  readonly responded_at: Instant | null;
  readonly decline_reason: string | null;
  readonly eligibility_labels: readonly IneligibleQuoteReason[];
}

/**
 * Quote DTO (`docsAI/04-architecture/api-dtos.md` §2.3).
 */
export interface QuoteDto {
  readonly id: Id;
  readonly request_id: Id;
  readonly workshop: WorkshopRefDto;
  readonly unit_price: number;
  readonly max_quantity: number;
  readonly bid_accept_deadline: Instant;
  readonly committed_delivery_at: Instant;
  readonly status: QuoteStatus;
  readonly version: number;
  readonly withdraw_reason: string | null;
  readonly withdrawn_at: Instant | null;
  readonly is_eligible: boolean;
  readonly ineligible_reasons: readonly IneligibleQuoteReason[];
  readonly created_at: Instant;
  readonly updated_at: Instant;
}

/**
 * Mutation response DTO for submitting/updating/withdrawing a quote (`docsAI/04-architecture/api-dtos.md` §2.3).
 */
export interface QuoteMutationDto {
  readonly quote: QuoteDto;
  readonly recipient: RecipientDto;
}

/**
 * Artisan view of an invited QuoteRequest (`docsAI/04-architecture/api-dtos.md` §2.2, `BR-04`, `SEC-04`).
 * Contact and detailed address fields are strictly omitted unless the workshop has a confirmed Allocation.
 */
export interface InvitedRequestBaseDto extends RequestBaseDto {
  readonly own_recipient: RecipientDto;
  readonly own_quote: QuoteDto | null;
}

export interface InvitedRequestWithAllocationDto extends InvitedRequestBaseDto {
  readonly own_allocation_id: Id;
  readonly recipient_name: string | null;
  readonly recipient_phone: string | null;
  readonly delivery_address: string | null;
}

export type InvitedRequestDto = InvitedRequestBaseDto | InvitedRequestWithAllocationDto;

/**
 * AllocationBatch DTO (`docsAI/04-architecture/api-dtos.md` §2.3).
 */
export interface AllocationBatchDto {
  readonly batch_id: Id;
  readonly batch_name: string;
  readonly linked_quantity: number;
  readonly is_trace_public: boolean;
  readonly trace_url: string | null;
  readonly linked_at: Instant;
}

/**
 * StatusLog event DTO (`docsAI/04-architecture/api-dtos.md` §2.3).
 */
export interface RequestEventDto {
  readonly id: Id;
  readonly event_type: StatusLogEventType;
  readonly prev_status: RequestStatus | null;
  readonly new_status: RequestStatus;
  readonly performed_by: ActorDto | null;
  readonly created_at: Instant;
  readonly is_admin_action: boolean;
  readonly note: string | null;
  readonly evidence: string | null;
}

/**
 * AllocationLog event DTO (`docsAI/04-architecture/api-dtos.md` §2.3).
 */
export interface AllocationEventDto {
  readonly id: Id;
  readonly event_type: AllocationLogEventType;
  readonly prev_status: AllocationStatus | null;
  readonly new_status: AllocationStatus;
  readonly performed_by: ActorDto | null;
  readonly created_at: Instant;
  readonly is_admin_action: boolean;
  readonly note: string | null;
  readonly evidence: string | null;
}

/**
 * ContactEditHistory event DTO (`docsAI/04-architecture/api-dtos.md` §2.3).
 */
export interface ContactEventDto {
  readonly id: Id;
  readonly prev_recipient_name: string;
  readonly prev_recipient_phone: string;
  readonly new_recipient_name: string;
  readonly new_recipient_phone: string;
  readonly edited_by: ActorDto;
  readonly edited_at: Instant;
  readonly version: number;
}

/**
 * Strict allowlist DTO for `quote_snapshot` inside RecipientResponseHistory (`docsAI/04-architecture/api-dtos.md` §2.3).
 */
export interface QuoteSnapshotDto {
  readonly unit_price: number;
  readonly max_quantity: number;
  readonly bid_accept_deadline: Instant;
  readonly committed_delivery_at: Instant;
  readonly status: QuoteStatus;
  readonly version: number;
}

/**
 * RecipientResponseHistory event DTO (`docsAI/04-architecture/api-dtos.md` §2.3).
 */
export interface RecipientEventDto {
  readonly id: Id;
  readonly event_type: RecipientEventType;
  readonly prev_status: RecipientResponseStatus;
  readonly new_status: RecipientResponseStatus;
  readonly reason: string | null;
  readonly quote_snapshot: QuoteSnapshotDto | null;
  readonly performed_by: ActorDto;
  readonly created_at: Instant;
}

/**
 * Persisted domain record types (with database-assigned `id`) for history/audit/idempotency tables.
 */
export interface PersistedContactEditRecord extends ContactEditRecord {
  readonly id: Id;
}

export interface PersistedStatusLogRecord extends StatusLogRecord {
  readonly id: Id;
}

export interface PersistedRecipientResponseRecord extends RecipientResponseRecord {
  readonly id: Id;
}

export interface PersistedAllocationLogRecord extends AllocationLogRecord {
  readonly id: Id;
}

export interface PersistedIdempotencyRecord<TSnapshot = unknown> {
  readonly id: Id;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly account_id: Id;
  readonly action: string;
  readonly object_type: string;
  readonly object_id: Id;
  readonly result_snapshot: TSnapshot;
  readonly created_at: Date;
  readonly expires_at: Date;
}

export interface CreateIdempotencyRecordInput<TSnapshot = unknown> {
  readonly id?: Id;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly account_id: Id;
  readonly action: string;
  readonly object_type: string;
  readonly object_id: Id;
  readonly result_snapshot: TSnapshot;
  readonly created_at: Date;
  readonly expires_at: Date;
}

export interface IdempotencyScopeKey {
  readonly account_id: Id;
  readonly action: string;
  readonly object_type: string;
  readonly object_id: Id;
  readonly idempotency_key: string;
}

export interface TradingObjectStateSummary<TStatus extends string = string> {
  readonly id: Id;
  readonly status: TStatus;
  readonly version: number;
}

export interface TradingCurrentStateDto {
  readonly request: {
    readonly id: Id;
    readonly status: RequestStatus;
    readonly version: number;
    readonly cancelled_at: Instant | null;
  };
  readonly recipient?: TradingObjectStateSummary<RecipientResponseStatus> | null;
  readonly quote?: TradingObjectStateSummary<QuoteStatus> | null;
  readonly allocation?: TradingObjectStateSummary<AllocationStatus> | null;
}

export type TradingOperationMetadataDto<
  TState extends TradingCurrentStateDto = TradingCurrentStateDto,
> = OperationMetadata<TState>;

export type { QuoteSnapshotData, TraceabilityWarning };
