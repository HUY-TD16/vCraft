import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { firstValueFrom, of } from 'rxjs';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext, CallHandler } from '@nestjs/common';
import type { Request, Response } from 'express';

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
import type {
  IIdempotencyRecordRepository,
  IQuoteRequestRepository,
  IRequestRecipientRepository,
  IAllocationRepository,
  IQuoteRepository,
  ISplitProposalRepository,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import {
  ConcurrencyConflictError,
  IdempotencyConflictError,
  InvalidTradingInputError,
  TRADING_INVARIANTS,
} from '../../../../src/modules/trading/domain';
import { TradingIdempotencyService } from '../../../../src/modules/trading/application/services/trading-idempotency.service';
import {
  TradingCurrentStateResolver,
} from '../../../../src/modules/trading/adapters/http/interceptors/trading-current-state.resolver';
import {
  TradingMutationInterceptor,
  TRADING_MUTATION_METADATA_KEY,
  type TradingMutationOptions,
} from '../../../../src/modules/trading/adapters/http/interceptors/trading-mutation.interceptor';
import { authenticatedActors } from '../../../../src/common/security/guards/authenticated-request';
import type { AuthenticatedActor } from '../../../../src/common/application/types/contract-types';
import { HttpResult } from '../../../../src/common/http/interceptors/response-envelope.interceptor';

// ============================================================================
// Specialized In-Memory Harness with True Concurrency & Rollback Emulation
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

interface StoredIdempotencyRow<T = unknown> {
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

interface StoredQuoteRequest {
  id: string;
  status: string;
  version: number;
  cancelled_at: Date | null;
}

interface StoredRecipient {
  id: string;
  request_id: string;
  workshop_id: string;
  response_status: string;
  version: number;
}

class AdversarialStressHarness {
  public readonly idempotencyStore = new Map<string, StoredIdempotencyRow>();
  public readonly quoteRequestStore = new Map<string, StoredQuoteRequest>();
  public readonly recipientStore = new Map<string, StoredRecipient>();

  public totalExecutions = 0;
  public totalSaves = 0;
  public totalRollbacks = 0;
  private nextId = 9000n;

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
      const stagedIdempotency = new Map<string, StoredIdempotencyRow>();
      const stagedRequests = new Map<string, StoredQuoteRequest>();
      const stagedRecipients = new Map<string, StoredRecipient>();

      const txCtx = {
        stagedIdempotency,
        stagedRequests,
        stagedRecipients,
      } as unknown as TransactionContext;

      try {
        const result = await work(txCtx);

        // Commit phase: check for concurrent conflict
        for (const [key, row] of stagedIdempotency.entries()) {
          if (this.idempotencyStore.has(key)) {
            throw new SimulatedPrismaP2002Error();
          }
          this.idempotencyStore.set(key, row);
        }
        for (const [id, req] of stagedRequests.entries()) {
          this.quoteRequestStore.set(id, req);
        }
        for (const [id, rec] of stagedRecipients.entries()) {
          this.recipientStore.set(id, rec);
        }

        return result;
      } catch (err) {
        this.totalRollbacks++;
        stagedIdempotency.clear();
        stagedRequests.clear();
        stagedRecipients.clear();
        throw err;
      }
    },
  };

  readonly idempotencyRepo: IIdempotencyRecordRepository = {
    findByScope: async <TSnapshot = unknown>(
      scope: IdempotencyScopeKey,
      _tx: TransactionContext,
    ): Promise<PersistedIdempotencyRecord<TSnapshot> | null> => {
      const key = this.makeScopeKey(scope);
      const row = this.idempotencyStore.get(key);
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
    ): Promise<PersistedIdempotencyRecord<TSnapshot> | null> => {
      const record = await this.idempotencyRepo.findByScope<TSnapshot>(input, tx);
      if (!record || record.request_fingerprint !== input.request_fingerprint) {
        return null;
      }
      return record;
    },

    save: async <TSnapshot = unknown>(
      input: CreateIdempotencyRecordInput<TSnapshot>,
      tx: TransactionContext,
    ): Promise<PersistedIdempotencyRecord<TSnapshot>> => {
      this.totalSaves++;
      const key = this.makeScopeKey(input);
      if (this.idempotencyStore.has(key)) {
        throw new SimulatedPrismaP2002Error();
      }

      const id = String(this.nextId++);
      const row: StoredIdempotencyRow = {
        id,
        idempotency_key: input.idempotency_key,
        request_fingerprint: input.request_fingerprint,
        account_id: input.account_id,
        action: input.action,
        object_type: input.object_type,
        object_id: input.object_id,
        result_snapshot: input.result_snapshot,
        created_at: new Date(),
        expires_at: new Date(Date.now() + 86400000),
      };

      const staged = (tx as any)?.stagedIdempotency as Map<string, StoredIdempotencyRow> | undefined;
      if (staged) {
        staged.set(key, row);
      } else {
        this.idempotencyStore.set(key, row);
      }

      return {
        ...row,
        result_snapshot: input.result_snapshot,
      };
    },

    deleteExpiredBefore: async (cutoff: Date): Promise<number> => {
      let count = 0;
      for (const [key, row] of this.idempotencyStore.entries()) {
        if (row.expires_at < cutoff) {
          this.idempotencyStore.delete(key);
          count++;
        }
      }
      return count;
    },
  };

  readonly quoteRequestRepo: IQuoteRequestRepository = {
    findById: async (id: string, _tx: TransactionContext) => {
      const item = this.quoteRequestStore.get(id);
      return item ? ({ ...item } as any) : null;
    },
    save: async (request: any, tx: TransactionContext) => {
      const staged = (tx as any)?.stagedRequests as Map<string, StoredQuoteRequest> | undefined;
      const data = {
        id: request.id,
        status: request.status,
        version: request.version,
        cancelled_at: request.cancelled_at ?? null,
      };
      if (staged) staged.set(request.id, data);
      else this.quoteRequestStore.set(request.id, data);
      return request;
    },
  } as unknown as IQuoteRequestRepository;

  readonly recipientRepo: IRequestRecipientRepository = {
    findById: async (id: string, _tx: TransactionContext) => {
      const item = this.recipientStore.get(id);
      return item ? ({ ...item } as any) : null;
    },
    save: async (rec: any, tx: TransactionContext) => {
      const staged = (tx as any)?.stagedRecipients as Map<string, StoredRecipient> | undefined;
      const data = {
        id: rec.id,
        request_id: rec.request_id,
        workshop_id: rec.workshop_id,
        response_status: rec.response_status,
        version: rec.version,
      };
      if (staged) staged.set(rec.id, data);
      else this.recipientStore.set(rec.id, data);
      return rec;
    },
  } as unknown as IRequestRecipientRepository;

  readonly allocationRepo = { findById: vi.fn() } as unknown as IAllocationRepository;
  readonly quoteRepo = { findById: vi.fn() } as unknown as IQuoteRepository;
  readonly proposalRepo = { findById: vi.fn() } as unknown as ISplitProposalRepository;
}

