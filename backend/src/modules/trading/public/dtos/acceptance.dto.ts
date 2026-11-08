import type { Id, Instant } from '../../../../common/application/types/contract-types';
import type { OperationMetadata } from '../../../../common/application/types/operation-metadata';

export type RequestStatus =
  | 'draft_request' | 'sent_to_artisans' | 'artisans_bidding'
  | 'buyer_accepted' | 'in_production' | 'delivered';
export type AllocationStatus = 'not_started' | 'in_production' | 'handed_over';
export type ActorDto = { id: Id; display_name: string | null };

export interface AllocationDto {
  id: Id;
  request_id: Id;
  workshop: { id: Id; name: string };
  quote_id: Id;
  quantity: number;
  unit_price: number;
  committed_delivery_at: Instant;
  status: AllocationStatus;
  version: number;
  started_at: Instant | null;
  started_by: ActorDto | null;
  handed_over_at: Instant | null;
  handed_over_by: ActorDto | null;
  delivery_note: string | null;
  admin_handed_over: boolean;
  admin_handover_reason: string | null;
  admin_delivery_evidence: string | null;
  admin_handover_actual_at: Instant | null;
  traceability_warning: 'NO_BATCH_LINK' | 'INCOMPLETE_TRACEABILITY' | null;
}

export interface AcceptanceDto {
  request_id: Id;
  request_status: RequestStatus;
  request_version: number;
  accepted_proposal_id: Id | null;
  allocations: AllocationDto[];
}

export type AcceptanceOperationDto = OperationMetadata<{
    request: { id: Id; status: RequestStatus; version: number; cancelled_at: Instant | null };
    quote?: { id: Id; status: 'active' | 'withdrawn' | 'accepted'; version: number } | null;
    proposal?: { id: Id; status: 'proposed' | 'accepted' | 'expired'; version: number } | null;
}>;
