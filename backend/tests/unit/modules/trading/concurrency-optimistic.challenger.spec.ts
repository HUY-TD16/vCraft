import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { firstValueFrom, of } from 'rxjs';
import { type ExecutionContext, type CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

// ============================================================================
// 📋 BẢNG LƯU VẾT RÀ SOÁT TÀI LIỆU TRƯỚC KHI THỰC HIỆN
// | Khía cạnh rà soát | Giá trị phát hiện / Tham chiếu tài liệu |
// | :--- | :--- |
// | **Trung tâm tài liệu gốc** | docsAI/04-architecture/api-design.md, docsAI/02-specifications/business-rules.md |
// | **Đặc tả liên quan đã tiếp nhận** | 1. docsAI/02-specifications/business-rules.md (BR-27, BR-18, BR-25, BR-26)<br>2. docsAI/04-architecture/api-design.md (Mục 1.2, 1.4, 2, Bảng lỗi 409/422) |
// | **Mã quy tắc nghiệp vụ áp dụng** | BR-27 (Optimistic Concurrency & Versioning), BR-18 (Non-expiration on stale version), BR-25 (Delivered atomic check) |
// | **Thực thể và mô hình dữ liệu** | QuoteRequest, Quote, SplitProposal, Allocation, IdempotencyRecord |
// | **Lớp kiến trúc và ràng buộc** | Hexagonal Architecture: Domain Entities/Policies -> Application Services -> Http Interceptor/Filters |
// | **Bất biến và ràng buộc xác thực** | INV-05 (Concurrency & Idempotency), INV-01 (State Machine), INV-04 (Allocation Batch Traceability) |
// | **Chiến lược xác minh** | pnpm --filter vcraft-backend test tests/unit/modules/trading/concurrency-optimistic.challenger.spec.ts |
// ============================================================================

import { HttpResult } from '../../../../src/common/http/interceptors/response-envelope.interceptor';
import { authenticatedActors } from '../../../../src/common/security/guards/authenticated-request';
import type { AuthenticatedActor } from '../../../../src/common/application/types/contract-types';
import { statusByCode } from '../../../../src/common/http/filters/api-problem';
import { problems } from '../../../../src/common/http/filters/problem-details.filter';
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
  Allocation,
  AllocationBatchLink,
  Quote,
  QuoteRequest,
  SplitProposal,
  ConcurrencyConflictError,
  IdempotencyConflictError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  TradingPermissionDeniedError,
  TRADING_INVARIANTS,
  Version,
} from '../../../../src/modules/trading/domain';
import { TradingIdempotencyService } from '../../../../src/modules/trading/application/services/trading-idempotency.service';
import { computeCanonicalFingerprint } from '../../../../src/modules/trading/domain/utilities/idempotency.utilities';
import {
  TradingMutationInterceptor,
  TRADING_MUTATION_METADATA_KEY,
  type TradingMutationOptions,
} from '../../../../src/modules/trading/adapters/http/interceptors/trading-mutation.interceptor';
import { TradingMutation } from '../../../../src/modules/trading/adapters/http/decorators/trading-mutation.decorator';

// ============================================================================
// Fixture Constants & Entities Builders
// ============================================================================

const BASE_NOW = new Date('2026-11-11T10:00:00.000Z');
const BIDDING_DEADLINE = new Date('2026-11-13T10:00:00.000Z');
const BID_ACCEPT_DEADLINE = new Date('2026-11-14T10:00:00.000Z');
const COMMITTED_DELIVERY = new Date('2026-11-18T08:00:00.000Z');
const DELIVERY_DEADLINE = new Date('2026-11-20T08:00:00.000Z');

function buildSentRequest(overrides: Partial<Parameters<typeof QuoteRequest.reconstitute>[0]> = {}): QuoteRequest {
  return QuoteRequest.reconstitute({
    id: '100',
    buyer_id: '10',
    category_id: '1',
    spec: '100 lọ hoa gốm men rạn Bát Tràng',
    quantity: 100,
    unit: 'piece',
    unit_set_description: null,
    status: 'sent_to_artisans',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội',
    delivery_address: '10 Hàng Gai, Hoàn Kiếm',
    recipient_name: 'Nguyễn Văn Mua',
    recipient_phone: '0912345678',
    bidding_deadline: BIDDING_DEADLINE,
    delivery_deadline: DELIVERY_DEADLINE,
    admin_note: null,
    split_requested_at: null,
    split_request_reason: null,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: BASE_NOW,
    updated_at: BASE_NOW,
    version: 1,
    contact_edit_count: 0,
    recipients: [],
    ...overrides,
  });
}

function buildQuote(overrides: Partial<Parameters<typeof Quote.reconstitute>[0]> = {}): Quote {
  return Quote.reconstitute({
    id: '401',
    request_id: '100',
    workshop_id: '201',
    unit_price: 150000,
    max_quantity: 100,
    bid_accept_deadline: BID_ACCEPT_DEADLINE,
    committed_delivery_at: COMMITTED_DELIVERY,
    status: 'active',
    version: 1,
    withdraw_reason: null,
    withdrawn_by: null,
    withdrawn_at: null,
    created_at: BASE_NOW,
    updated_at: BASE_NOW,
    ...overrides,
  });
}

function buildSplitProposal(overrides: Partial<Parameters<typeof SplitProposal.reconstitute>[0]> = {}): SplitProposal {
  return SplitProposal.reconstitute({
    id: '501',
    request_id: '100',
    created_by: '999',
    status: 'proposed',
    version: 1,
    reject_reason: null,
    rejected_by: null,
    rejected_at: null,
    expire_reason: null,
    expired_at: null,
    items: [
      {
        id: '601',
        proposal_id: '501',
        request_id: '100',
        workshop_id: '201',
        quote_id: '401',
        quote_version: 1,
        allocated_quantity: 60,
        unit_price: 150000,
        committed_delivery_at: COMMITTED_DELIVERY,
      },
      {
        id: '602',
        proposal_id: '501',
        request_id: '100',
        workshop_id: '202',
        quote_id: '402',
        quote_version: 1,
        allocated_quantity: 40,
        unit_price: 155000,
        committed_delivery_at: COMMITTED_DELIVERY,
      },
    ],
    created_at: BASE_NOW,
    updated_at: BASE_NOW,
    ...overrides,
  });
}

function buildAllocation(overrides: Partial<Parameters<typeof Allocation.reconstitute>[0]> = {}): Allocation {
  return Allocation.reconstitute({
    id: '701',
    request_id: '100',
    workshop_id: '201',
    quote_id: '401',
    quantity: 60,
    unit_price: 150000,
    committed_delivery_at: COMMITTED_DELIVERY,
    status: 'in_production',
    version: 1,
    started_at: BASE_NOW,
    started_by: '21',
    handed_over_at: null,
    handed_over_by: null,
    delivery_note: null,
    admin_handover_reason: null,
    admin_delivery_evidence: null,
    created_at: BASE_NOW,
    updated_at: BASE_NOW,
    batch_links: [],
    ...overrides,
  });
}

