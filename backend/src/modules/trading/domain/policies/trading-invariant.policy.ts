import {
  IdempotencyConflictError,
  TRADING_INVARIANTS,
} from '../errors/trading-domain.errors';
import { type Quote } from '../entities/quote.entity';
import { type QuoteRequest } from '../entities/quote-request.entity';
import { type SplitProposal } from '../entities/split-proposal.entity';
import { EntityId, type SplitProposalExpireReason } from '../value-objects';

export const TRADING_LOCK_ENTITY_ORDER = [
  'QuoteRequest',
  'SplitProposal',
  'RequestRecipient',
  'Quote',
  'Allocation',
] as const;

export type TradingLockableEntity = (typeof TRADING_LOCK_ENTITY_ORDER)[number];

export interface OrderedLockPlan {
  readonly requestIds: readonly string[];
  readonly proposalIds: readonly string[];
  readonly recipientIds: readonly string[];
  readonly quoteIds: readonly string[];
  readonly allocationIds: readonly string[];
}

/**
 * Enforces deterministic lock acquisition order across Trading entities (`BR-27`):
 * `QuoteRequest -> SplitProposal -> RequestRecipient -> Quote -> Allocation`,
 * with multiple rows of the same table sorted by `id` ascending.
 */
export class TradingLockOrderingPolicy {
  static buildLockPlan(input: {
    readonly requestIds?: readonly (string | EntityId)[];
    readonly proposalIds?: readonly (string | EntityId)[];
    readonly recipientIds?: readonly (string | EntityId)[];
    readonly quoteIds?: readonly (string | EntityId)[];
    readonly allocationIds?: readonly (string | EntityId)[];
  }): OrderedLockPlan {
    return Object.freeze({
      requestIds: Object.freeze(
        EntityId.sortAscending(Array.from(new Set(input.requestIds ?? []))),
      ),
      proposalIds: Object.freeze(
        EntityId.sortAscending(Array.from(new Set(input.proposalIds ?? []))),
      ),
      recipientIds: Object.freeze(
        EntityId.sortAscending(Array.from(new Set(input.recipientIds ?? []))),
      ),
      quoteIds: Object.freeze(
        EntityId.sortAscending(Array.from(new Set(input.quoteIds ?? []))),
      ),
      allocationIds: Object.freeze(
        EntityId.sortAscending(Array.from(new Set(input.allocationIds ?? []))),
      ),
    });
  }
}

/**
 * Enforces INV-05 idempotency fingerprint verification (`BR-27`, `SEC-13`).
 */
export class TradingIdempotencyPolicy {
  static assertFingerprintMatches(
    storedFingerprint: string,
    incomingFingerprint: string,
  ): void {
    if (storedFingerprint !== incomingFingerprint) {
      throw new IdempotencyConflictError(
        'Idempotency-Key was replayed with a different request payload fingerprint.',
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'IdempotencyRecord',
        },
      );
    }
  }
}

/**
 * Evaluates whether a `proposed` SplitProposal has become invalid due to quote expiry,
 * quote withdrawal, quote modification, workshop suspension, or request state change (`BR-19`, `INV-03`).
 */
export class SplitProposalInvalidationPolicy {
  static detectExpiryReason(input: {
    readonly proposal: SplitProposal;
    readonly request: QuoteRequest;
    readonly quotesById: ReadonlyMap<
      string,
      { readonly quote: Quote; readonly workshopIsActive: boolean }
    >;
    readonly now: Date;
  }): SplitProposalExpireReason | null {
    if (input.proposal.status !== 'proposed') {
      return null;
    }

    if (input.request.isCancelled()) {
      return 'request_cancelled';
    }

    if (input.request.isAcceptedOrBeyond()) {
      return 'request_accepted';
    }

    for (const item of input.proposal.items) {
      const entry = input.quotesById.get(item.quote_id);
      if (!entry) {
        return 'quote_withdrawn';
      }

      if (entry.quote.status === 'withdrawn') {
        return 'quote_withdrawn';
      }

      if (entry.quote.version !== item.quote_version) {
        return 'quote_changed';
      }

      if (!entry.workshopIsActive) {
        return 'workshop_suspended';
      }

      if (input.now.getTime() >= entry.quote.bid_accept_deadline.getTime()) {
        return 'quote_expired';
      }
    }

    return null;
  }
}