function buildMockExecutionContext(options: {
  headers: Record<string, string>;
  body: Record<string, unknown>;
  params?: Record<string, string>;
  actor: AuthenticatedActor;
  mutationOptions: TradingMutationOptions;
  reflector: Reflector;
}): { context: ExecutionContext; req: Request; res: Response } {
  const req: any = {
    headers: { ...options.headers },
    body: { ...options.body },
    params: { ...(options.params ?? { id: String(options.body.id ?? '100') }) },
    user: options.actor,
    get(name: string) {
      return this.headers[name.toLowerCase()];
    },
  };

  authenticatedActors.set(req, options.actor);

  const res: any = {
    statusCode: 200,
    headersSent: false,
    setHeader: vi.fn(),
    status: vi.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn().mockReturnThis(),
  };

  const handler = function mockHandler() {};
  const controllerClass = class MockController {};

  if (options.reflector) {
    vi.spyOn(options.reflector, 'getAllAndOverride').mockReturnValue(options.mutationOptions);
  } else {
    vi.spyOn(Reflector.prototype, 'getAllAndOverride').mockReturnValue(options.mutationOptions);
  }

  const context: ExecutionContext = {
    switchToHttp: () => ({
      getRequest: () => req as Request,
      getResponse: () => res as Response,
      getNext: () => vi.fn(),
    }),
    getHandler: () => handler,
    getClass: () => controllerClass as any,
    getArgs: () => [req, res] as any,
    getArgByIndex: (idx: number) => (idx === 0 ? req : res),
    getType: () => 'http' as any,
    switchToRpc: () => ({} as any),
    switchToWs: () => ({} as any),
  };

  return { context, req, res };
}

