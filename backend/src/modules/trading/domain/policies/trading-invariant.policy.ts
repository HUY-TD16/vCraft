import {
  IdempotencyConflictError,
  TRADING_INVARIANTS,
} from '../errors/trading-domain.errors';
import { EntityId } from '../value-objects';

export const TRADING_LOCK_ENTITY_ORDER = [
  'QuoteRequest',
  'RequestRecipient',
  'Quote',
  'Allocation',
] as const;

export type TradingLockableEntity = (typeof TRADING_LOCK_ENTITY_ORDER)[number];

export interface OrderedLockPlan {
  readonly requestIds: readonly string[];
  readonly recipientIds: readonly string[];
  readonly quoteIds: readonly string[];
  readonly allocationIds: readonly string[];
}

/**
 * Enforces deterministic lock acquisition order across Trading entities (`BR-27`):
 * `QuoteRequest -> RequestRecipient -> Quote -> Allocation`,
 * with multiple rows of the same table sorted by `id` ascending.
 */
export class TradingLockOrderingPolicy {
  static buildLockPlan(input: {
    readonly requestIds?: readonly (string | EntityId)[];
    readonly recipientIds?: readonly (string | EntityId)[];
    readonly quoteIds?: readonly (string | EntityId)[];
    readonly allocationIds?: readonly (string | EntityId)[];
  }): OrderedLockPlan {
    return Object.freeze({
      requestIds: Object.freeze(
        EntityId.sortAscending(Array.from(new Set(input.requestIds ?? []))),
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