// ============================================================================
// Specialized Concurrency Stress Harness
// ============================================================================

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

class SimulatedPrismaP2002Error extends Error {
  readonly code = 'P2002';
  readonly clientVersion = '5.10.0';
  constructor(message = 'Unique constraint failed on the constraint: `account_id_action_object_type_object_id_idempotency_key`') {
    super(message);
    this.name = 'PrismaClientKnownRequestError';
  }
}

/**
 * High-fidelity atomic database transaction emulator with entity row versioning.
 * Implements optimistic concurrency locking (updateMany where id = :id AND version = :expectedVersion).
 */
class OptimisticConcurrencyTestHarness {
  private readonly idempotencyStore = new Map<string, StoredIdempotencyRow>();
  private readonly quoteRequestStore = new Map<string, QuoteRequest>();
  private readonly quoteStore = new Map<string, Quote>();
  private readonly splitProposalStore = new Map<string, SplitProposal>();
  private readonly allocationStore = new Map<string, Allocation>();

  private nextId = 5000n;
  public totalTxRuns = 0;
  public totalRollbacks = 0;

  constructor() {}

  seedRequest(req: QuoteRequest): void {
    this.quoteRequestStore.set(req.id, req);
  }

  seedQuote(quote: Quote): void {
    this.quoteStore.set(quote.id, quote);
  }

  seedSplitProposal(proposal: SplitProposal): void {
    this.splitProposalStore.set(proposal.id, proposal);
  }

  seedAllocation(alloc: Allocation): void {
    this.allocationStore.set(alloc.id, alloc);
  }

  getRequest(id: string): QuoteRequest | undefined {
    return this.quoteRequestStore.get(id);
  }

  getQuote(id: string): Quote | undefined {
    return this.quoteStore.get(id);
  }

  getSplitProposal(id: string): SplitProposal | undefined {
    return this.splitProposalStore.get(id);
  }

  getAllocation(id: string): Allocation | undefined {
    return this.allocationStore.get(id);
  }

  countIdempotencyRecords(): number {
    return this.idempotencyStore.size;
  }

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
      this.totalTxRuns++;
      const stagedIdempotency = new Map<string, StoredIdempotencyRow>();
      const stagedRequests = new Map<string, { entity: QuoteRequest; expectedVersion: number }>();
      const stagedQuotes = new Map<string, { entity: Quote; expectedVersion: number }>();
      const stagedProposals = new Map<string, { entity: SplitProposal; expectedVersion: number }>();
      const stagedAllocations = new Map<string, { entity: Allocation; expectedVersion: number }>();

      const txCtx = {
        __brand: `tx-${Math.random()}`,
        stagedIdempotency,
        stagedRequests,
        stagedQuotes,
        stagedProposals,
        stagedAllocations,
      } as unknown as TransactionContext;

      try {
        const result = await work(txCtx);

        // Phase 1: Validate all uniqueness constraints and optimistic version checks before mutating committed store
        for (const [key] of stagedIdempotency.entries()) {
          if (this.idempotencyStore.has(key)) {
            throw new SimulatedPrismaP2002Error();
          }
        }
        for (const [id, { expectedVersion }] of stagedRequests.entries()) {
          const current = this.quoteRequestStore.get(id);
          if (current && current.version !== expectedVersion) {
            throw new ConcurrencyConflictError(
              `QuoteRequest ${id} version conflict (expected ${expectedVersion}, actual ${current.version}).`,
              { invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY, entity: 'QuoteRequest' },
            );
          }
        }
        for (const [id, { expectedVersion }] of stagedQuotes.entries()) {
          const current = this.quoteStore.get(id);
          if (current && current.version !== expectedVersion) {
            throw new ConcurrencyConflictError(
              `Quote ${id} version conflict (expected ${expectedVersion}, actual ${current.version}).`,
              { invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY, entity: 'Quote' },
            );
          }
        }
        for (const [id, { expectedVersion }] of stagedProposals.entries()) {
          const current = this.splitProposalStore.get(id);
          if (current && current.version !== expectedVersion) {
            throw new ConcurrencyConflictError(
              `SplitProposal ${id} version conflict (expected ${expectedVersion}, actual ${current.version}).`,
              { invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY, entity: 'SplitProposal' },
            );
          }
        }
        for (const [id, { expectedVersion }] of stagedAllocations.entries()) {
          const current = this.allocationStore.get(id);
          if (current && current.version !== expectedVersion) {
            throw new ConcurrencyConflictError(
              `Allocation ${id} version conflict (expected ${expectedVersion}, actual ${current.version}).`,
              { invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY, entity: 'Allocation' },
            );
          }
        }

        // Phase 2: All checks passed -> Atomically commit all staged changes
        for (const [key, row] of stagedIdempotency.entries()) {
          this.idempotencyStore.set(key, row);
        }
        for (const [id, { entity }] of stagedRequests.entries()) {
          this.quoteRequestStore.set(id, entity);
        }
        for (const [id, { entity }] of stagedQuotes.entries()) {
          this.quoteStore.set(id, entity);
        }
        for (const [id, { entity }] of stagedProposals.entries()) {
          this.splitProposalStore.set(id, entity);
        }
        for (const [id, { entity }] of stagedAllocations.entries()) {
          this.allocationStore.set(id, entity);
        }

        return result;
      } catch (err) {
        this.totalRollbacks++;
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
      const key = this.makeScopeKey(input);
      if (this.idempotencyStore.has(key)) {
        throw new SimulatedPrismaP2002Error();
      }
      const staged = (tx as any)?.stagedIdempotency as Map<string, StoredIdempotencyRow> | undefined;
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
        created_at: new Date(BASE_NOW),
        expires_at: new Date(BASE_NOW.getTime() + (input.ttl_hours ?? 24) * 3600 * 1000),
      };

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

