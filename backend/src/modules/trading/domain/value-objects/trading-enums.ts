export const REQUEST_STATUSES = [
  'draft_request',
  'sent_to_artisans',
  'artisans_bidding',
  'buyer_accepted',
  'in_production',
  'delivered',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const REQUEST_UNITS = ['piece', 'set'] as const;
export type RequestUnit = (typeof REQUEST_UNITS)[number];

export const DELIVERY_MODES = ['at_workshop', 'at_buyer_address'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const RECIPIENT_RESPONSE_STATUSES = [
  'pending',
  'declined',
  'quoted',
  'withdrawn',
] as const;
export type RecipientResponseStatus = (typeof RECIPIENT_RESPONSE_STATUSES)[number];

export const QUOTE_STATUSES = ['active', 'withdrawn', 'accepted'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const ALLOCATION_STATUSES = [
  'not_started',
  'in_production',
  'handed_over',
] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

export const COORDINATION_STATES = [
  'awaiting_admin',
  'needs_revision',
  'awaiting_buyer',
  'insufficient_capacity',
] as const;
export type CoordinationState = (typeof COORDINATION_STATES)[number];

export const INELIGIBLE_QUOTE_REASONS = [
  'QUOTE_WITHDRAWN',
  'QUOTE_EXPIRED',
  'WORKSHOP_SUSPENDED',
  'REQUEST_CANCELLED',
  'REQUEST_ACCEPTED',
] as const;
export type IneligibleQuoteReason = (typeof INELIGIBLE_QUOTE_REASONS)[number];

export const TRACEABILITY_WARNINGS = [
  'NO_BATCH_LINK',
  'INCOMPLETE_TRACEABILITY',
] as const;
export type TraceabilityWarning = (typeof TRACEABILITY_WARNINGS)[number];

export const STATUS_LOG_EVENT_TYPES = [
  'created',
  'sent',
  'first_quote',
  'bidding_closed',
  'accepted',
  'production_started',
  'received_by_buyer',
  'received_by_admin',
  'cancelled',
] as const;
export type StatusLogEventType = (typeof STATUS_LOG_EVENT_TYPES)[number];

export const ALLOCATION_LOG_EVENT_TYPES = [
  'created',
  'production_started',
  'handover_recorded',
  'handover_by_admin',
  'batch_links_changed',
] as const;
export type AllocationLogEventType = (typeof ALLOCATION_LOG_EVENT_TYPES)[number];

export const RECIPIENT_EVENT_TYPES = [
  'declined',
  'quote_submitted',
  'quote_updated',
  'quote_withdrawn',
  'quote_resubmitted',
  'quote_accepted',
] as const;
export type RecipientEventType = (typeof RECIPIENT_EVENT_TYPES)[number];

export const TRADING_ACTOR_ROLES = ['buyer', 'artisan', 'admin'] as const;
export type TradingActorRole = (typeof TRADING_ACTOR_ROLES)[number];
