import {
  BusinessRuleException,
  type BusinessRuleCode,
  type BusinessRuleDetail,
  type BusinessRuleDetails,
} from '../../../../common/domain/errors/business-rule.exception';

export const TRADING_INVARIANTS = {
  INV_01_STATE_MACHINE_AND_CANCELLATION: 'INV-01',
  INV_02_DEADLINES_AND_BIDDING_WINDOW: 'INV-02',
  INV_03_QUANTITY_AND_SPLIT_PROPOSAL: 'INV-03',
  INV_04_ALLOCATION_AND_BATCH_TRACEABILITY: 'INV-04',
  INV_05_CONCURRENCY_AND_IDEMPOTENCY: 'INV-05',
} as const;

export type TradingInvariantCode =
  (typeof TRADING_INVARIANTS)[keyof typeof TRADING_INVARIANTS];

export interface TradingErrorDetails {
  readonly invariant?: TradingInvariantCode;
  readonly entity?: string;
  readonly field?: string;
  readonly [key: string]:
    | BusinessRuleDetail
    | readonly BusinessRuleDetail[]
    | undefined;
}

function normalizeDetails(details: TradingErrorDetails): BusinessRuleDetails {
  const normalized: Record<string, BusinessRuleDetail | readonly BusinessRuleDetail[]> =
    {};
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined) {
      normalized[key] = value;
    }
  }
  return normalized;
}

export class TradingDomainError extends BusinessRuleException {
  readonly invariant?: TradingInvariantCode;

  constructor(
    code: BusinessRuleCode,
    message: string,
    details: TradingErrorDetails = {},
  ) {
    super(code, message, normalizeDetails(details));
    this.invariant = details.invariant;
  }
}

/**
 * INV-01 / INV-03 / INV-04: State transition, immutability, or cancellation violation.
 */
export class InvalidStateTransitionError extends TradingDomainError {
  constructor(
    message: string = 'Invalid trading state transition.',
    details: TradingErrorDetails = {},
  ) {
    super('INVALID_STATE', message, {
      invariant: details.invariant ?? TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
      ...details,
    });
  }
}

/**
 * INV-02 / INV-04: 24-hour minimum buffer, chronological ordering, or actual handover timestamp violation.
 */
export class DeadlineViolationError extends TradingDomainError {
  constructor(
    message: string = 'Trading deadline constraint violated.',
    details: TradingErrorDetails = {},
  ) {
    super('DEADLINE_VIOLATION', message, {
      invariant: details.invariant ?? TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
      ...details,
    });
  }
}

/**
 * INV-02: Bidding window is already closed (or still open when split proposal requires closed bidding).
 */
export class BiddingClosedError extends TradingDomainError {
  constructor(
    message: string = 'Bidding is closed for this quote request.',
    details: TradingErrorDetails = {},
  ) {
    super('BIDDING_CLOSED', message, {
      invariant: details.invariant ?? TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
      ...details,
    });
  }
}

/**
 * INV-02: Quote or split proposal acceptance deadline has passed (`now >= bid_accept_deadline`).
 */
export class QuoteExpiredError extends TradingDomainError {
  constructor(
    message: string = 'Quote acceptance deadline has expired.',
    details: TradingErrorDetails = {},
  ) {
    super('QUOTE_EXPIRED', message, {
      invariant: details.invariant ?? TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
      ...details,
    });
  }
}

/**
 * INV-02: Workshop is suspended and cannot submit, update, or be accepted for a quote.
 */
export class WorkshopSuspendedError extends TradingDomainError {
  constructor(
    message: string = 'Workshop is suspended.',
    details: TradingErrorDetails = {},
  ) {
    super('WORKSHOP_SUSPENDED', message, {
      invariant: details.invariant ?? TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
      ...details,
    });
  }
}

/**
 * INV-02: No active public workshops exist when sending a quote request.
 */
export class NoEligibleWorkshopError extends TradingDomainError {
  constructor(
    message: string = 'No eligible public active workshop is available to receive the quote request.',
    details: TradingErrorDetails = {},
  ) {
    super('NO_ELIGIBLE_WORKSHOP', message, {
      invariant: details.invariant ?? TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
      ...details,
    });
  }
}