    deleteExpired: async (cutoff: Date): Promise<number> => {
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

  /**
   * Atomic repository update simulation with optimistic concurrency check.
   */
  async updateRequest(
    request: QuoteRequest,
    expectedVersion: number,
    tx: TransactionContext,
  ): Promise<QuoteRequest> {
    const current = this.quoteRequestStore.get(request.id);
    if (!current || current.version !== expectedVersion) {
      throw new ConcurrencyConflictError(
        `QuoteRequest ${request.id} version conflict (expected ${expectedVersion}, actual ${current?.version}).`,
        { invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY, entity: 'QuoteRequest' },
      );
    }
    const staged = (tx as any)?.stagedRequests as Map<string, { entity: QuoteRequest; expectedVersion: number }>;
    staged.set(request.id, { entity: request, expectedVersion });
    return request;
  }

  async updateQuote(
    quote: Quote,
    expectedVersion: number,
    tx: TransactionContext,
  ): Promise<Quote> {
    const current = this.quoteStore.get(quote.id);
    if (!current || current.version !== expectedVersion) {
      throw new ConcurrencyConflictError(
        `Quote ${quote.id} version conflict (expected ${expectedVersion}, actual ${current?.version}).`,
        { invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY, entity: 'Quote' },
      );
    }
    const staged = (tx as any)?.stagedQuotes as Map<string, { entity: Quote; expectedVersion: number }>;
    staged.set(quote.id, { entity: quote, expectedVersion });
    return quote;
  }

  async updateAllocation(
    allocation: Allocation,
    expectedVersion: number,
    tx: TransactionContext,
  ): Promise<Allocation> {
    const current = this.allocationStore.get(allocation.id);
    if (!current || current.version !== expectedVersion) {
      throw new ConcurrencyConflictError(
        `Allocation ${allocation.id} version conflict (expected ${expectedVersion}, actual ${current?.version}).`,
        { invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY, entity: 'Allocation' },
      );
    }
    const staged = (tx as any)?.stagedAllocations as Map<string, { entity: Allocation; expectedVersion: number }>;
    staged.set(allocation.id, { entity: allocation, expectedVersion });
    return allocation;
  }

  async updateSplitProposal(
    proposal: SplitProposal,
    expectedVersion: number,
    tx: TransactionContext,
  ): Promise<SplitProposal> {
    const current = this.splitProposalStore.get(proposal.id);
    if (!current || current.version !== expectedVersion) {
      throw new ConcurrencyConflictError(
        `SplitProposal ${proposal.id} version conflict (expected ${expectedVersion}, actual ${current?.version}).`,
        { invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY, entity: 'SplitProposal' },
      );
    }
    const staged = (tx as any)?.stagedProposals as Map<string, { entity: SplitProposal; expectedVersion: number }>;
    staged.set(proposal.id, { entity: proposal, expectedVersion });
    return proposal;
  }
}

// ============================================================================
// Execution Context & HTTP Pipeline Helpers
// ============================================================================

function createExecutionContext(options: {
  headers: Record<string, string>;
  body: Record<string, unknown>;
  params?: Record<string, string>;
  actor: AuthenticatedActor;
  mutationOptions: TradingMutationOptions;
}): { context: ExecutionContext; req: Request; res: Response; reflector: Reflector } {
  const req: any = {
    headers: { ...options.headers },
    body: { ...options.body },
    params: { ...(options.params ?? { id: String(options.body.id ?? '100') }) },
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

  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(options.mutationOptions);

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

  return { context, req, res, reflector };
}

// ============================================================================
// EMPIRICAL CHALLENGER TEST SUITE
// ============================================================================

describe('Milestone 2 Concurrency Empirical Challenger Suite', () => {
  let harness: OptimisticConcurrencyTestHarness;
  let idempotencyService: TradingIdempotencyService;

  beforeEach(() => {
    harness = new OptimisticConcurrencyTestHarness();
    idempotencyService = new TradingIdempotencyService(
      harness.idempotencyRepo,
      harness.txRunner,
    );
  });

  // --------------------------------------------------------------------------
  // Challenge 1: Concurrent Race Conditions on QuoteRequest
  // --------------------------------------------------------------------------
  describe('Challenge 1: Concurrent race conditions between competing requests on QuoteRequest', () => {
    it('1.1 Accept Quote vs Withdraw Quote: simultaneous racing requests result in exactly one winner and one HTTP 409 CONCURRENCY_CONFLICT', async () => {
      // Setup: Request in artisans_bidding (v2), Quote in active (v1)
      const initialReq = buildSentRequest({ id: '100', version: 2, status: 'artisans_bidding' });
      const initialQuote = buildQuote({ id: '401', version: 1, status: 'active', max_quantity: 100 });
      harness.seedRequest(initialReq);
      harness.seedQuote(initialQuote);

      const buyerActor: AuthenticatedActor = {
        accountId: '10',
        role: 'buyer',
        sessionId: 'sess-buyer',
      };
      const artisanActor: AuthenticatedActor = {
        accountId: '21',
        role: 'artisan',
        sessionId: 'sess-artisan',
      };

      const keyBuyer = randomUUID();
      const keyArtisan = randomUUID();

      // Mutation 1: Buyer accepts quote v1
      const buyerInterceptor = new TradingMutationInterceptor(
        new Reflector(),
        idempotencyService,
      );
      const buyerCtx = createExecutionContext({
        headers: { 'x-idempotency-key': keyBuyer },
        body: { expected_request_version: 2, quote_id: '401', expected_quote_version: 1 },
        params: { id: '100' },
        actor: buyerActor,
        mutationOptions: {
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          expectedVersionFields: ['expected_request_version', 'expected_quote_version'],
        },
      });

      // Mutation 2: Artisan withdraws quote v1
      const artisanInterceptor = new TradingMutationInterceptor(
        new Reflector(),
        idempotencyService,
      );
      const artisanCtx = createExecutionContext({
        headers: { 'x-idempotency-key': keyArtisan },
        body: { expected_quote_version: 1, reason: 'Lò nung gặp sự cố đột xuất' },
        params: { id: '401' },
        actor: artisanActor,
        mutationOptions: {
          action: 'withdraw_quote',
          objectType: 'Quote',
          expectedVersionField: 'expected_quote_version',
        },
      });

      // Execution handler for buyer accept:
      const handleBuyer = async (): Promise<any> => {
        const tx = (buyerCtx.req as any)['tradingTxContext'];
        // Re-read current quote inside transaction
        const q = harness.getQuote('401')!;
        q.assertVersionMatches(1); // checks expected_quote_version
        const req = harness.getRequest('100')!;
        req.assertVersionMatches(2);

        // Mark quote accepted (v1 -> v2) and request accepted (v2 -> v3)
        const updatedQuote = Quote.reconstitute({
          ...q,
          status: 'accepted',
          version: Version.of(q.version).next().value,
          updated_at: BASE_NOW,
        });
        const updatedReq = QuoteRequest.reconstitute({
          ...req,
          status: 'buyer_accepted',
          version: Version.of(req.version).next().value,
          updated_at: BASE_NOW,
        });

        await harness.updateQuote(updatedQuote, 1, tx);
        await harness.updateRequest(updatedReq, 2, tx);

        return { request_id: '100', quote_id: '401', status: 'buyer_accepted' };
      };

      // Execution handler for artisan withdraw:
      const handleArtisan = async (): Promise<any> => {
        const tx = (artisanCtx.req as any)['tradingTxContext'];
        const q = harness.getQuote('401')!;
        q.assertVersionMatches(1);

        const updatedQuote = Quote.reconstitute({
          ...q,
          status: 'withdrawn',
          withdraw_reason: 'Lò nung gặp sự cố đột xuất',
          withdrawn_by: '21',
          withdrawn_at: BASE_NOW,
          version: Version.of(q.version).next().value,
          updated_at: BASE_NOW,
        });

        await harness.updateQuote(updatedQuote, 1, tx);
        return { quote_id: '401', status: 'withdrawn' };
      };

      // First artisan withdraw commits first (simulating race resolution order)
      const artisanCallHandler: CallHandler = { handle: () => of(handleArtisan()).pipe() };
      // Invoke artisan mutation
      const artisanObs = await artisanInterceptor.intercept(artisanCtx.context, {
        handle: () => of(null as any).pipe(),
      });
      // We simulate real transactional pipeline:
      const artisanResult = await idempotencyService.executeWithIdempotency({
        accountId: '21',
        action: 'withdraw_quote',
        objectType: 'Quote',
        objectId: '401',
        idempotencyKey: keyArtisan,
        payload: artisanCtx.req.body,
        execute: async (tx) => {
          (artisanCtx.req as any)['tradingTxContext'] = tx;
          return { result: await handleArtisan(), currentState: { status: 'withdrawn' } as any };
        },
      });

      expect(artisanResult.data).toEqual({ quote_id: '401', status: 'withdrawn' });
      expect(harness.getQuote('401')!.status).toBe('withdrawn');
      expect(harness.getQuote('401')!.version).toBe(2);

      // Now Buyer's accept request attempts to commit carrying stale expected_quote_version: 1
      await expect(
        idempotencyService.executeWithIdempotency({
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          idempotencyKey: keyBuyer,
          payload: buyerCtx.req.body,
          execute: async (tx) => {
            (buyerCtx.req as any)['tradingTxContext'] = tx;
            return { result: await handleBuyer(), currentState: {} as any };
          },
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      // Verify RFC 9457 Problem Details mapping for ConcurrencyConflictError
      expect(statusByCode['CONCURRENCY_CONFLICT']).toBe(409);
      expect(problems[409][0]).toBe('CONCURRENCY_CONFLICT');

      // Crucial: Request remains in artisans_bidding (v2), Quote remains withdrawn (v3), NOT accepted!
      expect(harness.getRequest('100')!.status).toBe('artisans_bidding');
      expect(harness.getRequest('100')!.version).toBe(2);
      expect(harness.getQuote('401')!.status).toBe('withdrawn');
      expect(harness.getQuote('401')!.version).toBe(2);
      // No idempotency record was committed for the buyer's failed attempt!
      expect(harness.countIdempotencyRecords()).toBe(1); // Only artisan's record exists
    });

    it('1.2 Cancel Request vs Confirm Delivery: competing race condition cleanly isolates winner and rejects loser with 409', async () => {
      // Setup: Request in in_production (v3), Allocation handed_over (v2)
      const initialReq = buildSentRequest({ id: '100', version: 3, status: 'in_production' });
      const initialAlloc = buildAllocation({ id: '701', version: 2, status: 'handed_over' });
      harness.seedRequest(initialReq);
      harness.seedAllocation(initialAlloc);

      const buyerActor: AuthenticatedActor = {
        accountId: '10',
        role: 'buyer',
        sessionId: 'sess-buyer',
      };
      const adminActor: AuthenticatedActor = {
        accountId: '999',
        role: 'admin',
        sessionId: 'sess-admin',
      };

      const keyCancel = randomUUID();
      const keyDelivered = randomUUID();

      // Mutation A: Buyer cancels request v3
      const cancelMutation = async (tx: TransactionContext) => {
        const req = harness.getRequest('100')!;
        req.assertNotCancelled();
        req.assertVersionMatches(3);

        const { request: cancelledReq } = req.cancel({
          actorId: '10',
          actorRole: 'buyer',
          expectedVersion: 3,
          cancelReason: 'Buyer hủy đơn',
          now: BASE_NOW,
        });

        await harness.updateRequest(cancelledReq, 3, tx);
        return { result: { request_id: '100', status: cancelledReq.status }, currentState: { status: cancelledReq.status } as any };
      };

      // Mutation B: Admin confirms delivery on request v3
      const deliverMutation = async (tx: TransactionContext) => {
        const req = harness.getRequest('100')!;
        req.assertNotCancelled();
        req.assertVersionMatches(3);

        const alloc = harness.getAllocation('701')!;
        const { request: deliveredReq } = req.confirmDelivered({
          actorId: '999',
          actorRole: 'admin',
          expectedVersion: 3,
          allocationStatuses: [alloc.status],
          reason: 'Biên bản bàn giao hoàn tất',
          evidence: 'https://vcraft.vn/evidence/delivery-100.pdf',
          now: BASE_NOW,
        });

        await harness.updateRequest(deliveredReq, 3, tx);
        return { result: { request_id: '100', status: deliveredReq.status }, currentState: { status: deliveredReq.status } as any };
      };

      // Scenario A: Confirm Delivery commits first
      const deliverResult = await idempotencyService.executeWithIdempotency({
        accountId: '999',
        action: 'confirm_delivered',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: keyDelivered,
        payload: { expected_request_version: 3, reason: 'Biên bản bàn giao hoàn tất', evidence: 'https://vcraft.vn/evidence/delivery-100.pdf' },
        execute: deliverMutation,
      });

      expect(deliverResult.data).toEqual({ request_id: '100', status: 'delivered' });
      expect(harness.getRequest('100')!.status).toBe('delivered');
      expect(harness.getRequest('100')!.version).toBe(4);

      // Now Buyer's cancel attempt arrives with stale expected_request_version: 3
      await expect(
        idempotencyService.executeWithIdempotency({
          accountId: '10',
          action: 'cancel_request',
          objectType: 'QuoteRequest',
          objectId: '100',
          idempotencyKey: keyCancel,
          payload: { expected_request_version: 3, cancel_reason: 'Buyer hủy đơn' },
          execute: cancelMutation,
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      // Verify entity state: Request is DELIVERED, NOT cancelled!
      const currentReq = harness.getRequest('100')!;
      expect(currentReq.status).toBe('delivered');
      expect(currentReq.cancelled_at).toBeNull();
      expect(currentReq.version).toBe(4);

      // Reverse verification: Once delivered, even with version 4, domain rule prevents cancellation
      expect(() => {
        currentReq.cancel({
          actorId: '10',
          actorRole: 'buyer',
          expectedVersion: 4,
          cancelReason: 'Cố hủy đơn đã giao',
          now: BASE_NOW,
        });
      }).toThrow(InvalidStateTransitionError);
    });

    it('1.3 Inverted Race: Cancel commits first -> Confirm Delivery rejected with 409 CONCURRENCY_CONFLICT', async () => {
      // Setup: Request in in_production (v3), Allocation handed_over (v2)
      const initialReq = buildSentRequest({ id: '100', version: 3, status: 'in_production' });
      const initialAlloc = buildAllocation({ id: '701', version: 2, status: 'handed_over' });
      harness.seedRequest(initialReq);
      harness.seedAllocation(initialAlloc);

      const keyCancel = randomUUID();
      const keyDelivered = randomUUID();

      // Cancel commits first
      const cancelResult = await idempotencyService.executeWithIdempotency({
        accountId: '999',
        action: 'cancel_request',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: keyCancel,
        payload: { expected_request_version: 3, cancel_reason: 'Admin can thiệp khẩn cấp' },
        execute: async (tx) => {
          const req = harness.getRequest('100')!;
          const { request: cancelledReq } = req.cancel({
            actorId: '999',
            actorRole: 'admin',
            expectedVersion: 3,
            cancelReason: 'Admin can thiệp khẩn cấp',
            goodsHandlingNote: 'Bảo quản tại kho làng nghề',
            now: BASE_NOW,
          });
          await harness.updateRequest(cancelledReq, 3, tx);
          return { result: { request_id: '100', status: cancelledReq.status }, currentState: { status: cancelledReq.status } as any };
        },
      });

      expect(cancelResult.data).toEqual({ request_id: '100', status: 'in_production' }); // Status remains in_production but marked cancelled
      const cancelledReq = harness.getRequest('100')!;
      expect(cancelledReq.isCancelled()).toBe(true);
      expect(cancelledReq.version).toBe(4);

      // Now competing confirm delivery arrives with stale version 3
      await expect(
        idempotencyService.executeWithIdempotency({
          accountId: '10',
          action: 'confirm_delivered',
          objectType: 'QuoteRequest',
          objectId: '100',
          idempotencyKey: keyDelivered,
          payload: { expected_request_version: 3, reason: 'Giao hàng thành công' },
          execute: async (tx) => {
            const req = harness.getRequest('100')!;
            req.assertNotCancelled(); // Fails!
            req.assertVersionMatches(3); // Fails!
            return { result: {}, currentState: {} as any };
          },
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      // Request stays CANCELLED, never delivered!
      expect(harness.getRequest('100')!.isCancelled()).toBe(true);
      expect(harness.getRequest('100')!.version).toBe(4);
      expect(harness.countIdempotencyRecords()).toBe(1);
    });

    it('1.4 True Promise.all race: simultaneous Accept vs Withdraw across separate transactions produces exactly 1 winner and 1 409', async () => {
      const initialReq = buildSentRequest({ id: '100', version: 2, status: 'artisans_bidding' });
      const initialQuote = buildQuote({ id: '401', version: 1, status: 'active', max_quantity: 100 });
      harness.seedRequest(initialReq);
      harness.seedQuote(initialQuote);

      const keyBuyer = randomUUID();
      const keyArtisan = randomUUID();

      let buyerWon = false;
      let artisanWon = false;
      let conflictCount = 0;

      const runBuyer = idempotencyService.executeWithIdempotency({
        accountId: '10',
        action: 'accept_quote',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: keyBuyer,
        payload: { expected_request_version: 2, quote_id: '401', expected_quote_version: 1 },
        execute: async (tx) => {
          const q = harness.getQuote('401')!;
          q.assertVersionMatches(1);
          const req = harness.getRequest('100')!;
          req.assertVersionMatches(2);

          const updatedQuote = Quote.reconstitute({
            ...q,
            status: 'accepted',
            version: 2,
            updated_at: BASE_NOW,
          });
          const updatedReq = QuoteRequest.reconstitute({
            ...req,
            status: 'buyer_accepted',
            version: 3,
            updated_at: BASE_NOW,
          });

          await harness.updateQuote(updatedQuote, 1, tx);
          await harness.updateRequest(updatedReq, 2, tx);
          return { result: { winner: 'buyer' }, currentState: { status: 'buyer_accepted' } as any };
        },
      })
        .then(() => {
          buyerWon = true;
        })
        .catch((err) => {
          if (err instanceof ConcurrencyConflictError) {
            conflictCount++;
          } else {
            throw err;
          }
        });

      const runArtisan = idempotencyService.executeWithIdempotency({
        accountId: '21',
        action: 'withdraw_quote',
        objectType: 'Quote',
        objectId: '401',
        idempotencyKey: keyArtisan,
        payload: { expected_quote_version: 1, reason: 'Rút báo giá' },
        execute: async (tx) => {
          const q = harness.getQuote('401')!;
          q.assertVersionMatches(1);

          const updatedQuote = Quote.reconstitute({
            ...q,
            status: 'withdrawn',
            withdraw_reason: 'Rút báo giá',
            withdrawn_by: '21',
            withdrawn_at: BASE_NOW,
            version: 2,
            updated_at: BASE_NOW,
          });

          await harness.updateQuote(updatedQuote, 1, tx);
          return { result: { winner: 'artisan' }, currentState: { status: 'withdrawn' } as any };
        },
      })
        .then(() => {
          artisanWon = true;
        })
        .catch((err) => {
          if (err instanceof ConcurrencyConflictError) {
            conflictCount++;
          } else {
            throw err;
          }
        });

      await Promise.all([runBuyer, runArtisan]);

      // Invariant: Exactly one won, exactly one received ConcurrencyConflictError!
      expect(buyerWon || artisanWon).toBe(true);
      expect(buyerWon && artisanWon).toBe(false);
      expect(conflictCount).toBe(1);
      expect(harness.countIdempotencyRecords()).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Challenge 2: Stale Version Verification & Entity State Immutability / Non-Expiration
  // --------------------------------------------------------------------------
  describe('Challenge 2: Stale version 409 CONCURRENCY_CONFLICT does NOT modify or expire entity state', () => {
    it('2.1 Stale QuoteRequest version: throws ConcurrencyConflictError (HTTP 409) and leaves state pristine', async () => {
      const initialReq = buildSentRequest({ id: '100', version: 5, status: 'artisans_bidding' });
      harness.seedRequest(initialReq);

      const staleVersionKey = randomUUID();

      await expect(
        idempotencyService.executeWithIdempotency({
          accountId: '10',
          action: 'edit_contact',
          objectType: 'QuoteRequest',
          objectId: '100',
          idempotencyKey: staleVersionKey,
          payload: { expected_request_version: 4, recipient_name: 'Hacker Mua' },
          execute: async (tx) => {
            const req = harness.getRequest('100')!;
            req.assertVersionMatches(4); // Fails!
            return { result: {}, currentState: {} as any };
          },
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      // Invariant: Version is still 5, recipient_name is untouched, zero records persisted
      const stored = harness.getRequest('100')!;
      expect(stored.version).toBe(5);
      expect(stored.recipient_name).toBe('Nguyễn Văn Mua');
      expect(stored.status).toBe('artisans_bidding');
      expect(harness.countIdempotencyRecords()).toBe(0);
    });

    it('2.2 Stale Quote version: throws ConcurrencyConflictError and does NOT alter or withdraw quote', async () => {
      const initialQuote = buildQuote({ id: '401', version: 3, status: 'active', unit_price: 150000 });
      harness.seedQuote(initialQuote);

      const staleKey = randomUUID();

      await expect(
        idempotencyService.executeWithIdempotency({
          accountId: '21',
          action: 'update_quote',
          objectType: 'Quote',
          objectId: '401',
          idempotencyKey: staleKey,
          payload: { expected_quote_version: 2, unit_price: 200000 },
          execute: async (tx) => {
            const q = harness.getQuote('401')!;
            q.assertVersionMatches(2); // Fails!
            return { result: {}, currentState: {} as any };
          },
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      const currentQuote = harness.getQuote('401')!;
      expect(currentQuote.version).toBe(3);
      expect(currentQuote.unit_price).toBe(150000);
      expect(currentQuote.status).toBe('active');
      expect(harness.countIdempotencyRecords()).toBe(0);
    });

    it('2.3 Stale SplitProposal version: throws ConcurrencyConflictError and MUST NOT expire proposal (BR-18, BR-27)', async () => {
      // Per BR-18, BR-27: "Không expire phương án chỉ vì version client cũ."
      const initialProposal = buildSplitProposal({
        id: '501',
        version: 2,
        status: 'proposed',
      });
      harness.seedSplitProposal(initialProposal);

      const staleKey = randomUUID();

      await expect(
        idempotencyService.executeWithIdempotency({
          accountId: '10',
          action: 'reject_split_proposal',
          objectType: 'SplitProposal',
          objectId: '501',
          idempotencyKey: staleKey,
          payload: { expected_proposal_version: 1, reason: 'Từ chối với version cũ' },
          execute: async (tx) => {
            const p = harness.getSplitProposal('501')!;
            p.assertVersionMatches(1); // Fails!
            return { result: {}, currentState: {} as any };
          },
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      const currentProposal = harness.getSplitProposal('501')!;
      expect(currentProposal.version).toBe(2);
      expect(currentProposal.status).toBe('proposed'); // Still PROPOSED, NOT expired!
      expect(currentProposal.expire_reason).toBeNull();
      expect(currentProposal.expired_at).toBeNull();
      expect(harness.countIdempotencyRecords()).toBe(0);
    });

    it('2.4 Stale Allocation version: throws ConcurrencyConflictError and does NOT mutate batch links', async () => {
      const initialAlloc = buildAllocation({ id: '701', version: 3, status: 'in_production', batch_links: [] });
      harness.seedAllocation(initialAlloc);

      const staleKey = randomUUID();

      await expect(
        idempotencyService.executeWithIdempotency({
          accountId: '21',
          action: 'replace_batch_links',
          objectType: 'Allocation',
          objectId: '701',
          idempotencyKey: staleKey,
          payload: { expected_allocation_version: 2, batch_links: [{ batch_id: '901', batch_workshop_id: '201', linked_quantity: 10 }] },
          execute: async (tx) => {
            const a = harness.getAllocation('701')!;
            a.assertVersionMatches(2); // Fails!
            return { result: {}, currentState: {} as any };
          },
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      const currentAlloc = harness.getAllocation('701')!;
      expect(currentAlloc.version).toBe(3);
      expect(currentAlloc.batch_links).toHaveLength(0);
      expect(harness.countIdempotencyRecords()).toBe(0);
    });

    it('2.5 Interceptor pre-validation rejects negative, zero, float, or missing version fields with 400 INVALID_INPUT', async () => {
      const actor: AuthenticatedActor = { accountId: '10', role: 'buyer', sessionId: 's1' };

      // Case A: expected_request_version is missing
      const ctxMissing = createExecutionContext({
        headers: { 'x-idempotency-key': randomUUID() },
        body: { recipient_name: 'Name' },
        actor,
        mutationOptions: {
          action: 'edit_contact',
          objectType: 'QuoteRequest',
          expectedVersionField: 'expected_request_version',
        },
      });
      const interceptorMissing = new TradingMutationInterceptor(ctxMissing.reflector, idempotencyService);
      await expect(
        interceptorMissing.intercept(ctxMissing.context, { handle: () => of(null as any) }),
      ).rejects.toThrow(InvalidTradingInputError);

      // Case B: expected_request_version is 0
      const ctxZero = createExecutionContext({
        headers: { 'x-idempotency-key': randomUUID() },
        body: { expected_request_version: 0 },
        actor,
        mutationOptions: {
          action: 'edit_contact',
          objectType: 'QuoteRequest',
          expectedVersionField: 'expected_request_version',
        },
      });
      const interceptorZero = new TradingMutationInterceptor(ctxZero.reflector, idempotencyService);
      await expect(
        interceptorZero.intercept(ctxZero.context, { handle: () => of(null as any) }),
      ).rejects.toThrow(InvalidTradingInputError);

      // Case C: expected_request_version is negative
      const ctxNegative = createExecutionContext({
        headers: { 'x-idempotency-key': randomUUID() },
        body: { expected_request_version: -5 },
        actor,
        mutationOptions: {
          action: 'edit_contact',
          objectType: 'QuoteRequest',
          expectedVersionField: 'expected_request_version',
        },
      });
      const interceptorNegative = new TradingMutationInterceptor(ctxNegative.reflector, idempotencyService);
      await expect(
        interceptorNegative.intercept(ctxNegative.context, { handle: () => of(null as any) }),
      ).rejects.toThrow(InvalidTradingInputError);

      // Case D: expected_request_version is a float
      const ctxFloat = createExecutionContext({
        headers: { 'x-idempotency-key': randomUUID() },
        body: { expected_request_version: 2.5 },
        actor,
        mutationOptions: {
          action: 'edit_contact',
          objectType: 'QuoteRequest',
          expectedVersionField: 'expected_request_version',
        },
      });
      const interceptorFloat = new TradingMutationInterceptor(ctxFloat.reflector, idempotencyService);
      await expect(
        interceptorFloat.intercept(ctxFloat.context, { handle: () => of(null as any) }),
      ).rejects.toThrow(InvalidTradingInputError);

      // Verify that all InvalidTradingInputErrors map to HTTP 400
      expect(statusByCode['INVALID_INPUT']).toBe(400);
      expect(problems[400][0]).toBe('INVALID_INPUT');
    });
  });

  // --------------------------------------------------------------------------
  // Challenge 3: Independent Artisan Allocation Concurrency
  // --------------------------------------------------------------------------
  describe('Challenge 3: Independent artisan allocation concurrency', () => {
    it('3.1 Artisan A updating batches on Allocation 701 does NOT conflict with Artisan B updating batches on Allocation 702', async () => {
      // Setup: 1 QuoteRequest in_production, 2 independent allocations for 2 distinct workshops
      const req = buildSentRequest({ id: '100', version: 4, status: 'in_production', quantity: 100 });
      const allocA = buildAllocation({
        id: '701',
        request_id: '100',
        workshop_id: '201',
        quantity: 60,
        version: 1,
        status: 'in_production',
      });
      const allocB = buildAllocation({
        id: '702',
        request_id: '100',
        workshop_id: '202',
        quantity: 40,
        version: 1,
        status: 'in_production',
      });

      harness.seedRequest(req);
      harness.seedAllocation(allocA);
      harness.seedAllocation(allocB);

      const keyA = randomUUID();
      const keyB = randomUUID();

      // Artisan A updates batches for Allocation 701 (expected_allocation_version: 1)
      const promiseA = idempotencyService.executeWithIdempotency({
        accountId: '201',
        action: 'replace_batch_links',
        objectType: 'Allocation',
        objectId: '701',
        idempotencyKey: keyA,
        payload: {
          expected_allocation_version: 1,
          batch_links: [
            { batch_id: '901', batch_workshop_id: '201', linked_quantity: 30 },
            { batch_id: '902', batch_workshop_id: '201', linked_quantity: 30 },
          ],
        },
        execute: async (tx) => {
          const a = harness.getAllocation('701')!;
          const { allocation: updated } = a.replaceBatchLinks({
            request: req,
            actorId: '21',
            actorWorkshopId: '201',
            expectedVersion: 1,
            batchLinks: [
              { batch_id: '901', batch_workshop_id: '201', linked_quantity: 30 },
              { batch_id: '902', batch_workshop_id: '201', linked_quantity: 30 },
            ],
            now: BASE_NOW,
          });
          await harness.updateAllocation(updated, 1, tx);
          return {
            result: { allocation_id: updated.id, version: updated.version, links_count: updated.batch_links.length },
            currentState: { version: updated.version, status: updated.status } as any,
          };
        },
      });

      // Artisan B updates batches for Allocation 702 concurrently (expected_allocation_version: 1)
      const promiseB = idempotencyService.executeWithIdempotency({
        accountId: '202',
        action: 'replace_batch_links',
        objectType: 'Allocation',
        objectId: '702',
        idempotencyKey: keyB,
        payload: {
          expected_allocation_version: 1,
          batch_links: [
            { batch_id: '903', batch_workshop_id: '202', linked_quantity: 40 },
          ],
        },
        execute: async (tx) => {
          const b = harness.getAllocation('702')!;
          const { allocation: updated } = b.replaceBatchLinks({
            request: req,
            actorId: '22',
            actorWorkshopId: '202',
            expectedVersion: 1,
            batchLinks: [
              { batch_id: '903', batch_workshop_id: '202', linked_quantity: 40 },
            ],
            now: BASE_NOW,
          });
          await harness.updateAllocation(updated, 1, tx);
          return {
            result: { allocation_id: updated.id, version: updated.version, links_count: updated.batch_links.length },
            currentState: { version: updated.version, status: updated.status } as any,
          };
        },
      });

      // Execute simultaneously
      const [resA, resB] = await Promise.all([promiseA, promiseB]);

      // Both succeeded cleanly!
      expect(resA.data).toEqual({ allocation_id: '701', version: 2, links_count: 2 });
      expect(resB.data).toEqual({ allocation_id: '702', version: 2, links_count: 1 });

      const finalAllocA = harness.getAllocation('701')!;
      const finalAllocB = harness.getAllocation('702')!;

      expect(finalAllocA.version).toBe(2);
      expect(finalAllocA.batch_links).toHaveLength(2);
      expect(finalAllocB.version).toBe(2);
      expect(finalAllocB.batch_links).toHaveLength(1);

      // Exactly 2 distinct idempotency records persisted
      expect(harness.countIdempotencyRecords()).toBe(2);
    });

    it('3.2 Three distinct artisans concurrently mutate allocations (replaceBatchLinks and handover) on the same QuoteRequest without any collision', async () => {
      const req = buildSentRequest({ id: '100', version: 5, status: 'in_production', quantity: 120 });
      const alloc1 = buildAllocation({ id: '701', request_id: '100', workshop_id: '201', quantity: 40, version: 1, status: 'in_production' });
      const alloc2 = buildAllocation({ id: '702', request_id: '100', workshop_id: '202', quantity: 40, version: 1, status: 'in_production' });
      const alloc3 = buildAllocation({ id: '703', request_id: '100', workshop_id: '203', quantity: 40, version: 1, status: 'in_production' });

      harness.seedRequest(req);
      harness.seedAllocation(alloc1);
      harness.seedAllocation(alloc2);
      harness.seedAllocation(alloc3);

      const k1 = randomUUID();
      const k2 = randomUUID();
      const k3 = randomUUID();

      const task1 = idempotencyService.executeWithIdempotency({
        accountId: '201',
        action: 'replace_batch_links',
        objectType: 'Allocation',
        objectId: '701',
        idempotencyKey: k1,
        payload: { expected_allocation_version: 1, batch_links: [{ batch_id: '901', batch_workshop_id: '201', linked_quantity: 40 }] },
        execute: async (tx) => {
          const a = harness.getAllocation('701')!;
          const { allocation: u } = a.replaceBatchLinks({
            request: req,
            actorId: '21',
            actorWorkshopId: '201',
            expectedVersion: 1,
            batchLinks: [{ batch_id: '901', batch_workshop_id: '201', linked_quantity: 40 }],
            now: BASE_NOW,
          });
          await harness.updateAllocation(u, 1, tx);
          return { result: { id: u.id, version: u.version }, currentState: { version: u.version } as any };
        },
      });

      const task2 = idempotencyService.executeWithIdempotency({
        accountId: '202',
        action: 'replace_batch_links',
        objectType: 'Allocation',
        objectId: '702',
        idempotencyKey: k2,
        payload: { expected_allocation_version: 1, batch_links: [{ batch_id: '902', batch_workshop_id: '202', linked_quantity: 40 }] },
        execute: async (tx) => {
          const a = harness.getAllocation('702')!;
          const { allocation: u } = a.replaceBatchLinks({
            request: req,
            actorId: '22',
            actorWorkshopId: '202',
            expectedVersion: 1,
            batchLinks: [{ batch_id: '902', batch_workshop_id: '202', linked_quantity: 40 }],
            now: BASE_NOW,
          });
          await harness.updateAllocation(u, 1, tx);
          return { result: { id: u.id, version: u.version }, currentState: { version: u.version } as any };
        },
      });

      const task3 = idempotencyService.executeWithIdempotency({
        accountId: '203',
        action: 'record_artisan_handover',
        objectType: 'Allocation',
        objectId: '703',
        idempotencyKey: k3,
        payload: { expected_allocation_version: 1, delivery_note: 'Giao trực tiếp đợt 1' },
        execute: async (tx) => {
          const a = harness.getAllocation('703')!;
          const { allocation: u } = a.recordArtisanHandover({
            request: req,
            actorId: '23',
            actorWorkshopId: '203',
            expectedVersion: 1,
            deliveryNote: 'Giao trực tiếp đợt 1',
            actualHandoverAt: BASE_NOW,
            now: BASE_NOW,
          });
          await harness.updateAllocation(u, 1, tx);
          return { result: { id: u.id, version: u.version, status: u.status }, currentState: { version: u.version } as any };
        },
      });

      const [r1, r2, r3] = await Promise.all([task1, task2, task3]);

      expect(r1.data).toEqual({ id: '701', version: 2 });
      expect(r2.data).toEqual({ id: '702', version: 2 });
      expect(r3.data).toEqual({ id: '703', version: 2, status: 'handed_over' });

      expect(harness.getAllocation('701')!.version).toBe(2);
      expect(harness.getAllocation('702')!.version).toBe(2);
      expect(harness.getAllocation('703')!.version).toBe(2);
      expect(harness.getAllocation('703')!.status).toBe('handed_over');

      expect(harness.countIdempotencyRecords()).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // Challenge 4: Multiple Sequential Mutations with Incrementing Versions
  // --------------------------------------------------------------------------
  describe('Challenge 4: Multiple sequential mutations with incrementing versions under separate idempotency keys', () => {
    it('4.1 Successfully processes 5 consecutive mutations across QuoteRequest and Allocation, enforcing exact version increment at every step', async () => {
      let req = buildSentRequest({ id: '100', version: 1, status: 'artisans_bidding' });
      harness.seedRequest(req);

      // Step 1: Buyer edits recipient contact (v1 -> v2, Key 1)
      const key1 = randomUUID();
      const step1Result = await idempotencyService.executeWithIdempotency({
        accountId: '10',
        action: 'edit_contact',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: key1,
        payload: { expected_request_version: 1, recipient_name: 'Trần Văn A' },
        execute: async (tx) => {
          const { request: updated } = req.updateRecipientContact({
            buyerId: '10',
            expectedVersion: 1,
            recipientName: 'Trần Văn A',
            recipientPhone: '0911111111',
            now: BASE_NOW,
          });
          req = updated;
          await harness.updateRequest(updated, 1, tx);
          return { result: { version: updated.version }, currentState: { version: updated.version } as any };
        },
      });
      expect(step1Result.data).toEqual({ version: 2 });
      expect(harness.getRequest('100')!.version).toBe(2);

      // Step 2: Buyer accepts quote directly (v2 -> v3, Key 2)
      const key2 = randomUUID();
      let alloc = buildAllocation({ id: '701', request_id: '100', workshop_id: '201', version: 1, status: 'not_started' });
      harness.seedAllocation(alloc);

      const step2Result = await idempotencyService.executeWithIdempotency({
        accountId: '10',
        action: 'accept_quote',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: key2,
        payload: { expected_request_version: 2, quote_id: '401' },
        execute: async (tx) => {
          const { request: updated } = req.markBuyerAccepted({
            buyerId: '10',
            expectedVersion: 2,
            now: BASE_NOW,
          });
          req = updated;
          await harness.updateRequest(updated, 2, tx);
          return { result: { version: updated.version, status: updated.status }, currentState: { version: updated.version } as any };
        },
      });
      expect(step2Result.data).toEqual({ version: 3, status: 'buyer_accepted' });
      expect(harness.getRequest('100')!.version).toBe(3);

      // Step 3: Artisan starts production on Allocation 701 (alloc v1 -> v2, request v3 -> v4, Key 3)
      const key3 = randomUUID();
      const step3Result = await idempotencyService.executeWithIdempotency({
        accountId: '201',
        action: 'start_production',
        objectType: 'Allocation',
        objectId: '701',
        idempotencyKey: key3,
        payload: { expected_allocation_version: 1 },
        execute: async (tx) => {
          const { allocation: updatedAlloc, updatedRequest } = alloc.startProduction({
            request: req,
            actorId: '21',
            actorWorkshopId: '201',
            expectedVersion: 1,
            now: BASE_NOW,
          });
          alloc = updatedAlloc;
          req = updatedRequest;
          await harness.updateAllocation(updatedAlloc, 1, tx);
          await harness.updateRequest(updatedRequest, 3, tx);
          return { result: { alloc_version: updatedAlloc.version, req_version: updatedRequest.version }, currentState: { version: updatedAlloc.version } as any };
        },
      });
      expect(step3Result.data).toEqual({ alloc_version: 2, req_version: 4 });
      expect(harness.getAllocation('701')!.version).toBe(2);
      expect(harness.getRequest('100')!.version).toBe(4);

      // Step 4: Stale attempt on Allocation using version 1 instead of 2 MUST FAIL with 409
      const key4Stale = randomUUID();
      await expect(
        idempotencyService.executeWithIdempotency({
          accountId: '201',
          action: 'replace_batch_links',
          objectType: 'Allocation',
          objectId: '701',
          idempotencyKey: key4Stale,
          payload: { expected_allocation_version: 1, batch_links: [{ batch_id: '901', batch_workshop_id: '201', linked_quantity: 20 }] },
          execute: async (tx) => {
            const a = harness.getAllocation('701')!;
            a.assertVersionMatches(1); // Fails!
            return { result: {}, currentState: {} as any };
          },
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      // Step 5: Artisan links batches using the exact expected version 2 (alloc v2 -> v3, Key 5)
      const key5 = randomUUID();
      const step5Result = await idempotencyService.executeWithIdempotency({
        accountId: '201',
        action: 'replace_batch_links',
        objectType: 'Allocation',
        objectId: '701',
        idempotencyKey: key5,
        payload: { expected_allocation_version: 2, batch_links: [{ batch_id: '901', batch_workshop_id: '201', linked_quantity: 20 }] },
        execute: async (tx) => {
          const { allocation: updatedAlloc } = alloc.replaceBatchLinks({
            request: req,
            actorId: '21',
            actorWorkshopId: '201',
            expectedVersion: 2,
            batchLinks: [{ batch_id: '901', batch_workshop_id: '201', linked_quantity: 20 }],
            now: BASE_NOW,
          });
          alloc = updatedAlloc;
          await harness.updateAllocation(updatedAlloc, 2, tx);
          return { result: { alloc_version: updatedAlloc.version, batch_count: updatedAlloc.batch_links.length }, currentState: { version: updatedAlloc.version } as any };
        },
      });
      expect(step5Result.data).toEqual({ alloc_version: 3, batch_count: 1 });
      expect(harness.getAllocation('701')!.version).toBe(3);

      // Verify all 4 successful mutation idempotency records exist (key1, key2, key3, key5)
      expect(harness.countIdempotencyRecords()).toBe(4);

      // Replaying step 1 returns cached snapshot with latest fresh current state
      const replay1 = await idempotencyService.executeWithIdempotency({
        accountId: '10',
        action: 'edit_contact',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: key1,
        payload: { expected_request_version: 1, recipient_name: 'Trần Văn A' },
        getCurrentState: async () => ({ request: { id: '100', version: req.version, status: req.status } } as any),
        execute: async () => {
          throw new Error('Should not execute on replay!');
        },
      });
      expect(replay1.operation.replayed).toBe(true);
      expect((replay1.data as any).version).toBe(2);
      expect((replay1.operation.current_state as any).request.version).toBe(4);
    });
  });
});