// ============================================================================
// EMPIRICAL ADVERSARIAL STRESS TEST SUITE
// ============================================================================

describe('Adversarial Verification & Stress Testing (Milestone 3 Challenger)', () => {
  let harness: AdversarialStressHarness;
  let idempotencyService: TradingIdempotencyService;
  let stateResolver: TradingCurrentStateResolver;
  let reflector: Reflector;
  let interceptor: TradingMutationInterceptor;

  beforeEach(() => {
    harness = new AdversarialStressHarness();
    idempotencyService = new TradingIdempotencyService(
      harness.idempotencyRepo,
      harness.txRunner,
    );
    stateResolver = new TradingCurrentStateResolver(
      harness.quoteRequestRepo,
      harness.allocationRepo,
      harness.quoteRepo,
      harness.proposalRepo,
      harness.recipientRepo,
    );
    reflector = new Reflector();
    interceptor = new TradingMutationInterceptor(
      reflector,
      idempotencyService,
      stateResolver,
    );
  });

  // ==========================================================================
  // CHALLENGE 1: RequestRecipient Replay Behavior with Fresh Current State
  // ==========================================================================
  describe('Challenge Area 1: RequestRecipient Replay Behavior with Fresh Current State', () => {
    it('1.1 Replay returns fresh mutated RequestRecipient and QuoteRequest state when entity evolved after original commit', async () => {
      const KEY = randomUUID();
      const RECIPIENT_ID = '1001';
      const REQUEST_ID = '5001';
      const ARTISAN_ACCOUNT = '201';

      // 1. Initial State in DB:
      // Request is 'sent_to_artisans' at version 1
      // Recipient is 'pending' at version 1
      harness.quoteRequestStore.set(REQUEST_ID, {
        id: REQUEST_ID,
        status: 'sent_to_artisans',
        version: 1,
        cancelled_at: null,
      });
      harness.recipientStore.set(RECIPIENT_ID, {
        id: RECIPIENT_ID,
        request_id: REQUEST_ID,
        workshop_id: 'ws-201',
        response_status: 'pending',
        version: 1,
      });

      const actor: AuthenticatedActor = {
        accountId: ARTISAN_ACCOUNT,
        role: 'artisan',
        sessionId: 'sess-artisan',
      };

      const declinePayload = {
        expected_recipient_version: 1,
        reason: 'Xưởng hiện đã kín lịch nung',
      };

      // 2. Initial Decline Mutation:
      const { context: ctx1 } = buildMockExecutionContext({
        headers: { 'x-idempotency-key': KEY },
        body: declinePayload,
        params: { id: RECIPIENT_ID },
        actor,
        reflector,
        mutationOptions: {
          action: 'decline_invitation',
          objectType: 'RequestRecipient',
          expectedVersionField: 'expected_recipient_version',
        },
      });

      let executeInvocationCount = 0;
      const callHandler1: CallHandler = {
        handle: () => {
          executeInvocationCount++;
          // Simulate route handler updating recipient in DB
          harness.recipientStore.set(RECIPIENT_ID, {
            id: RECIPIENT_ID,
            request_id: REQUEST_ID,
            workshop_id: 'ws-201',
            response_status: 'declined',
            version: 2,
          });
          return of({
            recipient_id: RECIPIENT_ID,
            response_status: 'declined',
            version: 2,
          });
        },
      };

      const obs1 = await interceptor.intercept(ctx1, callHandler1);
      const res1 = (await firstValueFrom(obs1)) as HttpResult<any, TradingCurrentStateDto>;

      expect(executeInvocationCount).toBe(1);
      expect(res1.data).toEqual({
        recipient_id: RECIPIENT_ID,
        response_status: 'declined',
        version: 2,
      });
      expect(res1.metadata.operation?.replayed).toBe(false);
      expect(res1.metadata.operation?.current_state.recipient).toEqual({
        id: RECIPIENT_ID,
        status: 'declined',
        version: 2,
      });
      expect(res1.metadata.operation?.current_state.request).toEqual({
        id: REQUEST_ID,
        status: 'sent_to_artisans',
        version: 1,
        cancelled_at: null,
      });

      // 3. Independent Time Passes: Entity state evolves further in DB!
      // Parent QuoteRequest receives quotes from other artisans and moves to 'artisans_bidding' v4.
      // Recipient gets an administrative audit note or revision advancing to v3.
      harness.quoteRequestStore.set(REQUEST_ID, {
        id: REQUEST_ID,
        status: 'artisans_bidding',
        version: 4,
        cancelled_at: null,
      });
      harness.recipientStore.set(RECIPIENT_ID, {
        id: RECIPIENT_ID,
        request_id: REQUEST_ID,
        workshop_id: 'ws-201',
        response_status: 'declined',
        version: 3, // Further incremented
      });

      // 4. Replay Request arrives with SAME KEY and SAME PAYLOAD (expected_recipient_version: 1)
      const { context: ctx2 } = buildMockExecutionContext({
        headers: { 'x-idempotency-key': KEY },
        body: declinePayload,
        params: { id: RECIPIENT_ID },
        actor,
        reflector,
        mutationOptions: {
          action: 'decline_invitation',
          objectType: 'RequestRecipient',
          expectedVersionField: 'expected_recipient_version',
        },
      });

      const callHandler2: CallHandler = {
        handle: () => {
          executeInvocationCount++;
          throw new Error('Business execute handler MUST NOT be called on replay!');
        },
      };

      const obs2 = await interceptor.intercept(ctx2, callHandler2);
      const res2 = (await firstValueFrom(obs2)) as HttpResult<any, TradingCurrentStateDto>;

      // Empirical assertions:
      // A) Business handler was strictly NOT executed again
      expect(executeInvocationCount).toBe(1);

      // B) Replayed flag is true, operation ID and original snapshot data are preserved
      expect(res2.metadata.operation?.replayed).toBe(true);
      expect(res2.metadata.operation?.id).toBe(res1.metadata.operation?.id);
      expect(res2.data).toEqual(res1.data);

      // C) operation.current_state contains the FRESH current state of RequestRecipient and QuoteRequest!
      expect(res2.metadata.operation?.current_state.recipient).toEqual({
        id: RECIPIENT_ID,
        status: 'declined',
        version: 3, // Fresh current version, not old version 2!
      });
      expect(res2.metadata.operation?.current_state.request).toEqual({
        id: REQUEST_ID,
        status: 'artisans_bidding', // Fresh current parent status!
        version: 4, // Fresh current parent version!
        cancelled_at: null,
      });
    });
  });

  // ==========================================================================
  // CHALLENGE 2: Idempotency Key Replay Under Race Conditions
  // ==========================================================================
  describe('Challenge Area 2: Idempotency Key Replay Under Race Conditions', () => {
    it('2.1 High-concurrency race: 20 simultaneous requests with same key & payload result in exactly 1 commit and 19 clean P2002 replays', async () => {
      const KEY = randomUUID();
      const OBJECT_ID = '2002';
      const REQUEST_ID = '6002';
      const ACTOR_ACCOUNT = '77';

      harness.quoteRequestStore.set(REQUEST_ID, {
        id: REQUEST_ID,
        status: 'sent_to_artisans',
        version: 1,
        cancelled_at: null,
      });
      harness.recipientStore.set(OBJECT_ID, {
        id: OBJECT_ID,
        request_id: REQUEST_ID,
        workshop_id: 'ws-77',
        response_status: 'pending',
        version: 1,
      });

      const actor: AuthenticatedActor = {
        accountId: ACTOR_ACCOUNT,
        role: 'artisan',
        sessionId: 'sess-77',
      };

      const payload = {
        expected_recipient_version: 1,
        reason: 'Quá tải sản xuất',
      };

      let executionCount = 0;

      // Dispatch 20 concurrent requests simultaneously
      const concurrencyLevel = 20;
      const tasks = Array.from({ length: concurrencyLevel }, (_, idx) => {
        const localReflector = new Reflector();
        const localInterceptor = new TradingMutationInterceptor(
          localReflector,
          idempotencyService,
          stateResolver,
        );

        const { context: ctx } = buildMockExecutionContext({
          headers: { 'x-idempotency-key': KEY },
          body: { ...payload },
          params: { id: OBJECT_ID },
          actor,
          reflector: localReflector,
          mutationOptions: {
            action: 'decline_invitation',
            objectType: 'RequestRecipient',
            expectedVersionField: 'expected_recipient_version',
          },
        });

        const callHandler: CallHandler = {
          handle: () => {
            executionCount++;
            return of({
              accepted: false,
              declineIndex: idx,
            });
          },
        };

        return localInterceptor.intercept(ctx, callHandler).then((obs) => firstValueFrom(obs));
      });

      const results = (await Promise.all(tasks)) as HttpResult<any, TradingCurrentStateDto>[];

      // Verification:
      expect(results).toHaveLength(20);

      const initialResults = results.filter((r) => !r.metadata.operation?.replayed);
      const replayedResults = results.filter((r) => r.metadata.operation?.replayed);

      // Exactly 1 initial request succeeded in saving the record
      expect(initialResults).toHaveLength(1);
      // Exactly 19 requests hit concurrent conflict and cleanly replayed
      expect(replayedResults).toHaveLength(19);

      // All 20 requests received the SAME operation ID and consistent data
      const winningOpId = initialResults[0].metadata.operation?.id;
      for (const res of results) {
        expect(res.metadata.operation?.id).toBe(winningOpId);
        expect(res.data).toEqual(initialResults[0].data);
      }

      // Exactly 1 record committed to persistence store
      expect(harness.idempotencyStore.size).toBe(1);
    });

    it('2.2 Race condition with conflicting payloads: winning request commits, conflicting concurrent requests receive HTTP 409 IDEMPOTENCY_CONFLICT', async () => {
      const KEY = randomUUID();
      const OBJECT_ID = '2003';
      const REQUEST_ID = '6003';
      const ACTOR_ACCOUNT = '88';

      harness.quoteRequestStore.set(REQUEST_ID, {
        id: REQUEST_ID,
        status: 'sent_to_artisans',
        version: 1,
        cancelled_at: null,
      });
      harness.recipientStore.set(OBJECT_ID, {
        id: OBJECT_ID,
        request_id: REQUEST_ID,
        workshop_id: 'ws-88',
        response_status: 'pending',
        version: 1,
      });

      const actor: AuthenticatedActor = {
        accountId: ACTOR_ACCOUNT,
        role: 'artisan',
        sessionId: 'sess-88',
      };

      // 3 requests with Payload A and 3 requests with Payload B
      const payloadA = { expected_recipient_version: 1, reason: 'Lý do A' };
      const payloadB = { expected_recipient_version: 1, reason: 'Lý do B (Khác biệt!)' };

      const createPromise = (body: Record<string, unknown>, label: string) => {
        const localReflector = new Reflector();
        const localInterceptor = new TradingMutationInterceptor(
          localReflector,
          idempotencyService,
          stateResolver,
        );

        const { context: ctx } = buildMockExecutionContext({
          headers: { 'x-idempotency-key': KEY },
          body,
          params: { id: OBJECT_ID },
          actor,
          reflector: localReflector,
          mutationOptions: {
            action: 'decline_invitation',
            objectType: 'RequestRecipient',
            expectedVersionField: 'expected_recipient_version',
          },
        });

        const callHandler: CallHandler = {
          handle: () => of({ outcome: label }),
        };

        return localInterceptor.intercept(ctx, callHandler).then((obs) => firstValueFrom(obs));
      };

      // Interleave A and B requests in parallel
      const mixedTasks = [
        createPromise(payloadA, 'A1'),
        createPromise(payloadB, 'B1'),
        createPromise(payloadA, 'A2'),
        createPromise(payloadB, 'B2'),
        createPromise(payloadA, 'A3'),
        createPromise(payloadB, 'B3'),
      ];

      const settled = await Promise.allSettled(mixedTasks);

      const fulfilled = settled.filter((s) => s.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const rejected = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];

      // There must be fulfilled results and rejected results
      expect(fulfilled.length).toBeGreaterThan(0);
      expect(rejected.length).toBeGreaterThan(0);
      expect(fulfilled.length + rejected.length).toBe(6);

      // All rejected requests must strictly fail with IdempotencyConflictError (HTTP 409)
      for (const rej of rejected) {
        expect(rej.reason).toBeInstanceOf(IdempotencyConflictError);
        expect((rej.reason as IdempotencyConflictError).code).toBe('IDEMPOTENCY_CONFLICT');
      }

      // Store must hold exactly 1 committed record
      expect(harness.idempotencyStore.size).toBe(1);
    });
  });

  // ==========================================================================
  // CHALLENGE 3: Version Mismatch Rollback Without Corrupting Entity State
  // ==========================================================================
  describe('Challenge Area 3: Version Mismatch Rollback Without Corrupting Entity State', () => {
    it('3.1 Version mismatch rejects with HTTP 409 CONCURRENCY_CONFLICT, completely rolls back, leaves entity intact, and leaves 0 idempotency records', async () => {
      const KEY = randomUUID();
      const REQUEST_ID = '7001';
      const BUYER_ACCOUNT = '55';

      // Entity current state in DB has version 3
      const pristineEntity: StoredQuoteRequest = {
        id: REQUEST_ID,
        status: 'artisans_bidding',
        version: 3,
        cancelled_at: null,
      };
      harness.quoteRequestStore.set(REQUEST_ID, { ...pristineEntity });

      const actor: AuthenticatedActor = {
        accountId: BUYER_ACCOUNT,
        role: 'buyer',
        sessionId: 'sess-buyer-55',
      };

      // Client sends a stale expected version: 1 (actual is 3)
      const stalePayload = {
        expected_request_version: 1,
        cancel_reason: 'Thay đổi kế hoạch kinh doanh',
      };

      const { context: ctx } = buildMockExecutionContext({
        headers: { 'x-idempotency-key': KEY },
        body: stalePayload,
        params: { id: REQUEST_ID },
        actor,
        reflector,
        mutationOptions: {
          action: 'cancel_request',
          objectType: 'QuoteRequest',
          expectedVersionField: 'expected_request_version',
        },
      });

      let mutationExecuted = false;
      const callHandler: CallHandler = {
        handle: () => {
          mutationExecuted = true;
          const current = harness.quoteRequestStore.get(REQUEST_ID)!;

          // Optimistic Concurrency Check inside business handler
          if (stalePayload.expected_request_version !== current.version) {
            throw new ConcurrencyConflictError(
              `QuoteRequest ${REQUEST_ID} version mismatch: expected ${stalePayload.expected_request_version}, found ${current.version}`,
              { invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY },
            );
          }

          // If it didn't throw, it would mutate:
          harness.quoteRequestStore.set(REQUEST_ID, {
            ...current,
            status: 'cancelled',
            version: current.version + 1,
          });

          return of({ cancelled: true });
        },
      };

      // Execute request expecting ConcurrencyConflictError
      await expect(
        interceptor.intercept(ctx, callHandler).then((obs) => firstValueFrom(obs)),
      ).rejects.toThrow(ConcurrencyConflictError);

      expect(mutationExecuted).toBe(true);

      // Verify DB entity state remains 100% PRISTINE (NOT cancelled, version NOT modified)
      const entityAfterMismatch = harness.quoteRequestStore.get(REQUEST_ID);
      expect(entityAfterMismatch).toEqual(pristineEntity);
      expect(entityAfterMismatch?.status).toBe('artisans_bidding');
      expect(entityAfterMismatch?.version).toBe(3);

      // Verify transaction rollback occurred and NO IdempotencyRecord was persisted
      expect(harness.totalRollbacks).toBeGreaterThan(0);
      expect(harness.idempotencyStore.size).toBe(0);

      // Verify that after resolving the conflict, the client can retry with the SAME idempotency key and CORRECT version 3
      const correctPayload = {
        expected_request_version: 3,
        cancel_reason: 'Thay đổi kế hoạch kinh doanh',
      };

      const { context: retryCtx } = buildMockExecutionContext({
        headers: { 'x-idempotency-key': KEY }, // Same idempotency key!
        body: correctPayload,
        params: { id: REQUEST_ID },
        actor,
        reflector,
        mutationOptions: {
          action: 'cancel_request',
          objectType: 'QuoteRequest',
          expectedVersionField: 'expected_request_version',
        },
      });

      const retryCallHandler: CallHandler = {
        handle: () => {
          const current = harness.quoteRequestStore.get(REQUEST_ID)!;
          if (correctPayload.expected_request_version !== current.version) {
            throw new ConcurrencyConflictError('Mismatch');
          }
          const updated = {
            ...current,
            status: 'cancelled',
            version: current.version + 1,
          };
          harness.quoteRequestStore.set(REQUEST_ID, updated);
          return of({ cancelled: true, newVersion: updated.version });
        },
      };

      const retryObs = await interceptor.intercept(retryCtx, retryCallHandler);
      const retryRes = (await firstValueFrom(retryObs)) as HttpResult<any, TradingCurrentStateDto>;

      // Successful retry:
      expect(retryRes.metadata.operation?.replayed).toBe(false);
      expect(retryRes.data).toEqual({ cancelled: true, newVersion: 4 });
      expect(harness.idempotencyStore.size).toBe(1);

      // And entity in DB is now properly updated
      expect(harness.quoteRequestStore.get(REQUEST_ID)?.version).toBe(4);
      expect(harness.quoteRequestStore.get(REQUEST_ID)?.status).toBe('cancelled');
    });

    it('3.2 Pre-validation rejects non-positive or malformed expected version before any transaction or entity touch', async () => {
      const KEY = randomUUID();
      const REQUEST_ID = '7002';
      const ACTOR_ACCOUNT = '55';

      const initialEntity: StoredQuoteRequest = {
        id: REQUEST_ID,
        status: 'draft_request',
        version: 1,
        cancelled_at: null,
      };
      harness.quoteRequestStore.set(REQUEST_ID, { ...initialEntity });

      const actor: AuthenticatedActor = {
        accountId: ACTOR_ACCOUNT,
        role: 'buyer',
        sessionId: 'sess-buyer-55',
      };

      const badVersions = [0, -1, 1.5, NaN, 'one', true, {}];

      for (const badVer of badVersions) {
        const { context: ctx } = buildMockExecutionContext({
          headers: { 'x-idempotency-key': KEY },
          body: { expected_request_version: badVer },
          params: { id: REQUEST_ID },
          actor,
          reflector,
          mutationOptions: {
            action: 'submit_request',
            objectType: 'QuoteRequest',
            expectedVersionField: 'expected_request_version',
          },
        });

        const callHandler: CallHandler = {
          handle: () => {
            throw new Error('CallHandler must NOT be reached for invalid expected version!');
          },
        };

        await expect(
          interceptor.intercept(ctx, callHandler).then((obs) => firstValueFrom(obs)),
        ).rejects.toThrow(InvalidTradingInputError);
      }

      // Entity remains untouched
      expect(harness.quoteRequestStore.get(REQUEST_ID)).toEqual(initialEntity);
      expect(harness.idempotencyStore.size).toBe(0);
    });
  });
});