/**
 * INV-03: Direct accept capacity < 100% or split proposal quantities violate capacity/sum constraints.
 */
export class InsufficientCapacityError extends TradingDomainError {
  constructor(
    message: string = 'Allocated or quoted quantity does not satisfy the required request capacity.',
    details: TradingErrorDetails = {},
  ) {
    super('INSUFFICIENT_CAPACITY', message, {
      invariant: details.invariant ?? TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
      ...details,
    });
  }
}

/**
 * INV-05: Optimistic concurrency version mismatch or ProposalExpectation mismatch.
 */
export class ConcurrencyConflictError extends TradingDomainError {
  constructor(
    message: string = 'Expected entity version or proposal expectation does not match current state.',
    details: TradingErrorDetails = {},
  ) {
    super('CONCURRENCY_CONFLICT', message, {
      invariant: details.invariant ?? TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
      ...details,
    });
  }
}

/**
 * INV-05: Idempotency key reused with a different request payload fingerprint.
 */
export class IdempotencyConflictError extends TradingDomainError {
  constructor(
    message: string = 'Idempotency key has already been used with a different request fingerprint.',
    details: TradingErrorDetails = {},
  ) {
    super('IDEMPOTENCY_CONFLICT', message, {
      invariant: details.invariant ?? TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
      ...details,
    });
  }
}

/**
 * Domain input validation failure (field constraints, batch link quantities, mandatory reasons).
 */
export class InvalidTradingInputError extends TradingDomainError {
  constructor(
    message: string = 'Invalid trading domain input.',
    details: TradingErrorDetails = {},
  ) {
    super('INVALID_INPUT', message, details);
  }
}

/**
 * Domain actor authorization failure (e.g., non-owner or wrong role attempting cancel/update).
 */
export class TradingPermissionDeniedError extends TradingDomainError {
  constructor(
    message: string = 'Actor does not have permission to perform this trading operation.',
    details: TradingErrorDetails = {},
  ) {
    super('PERMISSION_DENIED', message, details);
  }
}

/**
 * Domain target resource not found.
 */
export class TradingResourceNotFoundError extends TradingDomainError {
  constructor(
    message: string = 'Requested trading resource was not found.',
    details: TradingErrorDetails = {},
  ) {
    super('RESOURCE_NOT_FOUND', message, details);
  }
}

/**
 * Explicit INV-01 error class: 6-step QuoteRequest state machine & cancellation invariants.
 */
export class Invariant01StateMachineError extends InvalidStateTransitionError {
  constructor(message: string, details: Omit<TradingErrorDetails, 'invariant'> = {}) {
    super(message, {
      ...details,
      invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
    });
  }
}

/**
 * Explicit INV-02 error class: 24-hour deadline window & bidding open/close invariants.
 */
export class Invariant02DeadlineBiddingError extends DeadlineViolationError {
  constructor(message: string, details: Omit<TradingErrorDetails, 'invariant'> = {}) {
    super(message, {
      ...details,
      invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
    });
  }
}

/**
 * Explicit INV-03 error class: Quantity bounds, direct accept 100% capacity, & SplitProposal sum invariants.
 */
export class Invariant03QuantitySplitError extends InsufficientCapacityError {
  constructor(message: string, details: Omit<TradingErrorDetails, 'invariant'> = {}) {
    super(message, {
      ...details,
      invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
    });
  }
}

/**
 * Explicit INV-04 error class: Allocation state machine, commercial immutability, batch links, & handover invariants.
 */
export class Invariant04FulfillmentBatchError extends InvalidStateTransitionError {
  constructor(message: string, details: Omit<TradingErrorDetails, 'invariant'> = {}) {
    super(message, {
      ...details,
      invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
    });
  }
}

/**
 * Explicit INV-05 error class: Optimistic concurrency version & idempotency fingerprint invariants.
 */
export class Invariant05ConcurrencyIdempotencyError extends ConcurrencyConflictError {
  constructor(message: string, details: Omit<TradingErrorDetails, 'invariant'> = {}) {
    super(message, {
      ...details,
      invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
    });
  }
}
