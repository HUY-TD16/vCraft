import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../common/application/ports/transaction-runner';
import type {
  Id,
} from '../../../../common/application/types/contract-types';
import type { OperationMetadata } from '../../../../common/application/types/operation-metadata';
import type {
  CreateIdempotencyRecordInput,
  IdempotencyScopeKey,
  TradingCurrentStateDto,
} from '../dtos/trading-persistence.dtos';
import type { IIdempotencyRecordRepository } from '../ports/repositories/trading-repositories.port';
import {
  EntityId,
  InvalidTradingInputError,
  TradingIdempotencyPolicy,
} from '../../domain';
import { computeCanonicalFingerprint } from '../../domain/utilities';

const DEFAULT_TTL_HOURS = 24;
const MAX_KEY_LENGTH = 128;

export interface ExecuteWithIdempotencyInput<
  TResult,
  TState extends TradingCurrentStateDto = TradingCurrentStateDto,
> {
  /** Account ID of the actor initiating the mutation (accepts camelCase or snake_case) */
  readonly accountId?: Id;
  readonly account_id?: Id;

  /** Action name (e.g. 'accept_quote', 'cancel', 'confirm_delivery') */
  readonly action: string;

  /** Target domain entity type (e.g. 'QuoteRequest', 'Allocation') */
  readonly objectType?: string;
  readonly object_type?: string;

  /** Target domain entity ID */
  readonly objectId?: Id;
  readonly object_id?: Id;

  /** Client-provided UUID v4 idempotency key */
  readonly idempotencyKey?: string;
  readonly idempotency_key?: string;

  /** Raw request payload (body + expected versions) used to compute canonical SHA-256 fingerprint */
  readonly payload: unknown;

  /** Business mutation logic executed atomically within the transaction */
  readonly execute: (
    tx: TransactionContext,
  ) => Promise<{ result: TResult; currentState: TState }>;

  /** Query callback to fetch fresh state of the entity without executing business mutation */
  readonly getCurrentState: (tx: TransactionContext) => Promise<TState>;

  /** Optional parser/validator for cached JSON snapshot */
  readonly snapshotParser?: (raw: unknown) => TResult;

  /** Custom TTL duration in hours (defaults to 24) */
  readonly ttlHours?: number;

  /** Reference timestamp for creation and expiration (defaults to new Date()) */
  readonly now?: Date;
}

export interface ExecuteWithIdempotencyResult<
  TResult,
  TState extends TradingCurrentStateDto = TradingCurrentStateDto,
> {
  /** Result data DTO */
  readonly data: TResult;

  /** Result alias matching execute() return */
  readonly result: TResult;

  /** Standard operation metadata containing id, replayed flag, committed_at, and current_state */
  readonly operation: OperationMetadata<TState>;

  /** Whether this response was served from cached idempotency record (replayed) */
  readonly replayed: boolean;

  /** Fresh state of the entity */
  readonly currentState: TState;

  /** ID of the persisted IdempotencyRecord */
  readonly recordId: Id;
}

/**
 * Application service managing Idempotency lifecycle (BR-27, SEC-06, INV-05):
 * - Scoped idempotency verification (account_id, action, object_type, object_id, idempotency_key)
 * - Canonical SHA-256 fingerprint matching
 * - Atomic transactional execution with business mutations
 * - Safe replay with fresh current_state
 * - Concurrency race condition handling (P2002 fallback)
 * - 24-hour TTL expiration and cleanup
 */
export class TradingIdempotencyService {
  constructor(
    private readonly idempotencyRepo: IIdempotencyRecordRepository,
    private readonly txRunner: TransactionRunner,
    private readonly fingerprintCalculator: (payload: unknown) => string = computeCanonicalFingerprint,
  ) {}

