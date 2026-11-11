import { describe, expect, it, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../src/common/application/ports/transaction-runner';
import type {
  CreateIdempotencyRecordInput,
  IdempotencyScopeKey,
  PersistedIdempotencyRecord,
  TradingCurrentStateDto,
} from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';
import type { IIdempotencyRecordRepository } from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import {
  IdempotencyConflictError,
  InvalidTradingInputError,
  ConcurrencyConflictError,
  TRADING_INVARIANTS,
} from '../../../../src/modules/trading/domain';
import {
  TradingIdempotencyService,
  type ExecuteWithIdempotencyInput,
} from '../../../../src/modules/trading/application/services/trading-idempotency.service';
import {
  computeCanonicalFingerprint,
  validateUuidV4,
} from '../../../../src/modules/trading/domain/utilities/idempotency.utilities';
import { statusByCode } from '../../../../src/common/http/filters/api-problem';
import { problems } from '../../../../src/common/http/filters/problem-details.filter';

// ============================================================================
// Specialized Empirical Challenger Fixtures & Concurrent Harness
// ============================================================================

class SimulatedPrismaP2002Error extends Error {
  readonly code = 'P2002';
  readonly clientVersion = '5.10.0';
  constructor(
    message = 'Unique constraint failed on the constraint: `account_id_action_object_type_object_id_idempotency_key`',
  ) {
    super(message);
    this.name = 'PrismaClientKnownRequestError';
  }
}

interface StoredRow<T = unknown> {
  id: string;
  idempotency_key: string;
  request_fingerprint: string;
  account_id: string;
  action: string;
  object_type: string;
  object_id: string;
  result_snapshot: T;
  created_at: Date;
  expires_at: Date;
}

class ConcurrentTransactionalHarness {
  private readonly committedStore = new Map<string, StoredRow>();
  private nextId = 1000n;
  public totalExecutions = 0;
  public totalSaves = 0;
  public totalRollbacks = 0;

  private makeScopeKey(scope: {
    account_id: string;
    action: string;
    object_type: string;
    object_id: string;
    idempotency_key: string;
  }): string {
    return `${scope.account_id}:${scope.action.trim()}:${scope.object_type.trim()}:${scope.object_id}:${scope.idempotency_key.trim().toLowerCase()}`;
  }

  readonly txRunner: TransactionRunner = {
    run: async <T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> => {
      // Create transaction context with pending staging buffer
      const pendingStaging = new Map<string, StoredRow>();
      const txCtx = { __brand: `tx-${Math.random()}` } as unknown as TransactionContext;

      try {
        const result = await work(txCtx);
        // On success: commit staged rows into committed store
        for (const [key, row] of pendingStaging.entries()) {
          if (this.committedStore.has(key)) {
            // Concurrent race conflict detected at commit time
            throw new SimulatedPrismaP2002Error();
          }
          this.committedStore.set(key, row);
        }
        return result;
      } catch (err) {
        // Rollback: discard staging buffer
        this.totalRollbacks++;
        pendingStaging.clear();
        throw err;
      }
    },
  };

  readonly repo: IIdempotencyRecordRepository = {
    findByScope: async <TSnapshot = unknown>(
      scope: IdempotencyScopeKey,
      _tx: TransactionContext,
      _parser?: (raw: unknown) => TSnapshot,
    ): Promise<PersistedIdempotencyRecord<TSnapshot> | null> => {
      const key = this.makeScopeKey(scope);
      const row = this.committedStore.get(key);
      if (!row) return null;
      return {
        id: row.id,
        idempotency_key: row.idempotency_key,
        request_fingerprint: row.request_fingerprint,
        account_id: row.account_id,
        action: row.action,
        object_type: row.object_type,
        object_id: row.object_id,
        result_snapshot: row.result_snapshot as TSnapshot,
        created_at: new Date(row.created_at),
        expires_at: new Date(row.expires_at),
      };
    },

    findAndVerifyReplay: async <TSnapshot = unknown>(
      input: IdempotencyScopeKey & { readonly request_fingerprint: string },
      tx: TransactionContext,
      parser?: (raw: unknown) => TSnapshot,
    ): Promise<PersistedIdempotencyRecord<TSnapshot> | null> => {
      const record = await this.repo.findByScope<TSnapshot>(input, tx, parser);
      if (!record) return null;
      if (record.request_fingerprint !== input.request_fingerprint) {
        return null;
      }
      return record;
    },

    save: async <TSnapshot = unknown>(
      input: CreateIdempotencyRecordInput<TSnapshot>,
      _tx: TransactionContext,
      _parser?: (raw: unknown) => TSnapshot,
    ): Promise<PersistedIdempotencyRecord<TSnapshot>> => {
      this.totalSaves++;
      const key = this.makeScopeKey({
        account_id: input.account_id,
        action: input.action,
        object_type: input.object_type,
        object_id: input.object_id,
        idempotency_key: input.idempotency_key,
      });

      // If already committed by another thread, simulate database P2002 immediately
      if (this.committedStore.has(key)) {
        throw new SimulatedPrismaP2002Error();
      }

      const id = String(this.nextId++);
      const row: StoredRow = {
        id,
        idempotency_key: input.idempotency_key,
        request_fingerprint: input.request_fingerprint,
        account_id: input.account_id,
        action: input.action,
        object_type: input.object_type,
        object_id: input.object_id,
        result_snapshot: input.result_snapshot,
        created_at: input.created_at,
        expires_at: input.expires_at,
      };

      // Directly persist into committed store to simulate DB write locking
      this.committedStore.set(key, row);

      return {
        id,
        idempotency_key: row.idempotency_key,
        request_fingerprint: row.request_fingerprint,
        account_id: row.account_id,
        action: row.action,
        object_type: row.object_type,
        object_id: row.object_id,
        result_snapshot: row.result_snapshot as TSnapshot,
        created_at: row.created_at,
        expires_at: row.expires_at,
      };
    },

    deleteExpiredBefore: async (
      cutoff: Date,
      _tx: TransactionContext,
    ): Promise<number> => {
      let count = 0;
      for (const [key, row] of Array.from(this.committedStore.entries())) {
        if (row.expires_at.getTime() < cutoff.getTime()) {
          this.committedStore.delete(key);
          count++;
        }
      }
      return count;
    },
  };

  getCommittedCount(): number {
    return this.committedStore.size;
  }

  getCommittedRow(scope: {
    account_id: string;
    action: string;
    object_type: string;
    object_id: string;
    idempotency_key: string;
  }): StoredRow | undefined {
    return this.committedStore.get(this.makeScopeKey(scope));
  }

  seedRow(row: StoredRow): void {
    const key = this.makeScopeKey({
      account_id: row.account_id,
      action: row.action,
      object_type: row.object_type,
      object_id: row.object_id,
      idempotency_key: row.idempotency_key,
    });
    this.committedStore.set(key, row);
  }
}

// ============================================================================
// CHALLENGER EMPIRICAL TEST SUITE
// ============================================================================

describe('EMPIRICAL CHALLENGER: TradingIdempotencyService Concurrency & Boundaries', () => {
  let harness: ConcurrentTransactionalHarness;
  let service: TradingIdempotencyService;

  const KEY_UUID = '550e8400-e29b-41d4-a716-446655440000';
  const BASE_PAYLOAD = {
    expected_request_version: 1,
    quote_id: 'quote-42',
    notes: 'Urgent ceramic delivery',
  };

  beforeEach(() => {
    harness = new ConcurrentTransactionalHarness();
    service = new TradingIdempotencyService(harness.repo, harness.txRunner);
  });

  // ==========================================================================
  // CHALLENGE 1: Concurrent Race Condition (P2002 Handler Verification)
  // ==========================================================================
  describe('Challenge 1: Concurrent Race Condition & P2002 Handler', () => {
    it('1.1 Two simultaneous requests with same key & payload: first commits, second cleanly recovers via P2002 with replayed=true', async () => {
      let executionCounter = 0;
      const executeFn = async (_tx: TransactionContext) => {
        executionCounter++;
        return {
          result: { quoteRequestId: '100', status: 'buyer_accepted' },
          currentState: {
            request: { id: '100', status: 'buyer_accepted', version: 2, cancelled_at: null },
          },
        };
      };

      const currentStateFn = async (_tx: TransactionContext) => ({
        request: { id: '100', status: 'buyer_accepted', version: 2, cancelled_at: null },
      });

      const input1: ExecuteWithIdempotencyInput<{ quoteRequestId: string; status: string }> = {
        accountId: '10',
        action: 'accept_quote',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: KEY_UUID,
        payload: BASE_PAYLOAD,
        execute: executeFn,
        getCurrentState: currentStateFn,
      };

      const input2: ExecuteWithIdempotencyInput<{ quoteRequestId: string; status: string }> = {
        ...input1,
      };

      // Run both concurrently
      const [res1, res2] = await Promise.all([
        service.executeWithIdempotency(input1),
        service.executeWithIdempotency(input2),
      ]);

      // Exactly one must be initial (replayed: false) and one must be replay (replayed: true)
      const results = [res1, res2];
      const initial = results.find((r) => !r.replayed);
      const replayed = results.find((r) => r.replayed);

      expect(initial).toBeDefined();
      expect(replayed).toBeDefined();

      // Data snapshots and committed IDs must match
      expect(initial?.data).toEqual({ quoteRequestId: '100', status: 'buyer_accepted' });
      expect(replayed?.data).toEqual({ quoteRequestId: '100', status: 'buyer_accepted' });
      expect(replayed?.operation.id).toBe(initial?.operation.id);
      expect(replayed?.operation.replayed).toBe(true);
      expect(replayed?.operation.current_state).toEqual(initial?.operation.current_state);

      // Exactly 1 record persisted in store
      expect(harness.getCommittedCount()).toBe(1);
    });

    it('1.2 Massive concurrency storm (10 simultaneous requests): exactly 1 commits, 9 recover cleanly, 0 uncaught errors', async () => {
      let executionCount = 0;
      const sharedResult = { order_id: 'ord-999', total: 500000 };
      const sharedState = {
        request: { id: '999', status: 'confirmed', version: 5, cancelled_at: null },
      };

      const executeFn = async (_tx: TransactionContext) => {
        executionCount++;
        return { result: sharedResult, currentState: sharedState };
      };

      const requests = Array.from({ length: 10 }, (_, i) => {
        return service.executeWithIdempotency({
          accountId: '10',
          action: 'confirm_delivery',
          objectType: 'Allocation',
          objectId: '999',
          idempotencyKey: KEY_UUID,
          payload: { ...BASE_PAYLOAD, requestIndex: 'same-canonical' },
          execute: executeFn,
          getCurrentState: async () => sharedState,
        });
      });

      const outcomes = await Promise.all(requests);

      const initialCount = outcomes.filter((o) => !o.replayed).length;
      const replayedCount = outcomes.filter((o) => o.replayed).length;

      expect(initialCount).toBe(1);
      expect(replayedCount).toBe(9);
      expect(harness.getCommittedCount()).toBe(1);

      // All 10 returned identical data
      for (const outcome of outcomes) {
        expect(outcome.data).toEqual(sharedResult);
        expect(outcome.currentState).toEqual(sharedState);
      }
    });

    it('1.3 P2002 error recognition: accepts PrismaClientKnownRequestError, plain Error with P2002 code, and unique constraint message', async () => {
      const p2002Variants = [
        new SimulatedPrismaP2002Error(),
        { code: 'P2002', message: 'Unique constraint violated' },
        new Error('Prisma error: P2002 unique constraint failed on field idempotency_key'),
        new Error('ERROR: duplicate key value violates unique constraint "idempotency_record_pkey"'),
      ];

      for (const errVariant of p2002Variants) {
        // Reset harness
        const testHarness = new ConcurrentTransactionalHarness();
        const testService = new TradingIdempotencyService(testHarness.repo, testHarness.txRunner);
        const committedRow: StoredRow = {
          id: '2001',
          idempotency_key: KEY_UUID,
          request_fingerprint: computeCanonicalFingerprint(BASE_PAYLOAD),
          account_id: '10',
          action: 'accept_quote',
          object_type: 'QuoteRequest',
          object_id: '100',
          result_snapshot: { status: 'won' },
          created_at: new Date(),
          expires_at: new Date(Date.now() + 86400000),
        };

        // Spy save to throw this error variant, while seedRow makes findAndVerifyReplay succeed
        vi.spyOn(testHarness.repo, 'save').mockRejectedValueOnce(errVariant);
        testHarness.seedRow(committedRow);

        const res = await testService.executeWithIdempotency({
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          idempotencyKey: KEY_UUID,
          payload: BASE_PAYLOAD,
          execute: vi.fn(),
          getCurrentState: async () => ({
            request: { id: '100', status: 'buyer_accepted', version: 2, cancelled_at: null },
          }),
        });

        expect(res.replayed).toBe(true);
        expect(res.data).toEqual({ status: 'won' });
      }
    });

    it('1.4 Non-P2002 database errors (e.g. connection timeout or foreign key P2003): strictly rethrown, not swallowed', async () => {
      const nonP2002Errors = [
        new Error('Connection to PostgreSQL terminated unexpectedly'),
        { code: 'P2003', message: 'Foreign key constraint failed on the field: `account_id`' },
        new TypeError('Cannot read property of undefined'),
      ];

      for (const error of nonP2002Errors) {
        vi.spyOn(harness.repo, 'save').mockRejectedValueOnce(error);

        await expect(
          service.executeWithIdempotency({
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            idempotencyKey: KEY_UUID,
            payload: BASE_PAYLOAD,
            execute: async () => ({
              result: { ok: true },
              currentState: { request: { id: '100', status: 'active', version: 1, cancelled_at: null } },
            }),
            getCurrentState: vi.fn(),
          }),
        ).rejects.toThrow(error as Error);
      }
    });
  });

  // ==========================================================================
  // CHALLENGE 2: Concurrent Mismatch (HTTP 409 IDEMPOTENCY_CONFLICT)
  // ==========================================================================
  describe('Challenge 2: Concurrent Mismatch & HTTP 409 IDEMPOTENCY_CONFLICT', () => {
    it('2.1 Two concurrent requests with same key but different payloads: second request receives IDEMPOTENCY_CONFLICT', async () => {
      const payloadA = { ...BASE_PAYLOAD, amount: 100 };
      const payloadB = { ...BASE_PAYLOAD, amount: 200 }; // Different amount!

      const reqA = service.executeWithIdempotency({
        accountId: '10',
        action: 'accept_quote',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: KEY_UUID,
        payload: payloadA,
        execute: async () => ({
          result: { quoteId: 'quote-42', amount: 100 },
          currentState: { request: { id: '100', status: 'accepted', version: 2, cancelled_at: null } },
        }),
        getCurrentState: async () => ({
          request: { id: '100', status: 'accepted', version: 2, cancelled_at: null },
        }),
      });

      const reqB = service.executeWithIdempotency({
        accountId: '10',
        action: 'accept_quote',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: KEY_UUID,
        payload: payloadB,
        execute: async () => ({
          result: { quoteId: 'quote-42', amount: 200 },
          currentState: { request: { id: '100', status: 'accepted', version: 2, cancelled_at: null } },
        }),
        getCurrentState: async () => ({
          request: { id: '100', status: 'accepted', version: 2, cancelled_at: null },
        }),
      });

      const settled = await Promise.allSettled([reqA, reqB]);

      const fulfilled = settled.find((s) => s.status === 'fulfilled') as
        | PromiseFulfilledResult<unknown>
        | undefined;
      const rejected = settled.find((s) => s.status === 'rejected') as
        | PromiseRejectedResult
        | undefined;

      expect(fulfilled).toBeDefined();
      expect(rejected).toBeDefined();

      const error = rejected?.reason;
      expect(error).toBeInstanceOf(IdempotencyConflictError);
      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(error.invariant).toBe(TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY);
    });

    it('2.2 Concurrent conflict when expected_*_version differs: triggers HTTP 409 IDEMPOTENCY_CONFLICT', async () => {
      const payloadV1 = { expected_request_version: 1, action: 'cancel' };
      const payloadV2 = { expected_request_version: 2, action: 'cancel' }; // Different version!

      // First request commits
      await service.executeWithIdempotency({
        accountId: '10',
        action: 'cancel',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: KEY_UUID,
        payload: payloadV1,
        execute: async () => ({
          result: { cancelled: true },
          currentState: { request: { id: '100', status: 'cancelled', version: 2, cancelled_at: new Date() } },
        }),
        getCurrentState: vi.fn(),
      });

      // Second request with same key but expected version 2
      const errorPromise = service.executeWithIdempotency({
        accountId: '10',
        action: 'cancel',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: KEY_UUID,
        payload: payloadV2,
        execute: vi.fn(),
        getCurrentState: vi.fn(),
      });

      await expect(errorPromise).rejects.toThrow(IdempotencyConflictError);

      try {
        await errorPromise;
      } catch (err: unknown) {
        const domainErr = err as IdempotencyConflictError;
        expect(domainErr.code).toBe('IDEMPOTENCY_CONFLICT');
        // Check HTTP contract mapping
        expect(statusByCode[domainErr.code]).toBe(409);
      }
    });

    it('2.3 RFC 9457 Problem Details schema contract: verifies IDEMPOTENCY_CONFLICT maps to status 409', () => {
      const err = new IdempotencyConflictError('Fingerprint mismatch');
      expect(err.code).toBe('IDEMPOTENCY_CONFLICT');
      const statusCode = (statusByCode as Record<string, number>)[err.code];
      expect(statusCode).toBe(409);

      const [defaultCode, title, detail] = (problems as Record<number, readonly [string, string, string]>)[409];
      expect(title).toBe('Xung đột dữ liệu');
      expect(statusCode).toBe(409);
    });
  });

  // ==========================================================================
  // CHALLENGE 3: Transaction Atomicity (No Persistence on Failure)
  // ==========================================================================
  describe('Challenge 3: Transaction Atomicity & Failure Rollback', () => {
    it('3.1 When execute(tx) throws an error, repository save is NEVER invoked', async () => {
      const saveSpy = vi.spyOn(harness.repo, 'save');
      const businessError = new InvalidTradingInputError('Fulfillment deadline cannot be in the past');

      await expect(
        service.executeWithIdempotency({
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          idempotencyKey: KEY_UUID,
          payload: BASE_PAYLOAD,
          execute: async () => {
            throw businessError;
          },
          getCurrentState: vi.fn(),
        }),
      ).rejects.toThrow(businessError);

      // Save was never called
      expect(saveSpy).not.toHaveBeenCalled();
      // No records in store
      expect(harness.getCommittedCount()).toBe(0);
    });

    it('3.2 After failed execute(tx), repeating request with same key and payload succeeds as a fresh execution', async () => {
      let callCount = 0;
      const failingExecute = async () => {
        callCount++;
        throw new Error('Database transaction deadlocked');
      };

      // First attempt fails
      await expect(
        service.executeWithIdempotency({
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          idempotencyKey: KEY_UUID,
          payload: BASE_PAYLOAD,
          execute: failingExecute,
          getCurrentState: vi.fn(),
        }),
      ).rejects.toThrow('Database transaction deadlocked');

      expect(callCount).toBe(1);
      expect(harness.getCommittedCount()).toBe(0);

      // Second attempt with the SAME key now succeeds
      const successfulExecute = vi.fn().mockResolvedValue({
        result: { quoteId: 'quote-42', accepted: true },
        currentState: { request: { id: '100', status: 'buyer_accepted', version: 2, cancelled_at: null } },
      });

      const res = await service.executeWithIdempotency({
        accountId: '10',
        action: 'accept_quote',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: KEY_UUID,
        payload: BASE_PAYLOAD,
        execute: successfulExecute,
        getCurrentState: vi.fn(),
      });

      expect(res.replayed).toBe(false);
      expect(res.data).toEqual({ quoteId: 'quote-42', accepted: true });
      expect(successfulExecute).toHaveBeenCalledTimes(1);
      expect(harness.getCommittedCount()).toBe(1);
    });

    it('3.3 Transaction rollback counter: verifies rollback is cleanly tracked and no ghost records remain', async () => {
      const initialRollbacks = harness.totalRollbacks;

      await expect(
        service.executeWithIdempotency({
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          idempotencyKey: KEY_UUID,
          payload: BASE_PAYLOAD,
          execute: async () => {
            throw new Error('Immediate rollback trigger');
          },
          getCurrentState: vi.fn(),
        }),
      ).rejects.toThrow('Immediate rollback trigger');

      expect(harness.totalRollbacks).toBeGreaterThan(initialRollbacks);
      expect(harness.getCommittedCount()).toBe(0);
    });
  });

  // ==========================================================================
  // CHALLENGE 4: Replay Idempotency (execute is Strictly NOT Called)
  // ==========================================================================
  describe('Challenge 4: Replay Idempotency & Execution Isolation', () => {
    it('4.1 Replay idempotency: execute(tx) is strictly NOT called on replay (0 calls)', async () => {
      const executeSpy = vi.fn().mockResolvedValue({
        result: { proposalId: 'prop-1', status: 'approved' },
        currentState: { request: { id: '100', status: 'in_production', version: 3, cancelled_at: null } },
      });

      const getCurrentStateSpy = vi.fn().mockResolvedValue({
        request: { id: '100', status: 'in_production', version: 3, cancelled_at: null },
      });

      const input: ExecuteWithIdempotencyInput<{ proposalId: string; status: string }> = {
        accountId: '10',
        action: 'accept_proposal',
        objectType: 'SplitProposal',
        objectId: '500',
        idempotencyKey: KEY_UUID,
        payload: BASE_PAYLOAD,
        execute: executeSpy,
        getCurrentState: getCurrentStateSpy,
      };

      // Initial execution
      const initialRes = await service.executeWithIdempotency(input);
      expect(initialRes.replayed).toBe(false);
      expect(executeSpy).toHaveBeenCalledTimes(1);

      // Reset execute spy count
      executeSpy.mockClear();

      // Send 3 consecutive replay requests
      for (let i = 1; i <= 3; i++) {
        const replayRes = await service.executeWithIdempotency(input);
        expect(replayRes.replayed).toBe(true);
        expect(replayRes.data).toEqual({ proposalId: 'prop-1', status: 'approved' });
        // execute(tx) MUST NEVER BE CALLED!
        expect(executeSpy).not.toHaveBeenCalled();
      }

      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it('4.2 Replay returns fresh current_state without requiring old version to be active', async () => {
      // Step 1: Initial commit when request version is 1
      await service.executeWithIdempotency({
        accountId: '10',
        action: 'accept_quote',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: KEY_UUID,
        payload: { expected_request_version: 1, quote_id: 'quote-42' },
        execute: async () => ({
          result: { allocation_id: 'alloc-1' },
          currentState: { request: { id: '100', status: 'buyer_accepted', version: 2, cancelled_at: null } },
        }),
        getCurrentState: vi.fn(),
      });

      // Step 2: Time passes, artisans start production, entity version drifts to 5
      const latestState: TradingCurrentStateDto = {
        request: { id: '100', status: 'in_production', version: 5, cancelled_at: null },
      };

      // Step 3: Replay request arrives with old version 1 in payload
      const replayRes = await service.executeWithIdempotency({
        accountId: '10',
        action: 'accept_quote',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: KEY_UUID,
        payload: { expected_request_version: 1, quote_id: 'quote-42' }, // Same original payload
        execute: vi.fn(), // Should not be called!
        getCurrentState: async () => latestState, // Returns fresh version 5!
      });

      expect(replayRes.replayed).toBe(true);
      expect(replayRes.data).toEqual({ allocation_id: 'alloc-1' });
      // Fresh state reflected in operation metadata
      expect(replayRes.operation.current_state).toEqual(latestState);
      expect((replayRes.operation.current_state.request as { version: number }).version).toBe(5);
    });
  });

  // ==========================================================================
  // CHALLENGE 5: 24-Hour TTL Cutoff Boundary in cleanupExpired()
  // ==========================================================================
  describe('Challenge 5: 24-Hour TTL Cutoff Boundary in cleanupExpired()', () => {
    const T0 = new Date('2026-11-10T12:00:00.000Z');
    const TTL_HOURS = 24;
    // Exactly 24 hours after T0
    const EXP_EXACT = new Date(T0.getTime() + TTL_HOURS * 60 * 60 * 1000); // 2026-11-11T12:00:00.000Z

    it('5.1 Mathematical cutoff boundary (before, at, after 24h): tests expires_at < cutoff', async () => {
      // Seed a record expiring at EXP_EXACT
      harness.seedRow({
        id: '2001',
        idempotency_key: KEY_UUID,
        request_fingerprint: 'abc',
        account_id: '10',
        action: 'accept_quote',
        object_type: 'QuoteRequest',
        object_id: '100',
        result_snapshot: { ok: true },
        created_at: T0,
        expires_at: EXP_EXACT,
      });

      expect(harness.getCommittedCount()).toBe(1);

      // Boundary 1: Cutoff is 1 millisecond BEFORE expiration (expires_at < cutoff is false)
      const cutoffBefore = new Date(EXP_EXACT.getTime() - 1);
      const deletedBefore = await service.cleanupExpired(cutoffBefore);
      expect(deletedBefore).toBe(0);
      expect(harness.getCommittedCount()).toBe(1);

      // Boundary 2: Cutoff is EXACTLY AT expiration timestamp (expires_at < cutoff is false, since equal)
      const cutoffAt = new Date(EXP_EXACT.getTime());
      const deletedAt = await service.cleanupExpired(cutoffAt);
      expect(deletedAt).toBe(0);
      expect(harness.getCommittedCount()).toBe(1);

      // Boundary 3: Cutoff is 1 millisecond AFTER expiration (expires_at < cutoff is true!)
      const cutoffAfter = new Date(EXP_EXACT.getTime() + 1);
      const deletedAfter = await service.cleanupExpired(cutoffAfter);
      expect(deletedAfter).toBe(1);
      expect(harness.getCommittedCount()).toBe(0);
    });

    it('5.2 Multi-record time-window cleanup: purges only records older than 24h, retains records within 24h', async () => {
      const now = new Date('2026-11-11T12:00:00.000Z');

      const records: StoredRow[] = [
        // Expired (older than 24h):
        {
          id: '1',
          idempotency_key: randomUUID(),
          request_fingerprint: 'fp-1',
          account_id: '10',
          action: 'accept',
          object_type: 'QuoteRequest',
          object_id: '1',
          result_snapshot: {},
          created_at: new Date(now.getTime() - 48 * 3600000),
          expires_at: new Date(now.getTime() - 24 * 3600000), // Expired 24h ago
        },
        {
          id: '2',
          idempotency_key: randomUUID(),
          request_fingerprint: 'fp-2',
          account_id: '10',
          action: 'accept',
          object_type: 'QuoteRequest',
          object_id: '2',
          result_snapshot: {},
          created_at: new Date(now.getTime() - 25 * 3600000),
          expires_at: new Date(now.getTime() - 1 * 3600000), // Expired 1h ago
        },
        {
          id: '3',
          idempotency_key: randomUUID(),
          request_fingerprint: 'fp-3',
          account_id: '10',
          action: 'accept',
          object_type: 'QuoteRequest',
          object_id: '3',
          result_snapshot: {},
          created_at: new Date(now.getTime() - 24 * 3600000 - 1000),
          expires_at: new Date(now.getTime() - 1000), // Expired 1 second ago
        },

        // Active (within 24h window):
        {
          id: '4',
          idempotency_key: randomUUID(),
          request_fingerprint: 'fp-4',
          account_id: '10',
          action: 'accept',
          object_type: 'QuoteRequest',
          object_id: '4',
          result_snapshot: {},
          created_at: new Date(now.getTime() - 24 * 3600000),
          expires_at: now, // Boundary (expires at now, expires_at < now is false)
        },
        {
          id: '5',
          idempotency_key: randomUUID(),
          request_fingerprint: 'fp-5',
          account_id: '10',
          action: 'accept',
          object_type: 'QuoteRequest',
          object_id: '5',
          result_snapshot: {},
          created_at: new Date(now.getTime() - 12 * 3600000),
          expires_at: new Date(now.getTime() + 12 * 3600000), // Active for 12 more hours
        },
        {
          id: '6',
          idempotency_key: randomUUID(),
          request_fingerprint: 'fp-6',
          account_id: '10',
          action: 'accept',
          object_type: 'QuoteRequest',
          object_id: '6',
          result_snapshot: {},
          created_at: now,
          expires_at: new Date(now.getTime() + 24 * 3600000), // Active for 24 hours
        },
      ];

      for (const rec of records) {
        harness.seedRow(rec);
      }

      expect(harness.getCommittedCount()).toBe(6);

      // Run cleanup with cutoff = now
      const deletedCount = await service.cleanupExpired(now);

      // Exactly 3 expired records removed
      expect(deletedCount).toBe(3);
      expect(harness.getCommittedCount()).toBe(3);

      // Active records (4, 5, 6) must still be present
      expect(harness.getCommittedRow({
        account_id: '10',
        action: 'accept',
        object_type: 'QuoteRequest',
        object_id: '4',
        idempotency_key: records[3].idempotency_key,
      })).toBeDefined();

      expect(harness.getCommittedRow({
        account_id: '10',
        action: 'accept',
        object_type: 'QuoteRequest',
        object_id: '5',
        idempotency_key: records[4].idempotency_key,
      })).toBeDefined();

      expect(harness.getCommittedRow({
        account_id: '10',
        action: 'accept',
        object_type: 'QuoteRequest',
        object_id: '6',
        idempotency_key: records[5].idempotency_key,
      })).toBeDefined();
    });

    it('5.3 Default cutoff behavior: when no cutoff parameter is provided, defaults to current time', async () => {
      const pastExpired = new Date(Date.now() - 10000); // 10s ago

      harness.seedRow({
        id: '99',
        idempotency_key: KEY_UUID,
        request_fingerprint: 'fp-99',
        account_id: '10',
        action: 'accept',
        object_type: 'QuoteRequest',
        object_id: '99',
        result_snapshot: {},
        created_at: new Date(Date.now() - 86400000 - 10000),
        expires_at: pastExpired,
      });

      expect(harness.getCommittedCount()).toBe(1);

      // Call cleanup without argument
      const deleted = await service.cleanupExpired();
      expect(deleted).toBe(1);
      expect(harness.getCommittedCount()).toBe(0);
    });
  });
});