  /**
   * Executes a business mutation with idempotency guarantees (BR-27, SEC-06, INV-05):
   * 1. Validates scope parameters and calculates incoming canonical SHA-256 fingerprint.
   * 2. Checks if an IdempotencyRecord already exists for the given scope (account_id, action, object_type, object_id, idempotency_key).
   * 3. If exists:
   *    - Asserts fingerprint match via TradingIdempotencyPolicy. Mismatch throws HTTP 409 IdempotencyConflictError.
   *    - Fetches fresh currentState via input.getCurrentState(tx).
   *    - Returns cached snapshot with replayed: true. Business execution callback is NOT invoked.
   * 4. If not exists:
   *    - Executes input.execute(tx) and saves IdempotencyRecord in the SAME transaction context.
   *    - Catches concurrent P2002 race conditions and safely falls back to replay verification.
   *    - Returns newly produced result with replayed: false and current state.
   */
  async executeWithIdempotency<
    TResult,
    TState extends TradingCurrentStateDto = TradingCurrentStateDto,
  >(
    input: ExecuteWithIdempotencyInput<TResult, TState>,
  ): Promise<ExecuteWithIdempotencyResult<TResult, TState>> {
    // 1. Normalize and validate scope
    const scope = this.normalizeScope(input);

    // 2. Compute canonical incoming fingerprint
    const incomingFingerprint = this.fingerprintCalculator(input.payload);

    // 3. Check if record already exists in database
    const existing = await this.txRunner.run(async (tx) => {
      return this.idempotencyRepo.findByScope<TResult>(
        scope,
        tx,
        input.snapshotParser,
      );
    });

    if (existing !== null) {
      // 3a. Verify fingerprint match (throws IdempotencyConflictError if mismatch)
      TradingIdempotencyPolicy.assertFingerprintMatches(
        existing.request_fingerprint,
        incomingFingerprint,
      );

      // 3b. Fetch fresh current state without executing business mutation
      const currentState = await this.txRunner.run(async (tx) => {
        return input.getCurrentState(tx);
      });

      return this.buildResult({
        result: existing.result_snapshot,
        recordId: existing.id,
        replayed: true,
        committedAt: existing.created_at,
        currentState,
      });
    }

    // 4. Record not found: execute business mutation in atomic transaction
    try {
      const executionResult = await this.txRunner.run(async (tx) => {
        // Execute business mutation
        const { result, currentState } = await input.execute(tx);

        // Calculate expiration timestamp (created_at + 24 hours)
        const now = input.now ?? new Date();
        const ttlHours = input.ttlHours ?? DEFAULT_TTL_HOURS;
        const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

        // Sanitize snapshot data to ensure valid non-null JSON object for PostgreSQL jsonb
        const snapshotData =
          result === null || result === undefined
            ? ({} as TResult)
            : result;

        const recordInput: CreateIdempotencyRecordInput<TResult> = {
          idempotency_key: scope.idempotency_key,
          request_fingerprint: incomingFingerprint,
          account_id: scope.account_id,
          action: scope.action,
          object_type: scope.object_type,
          object_id: scope.object_id,
          result_snapshot: snapshotData,
          created_at: now,
          expires_at: expiresAt,
        };

        const savedRecord = await this.idempotencyRepo.save<TResult>(
          recordInput,
          tx,
          input.snapshotParser,
        );

        return {
          result,
          currentState,
          record: savedRecord,
        };
      });

      return this.buildResult({
        result: executionResult.result,
        recordId: executionResult.record.id,
        replayed: false,
        committedAt: executionResult.record.created_at,
        currentState: executionResult.currentState,
      });
    } catch (error: unknown) {
      // 5. Handle concurrent race condition (Prisma P2002 unique constraint violation)
      if (this.isP2002Error(error)) {
        const fallbackReplay = await this.txRunner.run(async (replayTx) => {
          const replayRecord =
            await this.idempotencyRepo.findAndVerifyReplay<TResult>(
              {
                ...scope,
                request_fingerprint: incomingFingerprint,
              },
              replayTx,
              input.snapshotParser,
            );

          if (!replayRecord) {
            return null;
          }

          const currentState = await input.getCurrentState(replayTx);
          return { replayRecord, currentState };
        });

        if (fallbackReplay !== null) {
          return this.buildResult({
            result: fallbackReplay.replayRecord.result_snapshot,
            recordId: fallbackReplay.replayRecord.id,
            replayed: true,
            committedAt: fallbackReplay.replayRecord.created_at,
            currentState: fallbackReplay.currentState,
          });
        }

        // If findAndVerifyReplay returned null, verify if winning record has a mismatched fingerprint
        const existingRecord = await this.txRunner.run(async (replayTx) => {
          return this.idempotencyRepo.findByScope<TResult>(
            scope,
            replayTx,
            input.snapshotParser,
          );
        });

        if (existingRecord !== null) {
          TradingIdempotencyPolicy.assertFingerprintMatches(
            existingRecord.request_fingerprint,
            incomingFingerprint,
          );
        }
      }

      // Re-throw any business or unrecoverable error (transaction already rolled back)
      throw error;
    }
  }

  /**
   * Deletes all expired IdempotencyRecord rows where `expires_at < cutoff` (BR-27, member-3-trading-tasks §2.9).
   * @param cutoff Expiration threshold (defaults to current system time `new Date()`)
   * @returns Number of deleted records
   */
  async cleanupExpired(cutoff?: Date): Promise<number> {
    const targetCutoff = cutoff ?? new Date();
    return this.txRunner.run(async (tx) => {
      return this.idempotencyRepo.deleteExpiredBefore(targetCutoff, tx);
    });
  }

  // --- Private Helpers ---

  private normalizeScope<TResult, TState extends TradingCurrentStateDto>(
    input: ExecuteWithIdempotencyInput<TResult, TState>,
  ): IdempotencyScopeKey {
    const rawAccountId = input.account_id ?? input.accountId;
    if (rawAccountId === undefined || rawAccountId === null) {
      throw new InvalidTradingInputError(
        'account_id is required for idempotency scope.',
        { field: 'account_id' },
      );
    }
    const account_id = EntityId.of(rawAccountId, 'account_id').value;

    const action = (input.action ?? '').trim();
    if (action.length === 0) {
      throw new InvalidTradingInputError(
        'action must be a non-empty string for idempotency scope.',
        { field: 'action' },
      );
    }

    const rawObjectType = input.object_type ?? input.objectType ?? '';
    const object_type = rawObjectType.trim();
    if (object_type.length === 0) {
      throw new InvalidTradingInputError(
        'object_type must be a non-empty string for idempotency scope.',
        { field: 'object_type' },
      );
    }

    const rawObjectId = input.object_id ?? input.objectId;
    if (rawObjectId === undefined || rawObjectId === null) {
      throw new InvalidTradingInputError(
        'object_id is required for idempotency scope.',
        { field: 'object_id' },
      );
    }
    const object_id = EntityId.of(rawObjectId, 'object_id').value;

    const rawKey = (input.idempotency_key ?? input.idempotencyKey ?? '').trim();
    if (rawKey.length === 0) {
      throw new InvalidTradingInputError(
        'idempotency_key must be a non-empty string.',
        { field: 'idempotency_key' },
      );
    }
    if (rawKey.length > MAX_KEY_LENGTH) {
      throw new InvalidTradingInputError(
        `idempotency_key cannot exceed ${MAX_KEY_LENGTH} characters.`,
        { field: 'idempotency_key' },
      );
    }

    return Object.freeze({
      account_id,
      action,
      object_type,
      object_id,
      idempotency_key: rawKey,
    });
  }

  private buildResult<TResult, TState extends TradingCurrentStateDto>(params: {
    readonly result: TResult;
    readonly recordId: Id;
    readonly replayed: boolean;
    readonly committedAt: Date;
    readonly currentState: TState;
  }): ExecuteWithIdempotencyResult<TResult, TState> {
    const committed_at = params.committedAt.toISOString();
    const operation: OperationMetadata<TState> = Object.freeze({
      id: params.recordId,
      replayed: params.replayed,
      committed_at,
      current_state: params.currentState,
    });

    return Object.freeze({
      data: params.result,
      result: params.result,
      operation,
      replayed: params.replayed,
      currentState: params.currentState,
      recordId: params.recordId,
    });
  }

  private isP2002Error(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const err = error as Record<string, unknown>;
    if (err.code === 'P2002') {
      return true;
    }
    if (
      typeof err.message === 'string' &&
      (err.message.includes('P2002') ||
        err.message.toLowerCase().includes('unique constraint'))
    ) {
      return true;
    }
    return false;
  }
}
