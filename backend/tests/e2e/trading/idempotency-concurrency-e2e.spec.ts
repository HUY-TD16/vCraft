import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BusinessRuleException } from '../../../src/common/domain/errors/business-rule.exception';
import type { TransactionContext } from '../../../src/common/application/ports/transaction-runner';
import type { PrismaService } from '../../../src/infrastructure/database/prisma/prisma.service';
import { PrismaTransactionRunner } from '../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import {
  IdempotencyRecord as PrismaIdempotencyRecord,
  Prisma,
} from '../../../src/generated/prisma/client';
import {
  Allocation,
  AllocationBatchLink,
  ConcurrencyConflictError,
  EntityId,
  IdempotencyConflictError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  Money,
  ProposalExpectationVO,
  Quantity,
  Quote,
  QuoteRequest,
  RequestRecipient,
  SplitProposal,
  TRADING_INVARIANTS,
  TradingIdempotencyPolicy,
  TradingPermissionDeniedError,
  UnitPrice,
  Version,
} from '../../../src/modules/trading/domain';
import {
  IdempotencyRecordMapper,
  PrismaIdempotencyRecordRepository,
  bigintToId,
  dateToInstant,
  idToBigInt,
} from '../../../src/modules/trading/adapters/persistence';
import type {
  PersistedIdempotencyRecord,
  TradingCurrentStateDto,
} from '../../../src/modules/trading/application/dtos/trading-persistence.dtos';
import { statusByCode } from '../../../src/common/http/filters/api-problem';
import { problems } from '../../../src/common/http/filters/problem-details.filter';

// ============================================================================
// Types & Contracts (PROJECT.md § Interface Contracts)
// ============================================================================

export interface HttpRequestSimulation {
  readonly headers: Record<string, string | undefined>;
  readonly accountId: string;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly body: unknown;
  readonly method?: string;
}

export interface HttpResponseSimulation<T = unknown> {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body:
    | {
        readonly success: true;
        readonly data: T;
        readonly operation: {
          readonly id: string;
          readonly replayed: boolean;
          readonly committed_at: string;
          readonly current_state: unknown;
        };
      }
    | {
        readonly type: string;
        readonly title: string;
        readonly status: number;
        readonly detail: string;
        readonly code: string;
        readonly tracking_id: string;
        readonly errors?: readonly { readonly field: string; readonly message: string }[];
      }
    | null;
}

// ============================================================================
// Pure Utilities (UUID v4 & Canonical JSON SHA-256 Fingerprint)
// ============================================================================

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuidV4(rawKey: string | null | undefined): boolean {
  if (typeof rawKey !== 'string') {
    return false;
  }
  const trimmed = rawKey.trim();
  if (trimmed.length !== 36) {
    return false;
  }
  return UUID_V4_REGEX.test(trimmed);
}

export function canonicalizePayload(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizePayload);
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    if (obj[key] !== undefined) {
      sortedObj[key] = canonicalizePayload(obj[key]);
    }
  }
  return sortedObj;
}

export function computeCanonicalFingerprint(payload: unknown): string {
  const canonical = canonicalizePayload(payload ?? {});
  const serialized = JSON.stringify(canonical);
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

export function formatRfc9457Problem(
  error: unknown,
  trackingId: string = randomUUID(),
): HttpResponseSimulation['body'] {
  let status = 500;
  let code = 'INTERNAL_SERVER_ERROR';

  if (error instanceof BusinessRuleException) {
    code = error.code;
    status = (statusByCode as Record<string, number>)[error.code] ?? 500;
  }

  const defaultMeta = (problems as Record<number, readonly [string, string, string]>)[status] ?? [
    code,
    'Lỗi hệ thống',
    'Cung cấp mã tra cứu khi liên hệ hỗ trợ.',
  ];

  const title = defaultMeta[1];
  const detail = error instanceof Error ? error.message : defaultMeta[2];

  return {
    type: `urn:vcraft:problem:${code}`,
    title,
    status,
    detail,
    code,
    tracking_id: trackingId,
  };
}

// ============================================================================
// In-Memory Test Harness (Mock Prisma & Transaction Runner Fixture)
// ============================================================================

export interface InMemoryTradingE2EHarness {
  readonly txRunner: PrismaTransactionRunner;
  readonly idempotencyRepo: PrismaIdempotencyRecordRepository;
  readonly executeHttpMutation: <TResult, TState = TradingCurrentStateDto>(
    req: HttpRequestSimulation,
    onMutate: (tx: TransactionContext) => Promise<{ result: TResult; currentState: TState }>,
    getCurrentState: (tx: TransactionContext) => Promise<TState>,
  ) => Promise<HttpResponseSimulation<TResult>>;
  readonly countStoredRecords: () => number;
  readonly getStoredRecord: (
    scope: { accountId: string; action: string; objectType: string; objectId: string; key: string },
  ) => PrismaIdempotencyRecord | undefined;
  readonly cleanupExpired: (cutoff: Date) => Promise<number>;
  readonly simulateP2002RaceOnNextCreate: (existingRow: PrismaIdempotencyRecord) => void;
}

export function createInMemoryTradingE2EHarness(baseClock: Date = new Date('2026-11-11T08:00:00.000Z')): InMemoryTradingE2EHarness {
  const table = new Map<string, PrismaIdempotencyRecord>();
  let nextId = 1000n;
  let triggerP2002Next: PrismaIdempotencyRecord | null = null;

  function makeKey(
    accountId: bigint,
    action: string,
    objectType: string,
    objectId: bigint,
    idempotencyKey: string,
  ): string {
    return `${accountId}:${action.trim()}:${objectType.trim()}:${objectId}:${idempotencyKey.trim().toLowerCase()}`;
  }

  const mockClient = {
    idempotencyRecord: {
      findUnique: async (args: {
        where: {
          account_id_action_object_type_object_id_idempotency_key: {
            account_id: bigint;
            action: string;
            object_type: string;
            object_id: bigint;
            idempotency_key: string;
          };
        };
      }): Promise<PrismaIdempotencyRecord | null> => {
        const composite = args.where.account_id_action_object_type_object_id_idempotency_key;
        const key = makeKey(
          composite.account_id,
          composite.action,
          composite.object_type,
          composite.object_id,
          composite.idempotency_key,
        );
        const found = table.get(key);
        return found ? { ...found } : null;
      },

      create: async (args: {
        data: Prisma.IdempotencyRecordUncheckedCreateInput;
      }): Promise<PrismaIdempotencyRecord> => {
        if (triggerP2002Next) {
          const conflictRow = triggerP2002Next;
          triggerP2002Next = null;
          // Put the winning record in table first to simulate race condition
          const winKey = makeKey(
            conflictRow.account_id,
            conflictRow.action,
            conflictRow.object_type,
            conflictRow.object_id,
            conflictRow.idempotency_key,
          );
          table.set(winKey, conflictRow);

          throw new Prisma.PrismaClientKnownRequestError(
            'Unique constraint failed on the fields: (`account_id`,`action`,`object_type`,`object_id`,`idempotency_key`)',
            { code: 'P2002', clientVersion: '5.20.0' },
          );
        }

        const compositeKey = makeKey(
          BigInt(args.data.account_id),
          String(args.data.action),
          String(args.data.object_type),
          BigInt(args.data.object_id),
          String(args.data.idempotency_key),
        );

        if (table.has(compositeKey)) {
          throw new Prisma.PrismaClientKnownRequestError(
            'Unique constraint failed on the fields: (`account_id`,`action`,`object_type`,`object_id`,`idempotency_key`)',
            { code: 'P2002', clientVersion: '5.20.0' },
          );
        }

        const newRow: PrismaIdempotencyRecord = {
          id: args.data.id !== undefined ? BigInt(args.data.id) : nextId++,
          idempotency_key: String(args.data.idempotency_key).trim(),
          request_fingerprint: String(args.data.request_fingerprint),
          account_id: BigInt(args.data.account_id),
          action: String(args.data.action),
          object_type: String(args.data.object_type),
          object_id: BigInt(args.data.object_id),
          result_snapshot: args.data.result_snapshot as Prisma.JsonValue,
          created_at: new Date(args.data.created_at as Date),
          expires_at: new Date(args.data.expires_at as Date),
        };

        table.set(compositeKey, newRow);
        return { ...newRow };
      },

      deleteMany: async (args: {
        where: { expires_at: { lt: Date } };
      }): Promise<{ count: number }> => {
        const cutoff = args.where.expires_at.lt.getTime();
        let deleted = 0;
        for (const [key, record] of Array.from(table.entries())) {
          if (record.expires_at.getTime() < cutoff) {
            table.delete(key);
            deleted++;
          }
        }
        return { count: deleted };
      },
    },
  };

  const mockPrismaService = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      // Create snapshot for atomic rollback simulation
      const snapshot = new Map(table);
      try {
        return await fn(mockClient);
      } catch (err) {
        // Rollback state on error
        table.clear();
        for (const [k, v] of snapshot.entries()) {
          table.set(k, v);
        }
        throw err;
      }
    },
  } as unknown as PrismaService;

  const txRunner = new PrismaTransactionRunner(mockPrismaService);
  const idempotencyRepo = new PrismaIdempotencyRecordRepository(txRunner);

  async function executeHttpMutation<TResult, TState = TradingCurrentStateDto>(
    req: HttpRequestSimulation,
    onMutate: (tx: TransactionContext) => Promise<{ result: TResult; currentState: TState }>,
    getCurrentState: (tx: TransactionContext) => Promise<TState>,
  ): Promise<HttpResponseSimulation<TResult>> {
    const rawHeader =
      req.headers['x-idempotency-key'] ??
      req.headers['X-Idempotency-Key'] ??
      req.headers['X-IDEMPOTENCY-KEY'];

    if (!isValidUuidV4(rawHeader)) {
      const problem = formatRfc9457Problem(
        new InvalidTradingInputError('Header X-Idempotency-Key must be a valid RFC 4122 UUID v4.', {
          field: 'headers.x-idempotency-key',
        }),
      );
      return {
        status: 400,
        headers: { 'content-type': 'application/problem+json' },
        body: problem,
      };
    }

    const idempotencyKey = rawHeader!.trim().toLowerCase();
    const fingerprint = computeCanonicalFingerprint(req.body);
    const scopeKey = {
      account_id: req.accountId,
      action: req.action,
      object_type: req.objectType,
      object_id: req.objectId,
      idempotency_key: idempotencyKey,
    };

    try {
      return await txRunner.run(async (tx) => {
        // 1. Check existing idempotency record
        const existing = await idempotencyRepo.findByScope(scopeKey, tx);

        if (existing) {
          // Verify fingerprint
          TradingIdempotencyPolicy.assertFingerprintMatches(
            existing.request_fingerprint,
            fingerprint,
          );

          // Fingerprint matched: SAFE REPLAY with current_state
          const freshCurrentState = await getCurrentState(tx);
          const isDelete = req.method?.toUpperCase() === 'DELETE' || req.action.includes('delete');

          return {
            status: isDelete ? 204 : 200,
            headers: { 'content-type': 'application/json' },
            body: isDelete
              ? null
              : {
                  success: true,
                  data: existing.result_snapshot as TResult,
                  operation: {
                    id: existing.id,
                    replayed: true,
                    committed_at: dateToInstant(existing.created_at, 'operation.committed_at'),
                    current_state: freshCurrentState,
                  },
                },
          };
        }

        // 2. Fresh execution: invoke business mutation inside transaction
        const { result, currentState } = await onMutate(tx);

        const createdAt = baseClock;
        const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);

        // 3. Persist IdempotencyRecord atomically within the same transaction
        const saved = await idempotencyRepo.save(
          {
            ...scopeKey,
            request_fingerprint: fingerprint,
            result_snapshot: (result as object) ?? {},
            created_at: createdAt,
            expires_at: expiresAt,
          },
          tx,
        );

        const isDelete = req.method?.toUpperCase() === 'DELETE' || req.action.includes('delete');
        return {
          status: isDelete ? 204 : 200,
          headers: { 'content-type': 'application/json' },
          body: isDelete
            ? null
            : {
                success: true,
                data: result,
                operation: {
                  id: saved.id,
                  replayed: false,
                  committed_at: dateToInstant(saved.created_at, 'operation.committed_at'),
                  current_state: currentState,
                },
              },
        };
      });
    } catch (err: unknown) {
      const problem = formatRfc9457Problem(err);
      const httpStatus = problem && 'status' in problem ? problem.status : 500;
      return {
        status: httpStatus,
        headers: { 'content-type': 'application/problem+json' },
        body: problem,
      };
    }
  }

  return {
    txRunner,
    idempotencyRepo,
    executeHttpMutation,
    countStoredRecords: () => table.size,
    getStoredRecord: (scope) => {
      const compositeKey = makeKey(
        BigInt(scope.accountId),
        scope.action,
        scope.objectType,
        BigInt(scope.objectId),
        scope.key,
      );
      return table.get(compositeKey);
    },
    cleanupExpired: async (cutoff: Date) => {
      return txRunner.run((tx) => idempotencyRepo.deleteExpiredBefore(cutoff, tx));
    },
    simulateP2002RaceOnNextCreate: (winningRow) => {
      triggerP2002Next = winningRow;
    },
  };
}

// ============================================================================
// Domain Entity Builders (QuoteRequest, Recipient, Quote, Proposal, Allocation)
// ============================================================================

const BASE_NOW = new Date('2026-11-11T08:00:00.000Z');
const BIDDING_DEADLINE = new Date('2026-11-13T08:00:00.000Z');
const DELIVERY_DEADLINE = new Date('2026-11-20T08:00:00.000Z');
const BID_ACCEPT_DEADLINE = new Date('2026-11-14T10:00:00.000Z');
const COMMITTED_DELIVERY = new Date('2026-11-18T08:00:00.000Z');

function buildSentRequest(overrides: Partial<Parameters<typeof QuoteRequest.reconstitute>[0]> = {}): QuoteRequest {
  return QuoteRequest.reconstitute({
    id: '100',
    buyer_id: '10',
    category_id: '1',
    spec: 'Bộ ấm chén men lam vẽ tay',
    quantity: 100,
    unit: 'set',
    unit_set_description: '1 ấm + 6 chén + 7 đĩa',
    status: 'sent_to_artisans',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội',
    delivery_address: '10 Hàng Gai',
    recipient_name: 'Nguyễn Văn Mua',
    recipient_phone: '0912345678',
    bidding_deadline: BIDDING_DEADLINE,
    delivery_deadline: DELIVERY_DEADLINE,
    bidding_closed_at: null,
    split_requested_at: null,
    version: 1,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: BASE_NOW,
    updated_at: BASE_NOW,
    ...overrides,
  });
}

function buildRecipient(overrides: Partial<Parameters<typeof RequestRecipient.reconstitute>[0]> = {}): RequestRecipient {
  return RequestRecipient.reconstitute({
    id: '300',
    request_id: '100',
    workshop_id: '201',
    response_status: 'pending',
    decline_reason: null,
    responded_by: null,
    responded_at: null,
    sent_at: BASE_NOW,
    version: 1,
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
        quote_id: '401',
        workshop_id: '201',
        allocated_quantity: 60,
        quote_version: 1,
      },
      {
        id: '602',
        proposal_id: '501',
        request_id: '100',
        quote_id: '402',
        workshop_id: '202',
        allocated_quantity: 40,
        quote_version: 1,
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
    status: 'not_started',
    version: 1,
    started_at: null,
    started_by: null,
    handed_over_at: null,
    handed_over_by: null,
    delivery_note: null,
    admin_handed_over: false,
    admin_delivery_evidence: null,
    admin_handover_reason: null,
    admin_handover_actual_at: null,
    created_at: BASE_NOW,
    updated_at: BASE_NOW,
    batch_links: [],
    ...overrides,
  });
}

// ============================================================================
// Comprehensive E2E Test Suite (Tiers 1, 2, 3, 4)
// ============================================================================

describe('Trading Idempotency & Optimistic Concurrency E2E Test Suite', () => {
  // --------------------------------------------------------------------------
  // Tier 1: Feature Coverage (≥5 per feature)
  // --------------------------------------------------------------------------
  describe('Tier 1: Feature Coverage', () => {
    describe('Feature 1: X-Idempotency-Key UUID v4 Validation (≥5 tests)', () => {
      it('F1-1: accepts standard lowercase UUID v4', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const res = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': 'c0a80101-0000-4000-8000-000000000001' },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { expected_request_version: 1 },
          },
          async () => ({ result: { ok: true }, currentState: { status: 'accepted' } as any }),
          async () => ({ status: 'accepted' } as any),
        );
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, operation: { replayed: false } });
      });

      it('F1-2: accepts uppercase UUID v4 and normalizes safely', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const res = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': 'A0B1C2D3-E4F5-4A6B-8C7D-9E0F1A2B3C4D' },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { expected_request_version: 1 },
          },
          async () => ({ result: { ok: true }, currentState: { status: 'accepted' } as any }),
          async () => ({ status: 'accepted' } as any),
        );
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, operation: { replayed: false } });
      });

      it('F1-3: rejects missing X-Idempotency-Key with 400 INVALID_INPUT', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const res = await harness.executeHttpMutation(
          {
            headers: {},
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: {},
          },
          async () => ({ result: { ok: true }, currentState: {} as any }),
          async () => ({} as any),
        );
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
          code: 'INVALID_INPUT',
          status: 400,
          type: 'urn:vcraft:problem:INVALID_INPUT',
        });
      });

      it('F1-4: rejects UUID with non-v4 version (e.g. UUID v1) with 400 INVALID_INPUT', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const res = await harness.executeHttpMutation(
          {
            // Note version character is 1 instead of 4
            headers: { 'X-Idempotency-Key': '6ba7b810-9dad-11d1-80b4-00c04fd430c8' },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: {},
          },
          async () => ({ result: { ok: true }, currentState: {} as any }),
          async () => ({} as any),
        );
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'INVALID_INPUT' });
      });

      it('F1-5: rejects malformed/arbitrary non-UUID string with 400 INVALID_INPUT', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const res = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': 'not-a-valid-uuid-v4' },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: {},
          },
          async () => ({ result: { ok: true }, currentState: {} as any }),
          async () => ({} as any),
        );
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'INVALID_INPUT' });
      });

      it('F1-6: rejects blank or empty string header with 400 INVALID_INPUT', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const res = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': '   ' },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: {},
          },
          async () => ({ result: { ok: true }, currentState: {} as any }),
          async () => ({} as any),
        );
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'INVALID_INPUT' });
      });
    });

    describe('Feature 2: Canonical SHA-256 Fingerprint Computation (≥5 tests)', () => {
      it('F2-1: generates identical fingerprint regardless of top-level key order', () => {
        const p1 = { b: 2, a: 1, c: 'hello' };
        const p2 = { c: 'hello', a: 1, b: 2 };
        expect(computeCanonicalFingerprint(p1)).toBe(computeCanonicalFingerprint(p2));
      });

      it('F2-2: generates identical fingerprint regardless of nested object key order', () => {
        const p1 = { meta: { y: 20, x: 10 }, name: 'Item' };
        const p2 = { name: 'Item', meta: { x: 10, y: 20 } };
        expect(computeCanonicalFingerprint(p1)).toBe(computeCanonicalFingerprint(p2));
      });

      it('F2-3: preserves array element ordering strictly', () => {
        const p1 = { items: [1, 2, 3] };
        const p2 = { items: [3, 2, 1] };
        expect(computeCanonicalFingerprint(p1)).not.toBe(computeCanonicalFingerprint(p2));
      });

      it('F2-4: changes fingerprint when any expected_*_version value changes', () => {
        const p1 = { expected_request_version: 1, expected_quote_version: 2 };
        const p2 = { expected_request_version: 2, expected_quote_version: 2 };
        expect(computeCanonicalFingerprint(p1)).not.toBe(computeCanonicalFingerprint(p2));
      });

      it('F2-5: consistently hashes null and empty objects to valid 64-char hex strings', () => {
        const fpEmpty = computeCanonicalFingerprint({});
        const fpNull = computeCanonicalFingerprint(null);
        expect(fpEmpty).toHaveLength(64);
        expect(fpNull).toHaveLength(64);
        expect(fpEmpty).toBe(fpNull); // canonicalize handles null payload consistently as empty
      });

      it('F2-6: produces different fingerprints for different primitive types with same string form', () => {
        const p1 = { val: 123 };
        const p2 = { val: '123' };
        expect(computeCanonicalFingerprint(p1)).not.toBe(computeCanonicalFingerprint(p2));
      });
    });

    describe('Feature 3: 5-Part Scope Key Isolation (≥5 tests)', () => {
      const KEY = 'c0a80101-0000-4000-8000-000000000003';

      it('F3-1: provides cross-account isolation (different account_id with same key does not collide)', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const resA = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { foo: 'bar' },
          },
          async () => ({ result: { from: 'account-10' }, currentState: {} as any }),
          async () => ({} as any),
        );
        const resB = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '20', // different account
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { foo: 'bar' },
          },
          async () => ({ result: { from: 'account-20' }, currentState: {} as any }),
          async () => ({} as any),
        );
        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);
        expect((resA.body as any).data.from).toBe('account-10');
        expect((resB.body as any).data.from).toBe('account-20');
        expect(harness.countStoredRecords()).toBe(2);
      });

      it('F3-2: provides action isolation (different action on same object with same key does not collide)', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const res1 = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: {},
          },
          async () => ({ result: { act: 'accept' }, currentState: {} as any }),
          async () => ({} as any),
        );
        const res2 = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'cancel_request', // different action
            objectType: 'QuoteRequest',
            objectId: '100',
            body: {},
          },
          async () => ({ result: { act: 'cancel' }, currentState: {} as any }),
          async () => ({} as any),
        );
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect(harness.countStoredRecords()).toBe(2);
      });

      it('F3-3: provides object_type isolation', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const res1 = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'update_progress',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: {},
          },
          async () => ({ result: { type: 'request' }, currentState: {} as any }),
          async () => ({} as any),
        );
        const res2 = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'update_progress',
            objectType: 'Allocation', // different object_type
            objectId: '100',
            body: {},
          },
          async () => ({ result: { type: 'allocation' }, currentState: {} as any }),
          async () => ({} as any),
        );
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect(harness.countStoredRecords()).toBe(2);
      });

      it('F3-4: provides object_id isolation', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const res1 = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: {},
          },
          async () => ({ result: { id: '100' }, currentState: {} as any }),
          async () => ({} as any),
        );
        const res2 = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '200', // different object_id
            body: {},
          },
          async () => ({ result: { id: '200' }, currentState: {} as any }),
          async () => ({} as any),
        );
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect(harness.countStoredRecords()).toBe(2);
      });

      it('F3-5: exact 5-part match triggers idempotent replay', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const mutateSpy = vi.fn().mockResolvedValue({
          result: { direct: 'result-data' },
          currentState: { status: 'sent' },
        });

        const req = {
          headers: { 'X-Idempotency-Key': KEY },
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { param: 'fixed' },
        };

        const res1 = await harness.executeHttpMutation(req, mutateSpy, async () => ({ status: 'sent' }));
        const res2 = await harness.executeHttpMutation(req, mutateSpy, async () => ({ status: 'sent' }));

        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect((res1.body as any).operation.replayed).toBe(false);
        expect((res2.body as any).operation.replayed).toBe(true);
        expect(mutateSpy).toHaveBeenCalledTimes(1); // not re-executed
      });
    });

    describe('Feature 4: Safe Replay with Current State (≥5 tests)', () => {
      const KEY = 'c0a80101-0000-4000-8000-000000000004';

      it('F4-1: returns cached snapshot data exactly as persisted', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const req = {
          headers: { 'X-Idempotency-Key': KEY },
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 1 },
        };

        await harness.executeHttpMutation(
          req,
          async () => ({ result: { allocation_id: '701', total_amount: 15000000 }, currentState: { status: 'buyer_accepted', version: 2 } }),
          async () => ({ status: 'buyer_accepted', version: 2 }),
        );

        const replayRes = await harness.executeHttpMutation(
          req,
          async () => {
            throw new Error('Must not be invoked on replay');
          },
          async () => ({ status: 'in_production', version: 3 }),
        );

        expect(replayRes.status).toBe(200);
        expect((replayRes.body as any).data).toEqual({ allocation_id: '701', total_amount: 15000000 });
      });

      it('F4-2: populates operation.replayed = true on subsequent request', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const req = {
          headers: { 'X-Idempotency-Key': KEY },
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: {},
        };

        const first = await harness.executeHttpMutation(
          req,
          async () => ({ result: { ok: 1 }, currentState: {} }),
          async () => ({}),
        );
        const second = await harness.executeHttpMutation(
          req,
          async () => ({ result: { ok: 1 }, currentState: {} }),
          async () => ({}),
        );

        expect((first.body as any).operation.replayed).toBe(false);
        expect((second.body as any).operation.replayed).toBe(true);
      });

      it('F4-3: returns fresh current_state reflecting subsequent DB state changes', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const req = {
          headers: { 'X-Idempotency-Key': KEY },
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: {},
        };

        // First call: current_state was version 2, buyer_accepted
        await harness.executeHttpMutation(
          req,
          async () => ({ result: { done: true }, currentState: { status: 'buyer_accepted', version: 2 } }),
          async () => ({ status: 'buyer_accepted', version: 2 }),
        );

        // Later, entity moved to in_production, version 4
        const replay = await harness.executeHttpMutation(
          req,
          async () => ({ result: { done: true }, currentState: {} }),
          async () => ({ status: 'in_production', version: 4 }),
        );

        expect((replay.body as any).operation.current_state).toEqual({
          status: 'in_production',
          version: 4,
        });
      });

      it('F4-4: does not require the old expected version to still be current on replay', async () => {
        const harness = createInMemoryTradingE2EHarness();
        // Client retries request with expected_request_version: 1 after entity is at version 5
        const req = {
          headers: { 'X-Idempotency-Key': KEY },
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 1 },
        };

        await harness.executeHttpMutation(
          req,
          async () => ({ result: { accepted: true }, currentState: { version: 2 } }),
          async () => ({ version: 2 }),
        );

        // Replay: even though entity is now at version 5, replay succeeds with cached data!
        const replay = await harness.executeHttpMutation(
          req,
          async () => ({ result: { accepted: true }, currentState: {} }),
          async () => ({ version: 5, status: 'delivered' }),
        );

        expect(replay.status).toBe(200);
        expect((replay.body as any).operation.replayed).toBe(true);
      });

      it('F4-5: preserves original committed_at timestamp across replays', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const req = {
          headers: { 'X-Idempotency-Key': KEY },
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: {},
        };

        const first = await harness.executeHttpMutation(
          req,
          async () => ({ result: { id: 1 }, currentState: {} }),
          async () => ({}),
        );
        const second = await harness.executeHttpMutation(
          req,
          async () => ({ result: { id: 1 }, currentState: {} }),
          async () => ({}),
        );

        const t1 = (first.body as any).operation.committed_at;
        const t2 = (second.body as any).operation.committed_at;
        expect(t1).toBe(t2);
      });
    });

    describe('Feature 5: Payload Mismatch 409 Conflict (≥5 tests)', () => {
      const KEY = 'c0a80101-0000-4000-8000-000000000005';

      it('F5-1: returns 409 IDEMPOTENCY_CONFLICT when payload body parameter changes', async () => {
        const harness = createInMemoryTradingE2EHarness();
        // First request: quantity = 50
        await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { quantity: 50 },
          },
          async () => ({ result: { ok: true }, currentState: {} }),
          async () => ({}),
        );

        // Replay with different quantity = 100
        const conflictRes = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { quantity: 100 },
          },
          async () => ({ result: { ok: true }, currentState: {} }),
          async () => ({}),
        );

        expect(conflictRes.status).toBe(409);
        expect(conflictRes.body).toMatchObject({
          code: 'IDEMPOTENCY_CONFLICT',
          status: 409,
          type: 'urn:vcraft:problem:IDEMPOTENCY_CONFLICT',
        });
      });

      it('F5-2: returns 409 when expected_version changes under same key', async () => {
        const harness = createInMemoryTradingE2EHarness();
        await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { expected_request_version: 1 },
          },
          async () => ({ result: { ok: true }, currentState: {} }),
          async () => ({}),
        );

        const conflictRes = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { expected_request_version: 2 },
          },
          async () => ({ result: { ok: true }, currentState: {} }),
          async () => ({}),
        );

        expect(conflictRes.status).toBe(409);
        expect(conflictRes.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      });

      it('F5-3: returns 409 when an extra field is added to replay body', async () => {
        const harness = createInMemoryTradingE2EHarness();
        await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { note: 'first' },
          },
          async () => ({ result: { ok: true }, currentState: {} }),
          async () => ({}),
        );

        const conflictRes = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { note: 'first', extra: 'added' },
          },
          async () => ({ result: { ok: true }, currentState: {} }),
          async () => ({}),
        );

        expect(conflictRes.status).toBe(409);
        expect(conflictRes.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      });

      it('F5-4: returns 409 when a field is removed from replay body', async () => {
        const harness = createInMemoryTradingE2EHarness();
        await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { a: 1, b: 2 },
          },
          async () => ({ result: { ok: true }, currentState: {} }),
          async () => ({}),
        );

        const conflictRes = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { a: 1 }, // b removed
          },
          async () => ({ result: { ok: true }, currentState: {} }),
          async () => ({}),
        );

        expect(conflictRes.status).toBe(409);
        expect(conflictRes.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      });

      it('F5-5: does NOT execute the mutation callback when payload conflict is detected', async () => {
        const harness = createInMemoryTradingE2EHarness();
        await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { val: 'orig' },
          },
          async () => ({ result: { ok: true }, currentState: {} }),
          async () => ({}),
        );

        const callbackSpy = vi.fn();
        await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { val: 'different' },
          },
          callbackSpy,
          async () => ({}),
        );

        expect(callbackSpy).not.toHaveBeenCalled();
      });
    });

    describe('Feature 6: Single-Transaction Atomic Commit & Rollback (≥5 tests)', () => {
      const KEY = 'c0a80101-0000-4000-8000-000000000006';

      it('F6-1: commits IdempotencyRecord when business operation succeeds', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const res = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: {},
          },
          async () => ({ result: { ok: true }, currentState: {} }),
          async () => ({}),
        );
        expect(res.status).toBe(200);
        expect(harness.countStoredRecords()).toBe(1);
      });

      it('F6-2: rolls back IdempotencyRecord if domain invariant throws inside transaction', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const res = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: {},
          },
          async () => {
            throw new InvalidStateTransitionError('Cannot accept non-bidding request');
          },
          async () => ({}),
        );
        expect(res.status).toBe(422);
        expect(harness.countStoredRecords()).toBe(0); // Not committed!
      });

      it('F6-3: rolls back IdempotencyRecord if concurrency conflict occurs', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const reqEntity = buildSentRequest({ version: 2 });

        const res = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { expected_request_version: 1 },
          },
          async () => {
            reqEntity.assertVersionMatches(1); // will throw ConcurrencyConflictError
            return { result: { ok: true }, currentState: {} };
          },
          async () => ({}),
        );

        expect(res.status).toBe(409);
        expect(harness.countStoredRecords()).toBe(0);
      });

      it('F6-4: allows subsequent retry with same key after earlier transaction rollback', async () => {
        const harness = createInMemoryTradingE2EHarness();
        // First try fails due to transient domain constraint
        let shouldFail = true;
        const mutateFn = async () => {
          if (shouldFail) {
            throw new InvalidTradingInputError('Transient validation error');
          }
          return { result: { success: true }, currentState: {} };
        };

        const failedRes = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { attempt: 1 },
          },
          mutateFn,
          async () => ({}),
        );
        expect(failedRes.status).toBe(400);
        expect(harness.countStoredRecords()).toBe(0);

        // Client fixes condition and retries with same key
        shouldFail = false;
        const retryRes = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { attempt: 1 },
          },
          mutateFn,
          async () => ({}),
        );
        expect(retryRes.status).toBe(200);
        expect((retryRes.body as any).operation.replayed).toBe(false);
        expect(harness.countStoredRecords()).toBe(1);
      });

      it('F6-5: rolls back IdempotencyRecord on unexpected runtime error', async () => {
        const harness = createInMemoryTradingE2EHarness();
        const res = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': KEY },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: {},
          },
          async () => {
            throw new Error('Database connection reset during commit');
          },
          async () => ({}),
        );
        expect(res.status).toBe(500);
        expect(harness.countStoredRecords()).toBe(0);
      });
    });

    describe('Feature 7: 24-hour TTL Record Expiration & Cleanup (≥5 tests)', () => {
      it('F7-1: calculates expires_at exactly 24 hours after created_at', async () => {
        const clock = new Date('2026-11-11T08:00:00.000Z');
        const harness = createInMemoryTradingE2EHarness(clock);
        const key = 'c0a80101-0000-4000-8000-000000000007';

        await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': key },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: {},
          },
          async () => ({ result: { ok: true }, currentState: {} }),
          async () => ({}),
        );

        const stored = harness.getStoredRecord({
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          key,
        });

        expect(stored).toBeDefined();
        const diffMs = stored!.expires_at.getTime() - stored!.created_at.getTime();
        expect(diffMs).toBe(24 * 60 * 60 * 1000);
      });

      it('F7-2: purges records where expires_at < cutoff', async () => {
        const clock = new Date('2026-11-11T08:00:00.000Z');
        const harness = createInMemoryTradingE2EHarness(clock);
        const key = 'c0a80101-0000-4000-8000-000000000007';

        await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': key },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: {},
          },
          async () => ({ result: { ok: true }, currentState: {} }),
          async () => ({}),
        );

        // 25 hours later
        const cutoff = new Date('2026-11-12T09:00:00.000Z');
        const deleted = await harness.cleanupExpired(cutoff);
        expect(deleted).toBe(1);
        expect(harness.countStoredRecords()).toBe(0);
      });

      it('F7-3: retains records where expires_at >= cutoff', async () => {
        const clock = new Date('2026-11-11T08:00:00.000Z');
        const harness = createInMemoryTradingE2EHarness(clock);
        const key = 'c0a80101-0000-4000-8000-000000000007';

        await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': key },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: {},
          },
          async () => ({ result: { ok: true }, currentState: {} }),
          async () => ({}),
        );

        // 12 hours later (still active)
        const cutoff = new Date('2026-11-11T20:00:00.000Z');
        const deleted = await harness.cleanupExpired(cutoff);
        expect(deleted).toBe(0);
        expect(harness.countStoredRecords()).toBe(1);
      });

      it('F7-4: accurately discriminates expired vs active records in batch cleanup', async () => {
        const clockEarly = new Date('2026-11-11T08:00:00.000Z');
        const harness = createInMemoryTradingE2EHarness(clockEarly);

        // Record 1 at 08:00
        await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': 'c0a80101-0000-4000-8000-000000000001' },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: {},
          },
          async () => ({ result: { r: 1 }, currentState: {} }),
          async () => ({}),
        );

        // Record 2 at 18:00 (10h later)
        const clockLate = new Date('2026-11-11T18:00:00.000Z');
        await harness.txRunner.run((tx) =>
          harness.idempotencyRepo.save(
            {
              account_id: '10',
              action: 'accept_quote',
              object_type: 'QuoteRequest',
              object_id: '101',
              idempotency_key: 'c0a80101-0000-4000-8000-000000000002',
              request_fingerprint: 'fp-2',
              result_snapshot: {},
              created_at: clockLate,
              expires_at: new Date(clockLate.getTime() + 24 * 60 * 60 * 1000), // expires 12th 18:00
            },
            tx,
          ),
        );

        expect(harness.countStoredRecords()).toBe(2);

        // Cutoff at 12th 12:00: Record 1 (expired 08:00) is purged, Record 2 (expires 18:00) is kept
        const cutoff = new Date('2026-11-12T12:00:00.000Z');
        const deleted = await harness.cleanupExpired(cutoff);
        expect(deleted).toBe(1);
        expect(harness.countStoredRecords()).toBe(1);
      });

      it('F7-5: after TTL cleanup, re-submitting same key behaves as fresh transaction', async () => {
        const clock = new Date('2026-11-11T08:00:00.000Z');
        const harness = createInMemoryTradingE2EHarness(clock);
        const key = 'c0a80101-0000-4000-8000-000000000007';

        await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': key },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { val: 1 },
          },
          async () => ({ result: { val: 1 }, currentState: {} }),
          async () => ({}),
        );

        // Expire and purge
        await harness.cleanupExpired(new Date('2026-11-12T09:00:00.000Z'));

        // Client sends request again with same key
        const freshRes = await harness.executeHttpMutation(
          {
            headers: { 'X-Idempotency-Key': key },
            accountId: '10',
            action: 'accept_quote',
            objectType: 'QuoteRequest',
            objectId: '100',
            body: { val: 1 },
          },
          async () => ({ result: { val: 'new-run' }, currentState: {} }),
          async () => ({}),
        );

        expect(freshRes.status).toBe(200);
        expect((freshRes.body as any).operation.replayed).toBe(false);
      });
    });

    describe('Feature 8: Optimistic Concurrency on QuoteRequest (≥5 tests)', () => {
      it('F8-1: accepts mutation when expected_request_version matches current version', () => {
        const req = buildSentRequest({ version: 1 });
        expect(() => req.assertVersionMatches(1)).not.toThrow();
      });

      it('F8-2: increments QuoteRequest version on successful contact edit', () => {
        const req = buildSentRequest({ version: 1 });
        const { request: updated } = req.updateRecipientContact({
          buyerId: '10',
          expectedVersion: 1,
          recipientName: 'Trần Văn Nhận',
          recipientPhone: '0988776655',
          now: BASE_NOW,
        });
        expect(updated.version).toBe(2);
      });

      it('F8-3: throws 409 CONCURRENCY_CONFLICT when expected_request_version is stale', () => {
        const req = buildSentRequest({ version: 2 });
        expect(() => req.assertVersionMatches(1)).toThrow(ConcurrencyConflictError);
      });

      it('F8-4: throws 409 CONCURRENCY_CONFLICT when expected_request_version is ahead/future', () => {
        const req = buildSentRequest({ version: 2 });
        expect(() => req.assertVersionMatches(99)).toThrow(ConcurrencyConflictError);
      });

      it('F8-5: preserves unmodified request state when concurrency conflict occurs', () => {
        const req = buildSentRequest({ version: 2, recipient_name: 'Nguyễn Văn Mua' });
        try {
          req.updateRecipientContact({
            buyerId: '10',
            expectedVersion: 1, // stale
            recipientName: 'Changed Name',
            recipientPhone: '0900000000',
            now: BASE_NOW,
          });
        } catch {
          // expected
        }
        expect(req.version).toBe(2);
        expect(req.recipient_name).toBe('Nguyễn Văn Mua');
      });
    });

    describe('Feature 9: Optimistic Concurrency on RequestRecipient (≥5 tests)', () => {
      it('F9-1: accepts artisan decline when expected_recipient_version matches', () => {
        const recipient = buildRecipient({ version: 1 });
        const { recipient: updated } = recipient.decline({
          actorId: '21',
          expectedVersion: 1,
          reason: 'Xưởng đã kín lịch sản xuất',
          requestBiddingOpen: true,
          requestAcceptedOrCancelled: false,
          now: BASE_NOW,
        });
        expect(updated.version).toBe(2);
        expect(updated.response_status).toBe('declined');
      });

      it('F9-2: throws 409 CONCURRENCY_CONFLICT when expected_recipient_version is stale', () => {
        const recipient = buildRecipient({ version: 2 });
        expect(() =>
          recipient.decline({
            actorId: '21',
            expectedVersion: 1, // stale
            reason: 'Xưởng bận',
            requestBiddingOpen: true,
            requestAcceptedOrCancelled: false,
            now: BASE_NOW,
          }),
        ).toThrow(ConcurrencyConflictError);
      });

      it('F9-3: increments version on quote submission', () => {
        const recipient = buildRecipient({ version: 1 });
        const { recipient: updated } = recipient.markQuoted({
          actorId: '21',
          quoteId: '401',
          quoteSnapshot: {
            unit_price: 150000,
            max_quantity: 100,
            bid_accept_deadline: BID_ACCEPT_DEADLINE,
            committed_delivery_at: COMMITTED_DELIVERY,
            status: 'active',
            version: 1,
          },
          now: BASE_NOW,
        });
        expect(updated.version).toBe(2);
        expect(updated.response_status).toBe('quoted');
      });

      it('F9-4: throws 409 on future expected_recipient_version', () => {
        const recipient = buildRecipient({ version: 1 });
        expect(() => recipient.assertVersionMatches(10)).toThrow(ConcurrencyConflictError);
      });

      it('F9-5: preserves recipient status when concurrency conflict occurs', () => {
        const recipient = buildRecipient({ version: 2, response_status: 'pending' });
        try {
          recipient.decline({
            actorId: '21',
            expectedVersion: 1,
            reason: 'Fail',
            requestBiddingOpen: true,
            requestAcceptedOrCancelled: false,
            now: BASE_NOW,
          });
        } catch {
          // expected
        }
        expect(recipient.response_status).toBe('pending');
        expect(recipient.version).toBe(2);
      });
    });

    describe('Feature 10: Optimistic Concurrency on Quote (≥5 tests)', () => {
      it('F10-1: initial quote submission accepts null expected_quote_version and sets version 1', () => {
        const req = buildSentRequest();
        const recipient = buildRecipient();
        const { quote } = Quote.submitNew({
          id: '401',
          request: req,
          recipient,
          actorId: '21',
          workshopIsActive: true,
          unitPrice: 150000,
          maxQuantity: 100,
          bidAcceptDeadline: BID_ACCEPT_DEADLINE,
          committedDeliveryAt: COMMITTED_DELIVERY,
          now: BASE_NOW,
        });
        expect(quote.version).toBe(1);
      });

      it('F10-2: updating quote with matching expected_quote_version increments version', () => {
        const quote = buildQuote({ version: 1 });
        const req = buildSentRequest();
        const recipient = buildRecipient({ version: 2, response_status: 'quoted' });

        const { quote: updated } = quote.updateOrResubmit({
          request: req,
          recipient,
          actorId: '21',
          workshopIsActive: true,
          expectedQuoteVersion: 1,
          unitPrice: 160000,
          maxQuantity: 100,
          bidAcceptDeadline: BID_ACCEPT_DEADLINE,
          committedDeliveryAt: COMMITTED_DELIVERY,
          now: BASE_NOW,
        });
        expect(updated.version).toBe(2);
        expect(updated.unit_price).toBe(160000);
      });

      it('F10-3: withdrawing quote with matching expected_quote_version increments version', () => {
        const quote = buildQuote({ version: 1 });
        const req = buildSentRequest();
        const recipient = buildRecipient({ version: 2, response_status: 'quoted' });

        const { quote: withdrawn } = quote.withdraw({
          request: req,
          recipient,
          actorId: '21',
          expectedQuoteVersion: 1,
          withdrawReason: 'Hết nguyên liệu men lam',
          now: BASE_NOW,
        });
        expect(withdrawn.version).toBe(2);
        expect(withdrawn.status).toBe('withdrawn');
      });

      it('F10-4: throws 409 CONCURRENCY_CONFLICT on update with stale expected_quote_version', () => {
        const quote = buildQuote({ version: 2 });
        const req = buildSentRequest();
        const recipient = buildRecipient({ version: 2 });

        expect(() =>
          quote.updateOrResubmit({
            request: req,
            recipient,
            actorId: '21',
            workshopIsActive: true,
            expectedQuoteVersion: 1, // stale
            unitPrice: 170000,
            maxQuantity: 100,
            bidAcceptDeadline: BID_ACCEPT_DEADLINE,
            committedDeliveryAt: COMMITTED_DELIVERY,
            now: BASE_NOW,
          }),
        ).toThrow(ConcurrencyConflictError);
      });

      it('F10-5: throws 409 CONCURRENCY_CONFLICT on withdraw with stale expected_quote_version', () => {
        const quote = buildQuote({ version: 2 });
        const req = buildSentRequest();
        const recipient = buildRecipient({ version: 2 });

        expect(() =>
          quote.withdraw({
            request: req,
            recipient,
            actorId: '21',
            expectedQuoteVersion: 1, // stale
            withdrawReason: 'Lý do',
            now: BASE_NOW,
          }),
        ).toThrow(ConcurrencyConflictError);
      });
    });

    describe('Feature 11: Optimistic Concurrency on SplitProposal (≥5 tests)', () => {
      const closedDeadline = new Date(BASE_NOW.getTime() - 1000);

      it('F11-1: proposes split with matching request version and increments proposal version', () => {
        const req = buildSentRequest({
          version: 3,
          status: 'artisans_bidding',
          bidding_deadline: closedDeadline,
          bidding_closed_at: BASE_NOW,
          split_requested_at: BASE_NOW,
        });
        const q1 = buildQuote({ id: '401', workshop_id: '201', max_quantity: 60, version: 1 });
        const q2 = buildQuote({ id: '402', workshop_id: '202', max_quantity: 40, version: 1 });

        const { proposal } = SplitProposal.propose({
          id: '501',
          request: req,
          expectedRequestVersion: 3,
          adminId: '999',
          proposalExpectation: { expected_proposal_id: null, expected_proposal_version: null },
          currentProposedProposal: null,
          candidates: [
            { itemId: '601', workshop_id: '201', quote_id: '401', expected_quote_version: 1, allocated_quantity: 60, quote: q1, workshopIsActive: true },
            { itemId: '602', workshop_id: '202', quote_id: '402', expected_quote_version: 1, allocated_quantity: 40, quote: q2, workshopIsActive: true },
          ],
          now: BASE_NOW,
        });

        expect(proposal.version).toBe(1);
        expect(proposal.status).toBe('proposed');
      });

      it('F11-2: throws 409 CONCURRENCY_CONFLICT when proposalExpectation mismatches', () => {
        const expectationVO = ProposalExpectationVO.of({
          expected_proposal_id: '999',
          expected_proposal_version: 1,
        });

        expect(() =>
          expectationVO.assertMatchesCurrent({ id: '501', version: 1 }),
        ).toThrow(ConcurrencyConflictError);
      });

      it('F11-3: rejects proposal when expected_request_version is stale', () => {
        const req = buildSentRequest({
          version: 4,
          status: 'artisans_bidding',
          bidding_deadline: closedDeadline,
          bidding_closed_at: BASE_NOW,
          split_requested_at: BASE_NOW,
        });
        const q1 = buildQuote({ id: '401', workshop_id: '201', max_quantity: 60, version: 1 });
        const q2 = buildQuote({ id: '402', workshop_id: '202', max_quantity: 40, version: 1 });

        expect(() =>
          SplitProposal.propose({
            id: '502',
            request: req,
            expectedRequestVersion: 2, // stale
            adminId: '999',
            proposalExpectation: { expected_proposal_id: null, expected_proposal_version: null },
            currentProposedProposal: null,
            candidates: [
              { itemId: '601', workshop_id: '201', quote_id: '401', expected_quote_version: 1, allocated_quantity: 60, quote: q1, workshopIsActive: true },
              { itemId: '602', workshop_id: '202', quote_id: '402', expected_quote_version: 1, allocated_quantity: 40, quote: q2, workshopIsActive: true },
            ],
            now: BASE_NOW,
          }),
        ).toThrow(ConcurrencyConflictError);
      });

      it('F11-4: rejects split proposal when quote version changes under proposed item', () => {
        const req = buildSentRequest({
          version: 3,
          status: 'artisans_bidding',
          bidding_deadline: closedDeadline,
          bidding_closed_at: BASE_NOW,
          split_requested_at: BASE_NOW,
        });
        const q1 = buildQuote({ id: '401', workshop_id: '201', max_quantity: 60, version: 2 }); // version 2 in DB
        const q2 = buildQuote({ id: '402', workshop_id: '202', max_quantity: 40, version: 1 });

        expect(() =>
          SplitProposal.propose({
            id: '501',
            request: req,
            expectedRequestVersion: 3,
            adminId: '999',
            proposalExpectation: { expected_proposal_id: null, expected_proposal_version: null },
            currentProposedProposal: null,
            candidates: [
              { itemId: '601', workshop_id: '201', quote_id: '401', expected_quote_version: 1, allocated_quantity: 60, quote: q1, workshopIsActive: true }, // stale expectation 1!
              { itemId: '602', workshop_id: '202', quote_id: '402', expected_quote_version: 1, allocated_quantity: 40, quote: q2, workshopIsActive: true },
            ],
            now: BASE_NOW,
          }),
        ).toThrow(ConcurrencyConflictError);
      });

      it('F11-5: rejecting proposal with stale expected_proposal_version throws 409 without expiring proposal', () => {
        const proposal = buildSplitProposal({ version: 2, status: 'proposed' });
        expect(() => proposal.assertVersionMatches(1)).toThrow(ConcurrencyConflictError);
        expect(proposal.status).toBe('proposed'); // NOT expired!
      });
    });

    describe('Feature 12: Optimistic Concurrency on Allocation (≥5 tests)', () => {
      it('F12-1: starting production with matching expected_allocation_version increments version', () => {
        const alloc = buildAllocation({ version: 1, status: 'not_started' });
        const req = buildSentRequest({ status: 'buyer_accepted' });

        const { allocation: started } = alloc.startProduction({
          request: req,
          actorId: '21',
          actorWorkshopId: '201',
          expectedVersion: 1,
          now: BASE_NOW,
        });
        expect(started.version).toBe(2);
        expect(started.status).toBe('in_production');
      });

      it('F12-2: linking batches with matching expected_allocation_version increments version', () => {
        const alloc = buildAllocation({ version: 2, status: 'in_production' });
        const req = buildSentRequest({ status: 'in_production' });

        const { allocation: updated } = alloc.replaceBatchLinks({
          request: req,
          actorId: '21',
          actorWorkshopId: '201',
          expectedVersion: 2,
          batchLinks: [{ batch_id: '901', batch_workshop_id: '201', linked_quantity: 60 }],
          now: BASE_NOW,
        });
        expect(updated.version).toBe(3);
      });

      it('F12-3: recording handover with matching expected_allocation_version increments version', () => {
        const alloc = buildAllocation({ version: 3, status: 'in_production' });
        const req = buildSentRequest({ status: 'in_production' });

        const { allocation: handedOver } = alloc.recordArtisanHandover({
          request: req,
          actorId: '21',
          actorWorkshopId: '201',
          expectedVersion: 3,
          now: BASE_NOW,
        });
        expect(handedOver.version).toBe(4);
        expect(handedOver.status).toBe('handed_over');
      });

      it('F12-4: throws 409 CONCURRENCY_CONFLICT on handover with stale expected_allocation_version', () => {
        const alloc = buildAllocation({ version: 3, status: 'in_production' });
        const req = buildSentRequest({ status: 'in_production' });

        expect(() =>
          alloc.recordArtisanHandover({
            request: req,
            actorId: '21',
            actorWorkshopId: '201',
            expectedVersion: 2, // stale!
            now: BASE_NOW,
          }),
        ).toThrow(ConcurrencyConflictError);
      });

      it('F12-5: allows independent artisan allocations on same quote request to progress without conflict', () => {
        const alloc1 = buildAllocation({ id: '701', workshop_id: '201', version: 1, status: 'not_started' });
        const alloc2 = buildAllocation({ id: '702', workshop_id: '202', version: 1, status: 'not_started' });
        const req = buildSentRequest({ status: 'buyer_accepted' });

        // Artisan 1 advances their allocation
        const { allocation: a1Started } = alloc1.startProduction({
          request: req,
          actorId: '21',
          actorWorkshopId: '201',
          expectedVersion: 1,
          now: BASE_NOW,
        });
        expect(a1Started.version).toBe(2);

        // Artisan 2 advances their allocation using their own independent expected version
        const { allocation: a2Started } = alloc2.startProduction({
          request: req,
          actorId: '22',
          actorWorkshopId: '202',
          expectedVersion: 1,
          now: BASE_NOW,
        });
        expect(a2Started.version).toBe(2);
      });
    });

    describe('Feature 13: RFC 9457 Problem Details Formatting (≥5 tests)', () => {
      it('F13-1: formats 400 INVALID_INPUT per RFC 9457 specification', () => {
        const problem = formatRfc9457Problem(new InvalidTradingInputError('Tên trường không hợp lệ'));
        expect(problem).toMatchObject({
          type: 'urn:vcraft:problem:INVALID_INPUT',
          status: 400,
          code: 'INVALID_INPUT',
          title: 'Dữ liệu không hợp lệ',
          detail: 'Tên trường không hợp lệ',
        });
        expect((problem as any).tracking_id).toBeDefined();
      });

      it('F13-2: formats 409 CONCURRENCY_CONFLICT per RFC 9457 specification', () => {
        const problem = formatRfc9457Problem(new ConcurrencyConflictError('Phiên bản yêu cầu không khớp'));
        expect(problem).toMatchObject({
          type: 'urn:vcraft:problem:CONCURRENCY_CONFLICT',
          status: 409,
          code: 'CONCURRENCY_CONFLICT',
          title: 'Xung đột dữ liệu',
        });
      });

      it('F13-3: formats 409 IDEMPOTENCY_CONFLICT per RFC 9457 specification', () => {
        const problem = formatRfc9457Problem(new IdempotencyConflictError('Key đã được gửi với payload khác'));
        expect(problem).toMatchObject({
          type: 'urn:vcraft:problem:IDEMPOTENCY_CONFLICT',
          status: 409,
          code: 'IDEMPOTENCY_CONFLICT',
        });
      });

      it('F13-4: formats 403 PERMISSION_DENIED per RFC 9457 specification', () => {
        const problem = formatRfc9457Problem(new TradingPermissionDeniedError('Bạn không có quyền thao tác'));
        expect(problem).toMatchObject({
          type: 'urn:vcraft:problem:PERMISSION_DENIED',
          status: 403,
          code: 'PERMISSION_DENIED',
        });
      });

      it('F13-5: handles generic unhandled error with safe 500 INTERNAL_SERVER_ERROR', () => {
        const problem = formatRfc9457Problem(new Error('Unexpected disk read error'));
        expect(problem).toMatchObject({
          type: 'urn:vcraft:problem:INTERNAL_SERVER_ERROR',
          status: 500,
          code: 'INTERNAL_SERVER_ERROR',
        });
      });
    });
  });

  // --------------------------------------------------------------------------
  // Tier 2: Boundary & Corner Cases (≥5 categories)
  // --------------------------------------------------------------------------
  describe('Tier 2: Boundary & Corner Cases', () => {
    it('B-1: missing X-Idempotency-Key header on mutation endpoint rejects with 400', async () => {
      const harness = createInMemoryTradingE2EHarness();
      const res = await harness.executeHttpMutation(
        {
          headers: {},
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 1 },
        },
        async () => ({ result: { ok: true }, currentState: {} }),
        async () => ({}),
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('B-2: malformed UUID (nil UUID 00000000-0000-0000-0000-000000000000) rejects with 400', async () => {
      const harness = createInMemoryTradingE2EHarness();
      const res = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': '00000000-0000-0000-0000-000000000000' },
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: {},
        },
        async () => ({ result: { ok: true }, currentState: {} }),
        async () => ({}),
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('B-3: trims leading and trailing whitespace from valid UUID v4', async () => {
      const harness = createInMemoryTradingE2EHarness();
      const res = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': '   c0a80101-0000-4000-8000-000000000099   ' },
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: {},
        },
        async () => ({ result: { ok: true }, currentState: {} }),
        async () => ({}),
      );
      expect(res.status).toBe(200);
      const stored = harness.getStoredRecord({
        accountId: '10',
        action: 'accept_quote',
        objectType: 'QuoteRequest',
        objectId: '100',
        key: 'c0a80101-0000-4000-8000-000000000099',
      });
      expect(stored).toBeDefined();
    });

    it('B-4: empty body {} vs populated body generates distinct fingerprints', () => {
      const fpEmpty = computeCanonicalFingerprint({});
      const fpPopulated = computeCanonicalFingerprint({ field: 'value' });
      expect(fpEmpty).not.toBe(fpPopulated);
    });

    it('B-5: identical idempotency key used across two distinct accounts succeeds independently', async () => {
      const harness = createInMemoryTradingE2EHarness();
      const sharedKey = 'c0a80101-0000-4000-8000-000000000088';

      const resBuyer = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': sharedKey },
          accountId: '101',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 1 },
        },
        async () => ({ result: { role: 'buyer' }, currentState: {} }),
        async () => ({}),
      );

      const resArtisan = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': sharedKey },
          accountId: '202',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 1 },
        },
        async () => ({ result: { role: 'artisan' }, currentState: {} }),
        async () => ({}),
      );

      expect(resBuyer.status).toBe(200);
      expect(resArtisan.status).toBe(200);
      expect((resBuyer.body as any).data.role).toBe('buyer');
      expect((resArtisan.body as any).data.role).toBe('artisan');
    });

    it('B-6: 204 DELETE mutation replay returns 204 with replayed: true and null body', async () => {
      const harness = createInMemoryTradingE2EHarness();
      const key = 'c0a80101-0000-4000-8000-000000000077';

      const deleteReq = {
        headers: { 'X-Idempotency-Key': key },
        accountId: '10',
        action: 'delete_draft',
        objectType: 'QuoteRequest',
        objectId: '100',
        method: 'DELETE',
        body: {},
      };

      const first = await harness.executeHttpMutation(
        deleteReq,
        async () => ({ result: null, currentState: { status: 'deleted' } }),
        async () => ({ status: 'deleted' }),
      );
      expect(first.status).toBe(204);
      expect(first.body).toBeNull();

      // Replay delete
      const replay = await harness.executeHttpMutation(
        deleteReq,
        async () => ({ result: null, currentState: {} }),
        async () => ({ status: 'deleted' }),
      );
      expect(replay.status).toBe(204);
      expect(replay.body).toBeNull();
    });

    it('B-7: exact millisecond cutoff TTL boundary discrimination', async () => {
      const clock = new Date('2026-11-11T08:00:00.000Z');
      const harness = createInMemoryTradingE2EHarness(clock);
      const key = 'c0a80101-0000-4000-8000-000000000066';

      await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': key },
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: {},
        },
        async () => ({ result: { ok: true }, currentState: {} }),
        async () => ({}),
      );

      const expiresAt = new Date('2026-11-12T08:00:00.000Z');

      // 1 ms before expiration: NOT purged
      const justBefore = new Date(expiresAt.getTime() - 1);
      const purgedBefore = await harness.cleanupExpired(justBefore);
      expect(purgedBefore).toBe(0);
      expect(harness.countStoredRecords()).toBe(1);

      // Exactly at expires_at: NOT purged because query uses `lt: cutoff`
      const purgedAt = await harness.cleanupExpired(expiresAt);
      expect(purgedAt).toBe(0);
      expect(harness.countStoredRecords()).toBe(1);

      // 1 ms after: PURGED
      const justAfter = new Date(expiresAt.getTime() + 1);
      const purgedAfter = await harness.cleanupExpired(justAfter);
      expect(purgedAfter).toBe(1);
      expect(harness.countStoredRecords()).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Tier 3: Cross-Feature Combinations
  // --------------------------------------------------------------------------
  describe('Tier 3: Cross-Feature Combinations', () => {
    it('C-1: resolves concurrent race condition with P2002 collision by safely replaying winning record', async () => {
      const harness = createInMemoryTradingE2EHarness();
      const key = 'c0a80101-0000-4000-8000-000000000010';
      const fp = computeCanonicalFingerprint({ expected_request_version: 1 });

      const winningRow: PrismaIdempotencyRecord = {
        id: 9999n,
        idempotency_key: key,
        request_fingerprint: fp,
        account_id: 10n,
        action: 'accept_quote',
        object_type: 'QuoteRequest',
        object_id: 100n,
        result_snapshot: { allocation_id: '701' },
        created_at: BASE_NOW,
        expires_at: new Date(BASE_NOW.getTime() + 24 * 60 * 60 * 1000),
      };

      // Instruct harness mock to simulate P2002 on the upcoming create
      harness.simulateP2002RaceOnNextCreate(winningRow);

      const res = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': key },
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 1 },
        },
        async () => ({ result: { allocation_id: '701' }, currentState: { status: 'buyer_accepted' } }),
        async () => ({ status: 'buyer_accepted' }),
      );

      // The P2002 catch block in PrismaIdempotencyRecordRepository should recover and return the record
      expect(res.status).toBe(200);
      expect((res.body as any).data).toEqual({ allocation_id: '701' });
    });

    it('C-2: returns 409 IDEMPOTENCY_CONFLICT when P2002 race collision has different payload', async () => {
      const harness = createInMemoryTradingE2EHarness();
      const key = 'c0a80101-0000-4000-8000-000000000011';
      const winningFp = computeCanonicalFingerprint({ expected_request_version: 1, quantity: 50 });

      const winningRow: PrismaIdempotencyRecord = {
        id: 9998n,
        idempotency_key: key,
        request_fingerprint: winningFp,
        account_id: 10n,
        action: 'accept_quote',
        object_type: 'QuoteRequest',
        object_id: 100n,
        result_snapshot: { allocation_id: '701' },
        created_at: BASE_NOW,
        expires_at: new Date(BASE_NOW.getTime() + 24 * 60 * 60 * 1000),
      };

      harness.simulateP2002RaceOnNextCreate(winningRow);

      // Competing request with DIFFERENT payload fingerprint (quantity = 100)
      const res = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': key },
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 1, quantity: 100 },
        },
        async () => ({ result: { allocation_id: '701' }, currentState: {} }),
        async () => ({}),
      );

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });

    it('C-3: stale version rejection does not create idempotency record; subsequent valid request succeeds', async () => {
      const harness = createInMemoryTradingE2EHarness();
      const keyStale = 'c0a80101-0000-4000-8000-000000000012';
      const reqEntity = buildSentRequest({ version: 2 });

      // Stale attempt
      const staleRes = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': keyStale },
          accountId: '10',
          action: 'edit_contact',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 1, recipient_name: 'New Name' },
        },
        async () => {
          reqEntity.assertVersionMatches(1); // throws ConcurrencyConflictError
          return { result: { ok: true }, currentState: {} };
        },
        async () => ({}),
      );

      expect(staleRes.status).toBe(409);
      expect(staleRes.body).toMatchObject({ code: 'CONCURRENCY_CONFLICT' });
      expect(harness.countStoredRecords()).toBe(0);

      // Client reloads fresh version 2 and repeats with fresh key
      const keyFresh = 'c0a80101-0000-4000-8000-000000000013';
      const validRes = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': keyFresh },
          accountId: '10',
          action: 'edit_contact',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 2, recipient_name: 'New Name' },
        },
        async () => {
          const { request: updated } = reqEntity.updateRecipientContact({
            buyerId: '10',
            expectedVersion: 2,
            recipientName: 'New Name',
            recipientPhone: '0912345678',
            now: BASE_NOW,
          });
          return { result: { version: updated.version }, currentState: { version: updated.version } };
        },
        async () => ({ version: 3 }),
      );

      expect(validRes.status).toBe(200);
      expect((validRes.body as any).data.version).toBe(3);
      expect(harness.countStoredRecords()).toBe(1);
    });

    it('C-4: handles multiple sequential mutations on same entity under separate keys', async () => {
      const harness = createInMemoryTradingE2EHarness();
      let reqEntity = buildSentRequest({ version: 1 });

      const k1 = 'c0a80101-0000-4000-8000-000000000014';
      const k2 = 'c0a80101-0000-4000-8000-000000000015';

      // First mutation
      const res1 = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': k1 },
          accountId: '10',
          action: 'edit_contact',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 1, name: 'A' },
        },
        async () => {
          const { request: u } = reqEntity.updateRecipientContact({
            buyerId: '10',
            expectedVersion: 1,
            recipientName: 'A',
            recipientPhone: '0901111111',
            now: BASE_NOW,
          });
          reqEntity = u;
          return { result: { version: u.version }, currentState: { version: u.version } };
        },
        async () => ({ version: reqEntity.version }),
      );
      expect(res1.status).toBe(200);
      expect((res1.body as any).data.version).toBe(2);

      // Second mutation with fresh key and fresh expected version 2
      const res2 = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': k2 },
          accountId: '10',
          action: 'edit_contact',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 2, name: 'B' },
        },
        async () => {
          const { request: u } = reqEntity.updateRecipientContact({
            buyerId: '10',
            expectedVersion: 2,
            recipientName: 'B',
            recipientPhone: '0902222222',
            now: BASE_NOW,
          });
          reqEntity = u;
          return { result: { version: u.version }, currentState: { version: u.version } };
        },
        async () => ({ version: reqEntity.version }),
      );
      expect(res2.status).toBe(200);
      expect((res2.body as any).data.version).toBe(3);
      expect(harness.countStoredRecords()).toBe(2);
    });

    it('C-5: replaying key on cancelled entity returns cached result with current_state reflecting cancelled', async () => {
      const harness = createInMemoryTradingE2EHarness();
      const k = 'c0a80101-0000-4000-8000-000000000016';
      let reqEntity = buildSentRequest({ version: 1, status: 'sent_to_artisans' });

      // Action 1: edit contact info
      await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': k },
          accountId: '10',
          action: 'edit_contact',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 1, name: 'Edited' },
        },
        async () => {
          const { request: u } = reqEntity.updateRecipientContact({
            buyerId: '10',
            expectedVersion: 1,
            recipientName: 'Edited',
            recipientPhone: '0901234567',
            now: BASE_NOW,
          });
          reqEntity = u;
          return { result: { ok: true }, currentState: { status: reqEntity.status } };
        },
        async () => ({ status: reqEntity.status }),
      );

      // Subsequently, request was cancelled
      const { request: cancelled } = reqEntity.cancel({
        actorId: '10',
        actorRole: 'buyer',
        expectedVersion: 2,
        cancelReason: 'Buyer không còn nhu cầu',
        now: BASE_NOW,
      });
      reqEntity = cancelled;

      // Now replay earlier key k
      const replayRes = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': k },
          accountId: '10',
          action: 'edit_contact',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 1, name: 'Edited' },
        },
        async () => ({ result: { ok: true }, currentState: {} }),
        async () => ({ status: reqEntity.status, cancelled_at: reqEntity.cancelled_at }),
      );

      expect(replayRes.status).toBe(200);
      expect((replayRes.body as any).operation.replayed).toBe(true);
      expect((replayRes.body as any).operation.current_state.status).toBe('sent_to_artisans'); // previous status kept but marked cancelled
      expect((replayRes.body as any).operation.current_state.cancelled_at).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Tier 4: Real-World Application Scenarios (5 Scenarios)
  // --------------------------------------------------------------------------
  describe('Tier 4: Real-World Application Scenarios', () => {
    it('Scenario 1: Double-Submit on Quote Acceptance (Network Timeout Retry)', async () => {
      // Flow: Buyer submits accept quote. The operation commits successfully, but network connection
      // drops before client receives response. Client retries with identical X-Idempotency-Key.
      // Expected: Interceptor detects replay, returns cached result with current state, without creating
      // duplicate allocations or re-executing acceptQuote business logic.
      const harness = createInMemoryTradingE2EHarness();
      const idempotencyKey = 'd0b80101-0000-4000-8000-000000000001';

      let reqEntity = buildSentRequest({ version: 2, status: 'artisans_bidding' });
      const quoteEntity = buildQuote({ id: '401', max_quantity: 100, version: 1, status: 'active' });
      let allocationCreatedCount = 0;

      const acceptMutation = async () => {
        // Domain accept
        const { request: acceptedReq } = reqEntity.markBuyerAccepted({
          buyerId: '10',
          expectedVersion: 2,
          now: BASE_NOW,
        });
        reqEntity = acceptedReq;

        const { allocation } = Allocation.createFromAcceptedQuote({
          id: '701',
          request_id: acceptedReq.id,
          workshop_id: '201',
          quote_id: quoteEntity.id,
          quantity: 100,
          unit_price: quoteEntity.unit_price,
          committed_delivery_at: quoteEntity.committed_delivery_at,
          actorId: '10',
          now: BASE_NOW,
        });
        allocationCreatedCount++;

        return {
          result: {
            request_id: acceptedReq.id,
            allocation_id: allocation.id,
            status: acceptedReq.status,
          },
          currentState: {
            status: acceptedReq.status,
            version: acceptedReq.version,
          },
        };
      };

      const reqPayload = {
        headers: { 'X-Idempotency-Key': idempotencyKey },
        accountId: '10',
        action: 'accept_quote',
        objectType: 'QuoteRequest',
        objectId: '100',
        body: { expected_request_version: 2, quote_id: '401', expected_quote_version: 1 },
      };

      // 1. Initial attempt
      const res1 = await harness.executeHttpMutation(
        reqPayload,
        acceptMutation,
        async () => ({ status: reqEntity.status, version: reqEntity.version }),
      );

      expect(res1.status).toBe(200);
      expect((res1.body as any).operation.replayed).toBe(false);
      expect((res1.body as any).data.allocation_id).toBe('701');
      expect(allocationCreatedCount).toBe(1);

      // 2. Network retry (identical key + identical payload)
      const res2 = await harness.executeHttpMutation(
        reqPayload,
        acceptMutation,
        async () => ({ status: reqEntity.status, version: reqEntity.version }),
      );

      expect(res2.status).toBe(200);
      expect((res2.body as any).operation.replayed).toBe(true);
      expect((res2.body as any).data.allocation_id).toBe('701');
      expect(allocationCreatedCount).toBe(1); // Still exactly 1, no duplication!
    });

    it('Scenario 2: Optimistic Concurrency Race on Quote Accept vs Quote Withdraw', async () => {
      // Flow: Buyer prepares to accept quote v1. Concurrently, Artisan withdraws quote v1 (bumping quote to v2).
      // Buyer's accept request arrives carrying expected_quote_version: 1.
      // Expected: System rejects Buyer's accept with 409 CONCURRENCY_CONFLICT, rolls back, and does not alter the withdrawn quote.
      const harness = createInMemoryTradingE2EHarness();
      const idempotencyKey = 'd0b80101-0000-4000-8000-000000000002';

      const reqEntity = buildSentRequest({ version: 2, status: 'artisans_bidding' });
      const recipientEntity = buildRecipient({ version: 2, response_status: 'quoted' });
      const quoteEntity = buildQuote({ version: 1, status: 'active' });

      // Concurrently: Artisan withdraws quote first
      const { quote: withdrawnQuote } = quoteEntity.withdraw({
        request: reqEntity,
        recipient: recipientEntity,
        actorId: '21',
        withdrawReason: 'Xưởng gặp sự cố lò nung',
        expectedQuoteVersion: 1,
        now: BASE_NOW,
      });
      expect(withdrawnQuote.version).toBe(2);
      expect(withdrawnQuote.status).toBe('withdrawn');

      // Now Buyer's accept request executes with stale expected_quote_version: 1
      const res = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': idempotencyKey },
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 2, quote_id: '401', expected_quote_version: 1 },
        },
        async () => {
          // Verify expected version against the current withdrawnQuote
          withdrawnQuote.assertVersionMatches(1); // will throw ConcurrencyConflictError!
          return { result: { ok: true }, currentState: {} };
        },
        async () => ({}),
      );

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'CONCURRENCY_CONFLICT',
        status: 409,
      });
      expect(harness.countStoredRecords()).toBe(0); // Nothing committed
    });

    it('Scenario 3: Split Proposal Rejection with Stale Version (No Proposal Expiration)', async () => {
      // Flow: Admin had updated split proposal to version 2. Buyer attempts to reject the proposal
      // sending expected_proposal_version: 1.
      // Expected: System rejects with 409 CONCURRENCY_CONFLICT. Per BR-18 and PROJECT.md, the proposal
      // must NOT be expired or transitioned to expired merely due to client's stale version.
      const harness = createInMemoryTradingE2EHarness();
      const idempotencyKey = 'd0b80101-0000-4000-8000-000000000003';

      const currentProposal = buildSplitProposal({
        id: '501',
        version: 2, // Current version is 2
        status: 'proposed',
      });

      const res = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': idempotencyKey },
          accountId: '10',
          action: 'reject_split_proposal',
          objectType: 'SplitProposal',
          objectId: '501',
          body: { expected_proposal_version: 1, reason: 'Không đồng ý phương án' },
        },
        async () => {
          currentProposal.assertVersionMatches(1); // throws ConcurrencyConflictError!
          return { result: { ok: true }, currentState: {} };
        },
        async () => ({ status: currentProposal.status }),
      );

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'CONCURRENCY_CONFLICT' });
      expect(currentProposal.status).toBe('proposed'); // Crucial: NOT expired!
      expect(harness.countStoredRecords()).toBe(0);
    });

    it('Scenario 4: Independent Artisan Allocations Progress Concurrency', async () => {
      // Flow: A quote request has two separate allocations (Allocation 701 for Workshop 201, Allocation 702 for Workshop 202).
      // Both artisans concurrently submit progress updates under their respective accounts and expected versions.
      // Expected: Both mutations succeed concurrently without concurrency conflict, each isolated to their respective allocation.
      const harness = createInMemoryTradingE2EHarness();
      const keyArtisan1 = 'd0b80101-0000-4000-8000-000000000004';
      const keyArtisan2 = 'd0b80101-0000-4000-8000-000000000005';

      let alloc1 = buildAllocation({ id: '701', workshop_id: '201', version: 1, status: 'not_started' });
      let alloc2 = buildAllocation({ id: '702', workshop_id: '202', version: 1, status: 'not_started' });
      const req = buildSentRequest({ status: 'buyer_accepted' });

      // Artisan 1 starts production on Allocation 701
      const res1 = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': keyArtisan1 },
          accountId: '201',
          action: 'start_production',
          objectType: 'Allocation',
          objectId: '701',
          body: { expected_allocation_version: 1 },
        },
        async () => {
          const { allocation: u } = alloc1.startProduction({
            request: req,
            actorId: '21',
            actorWorkshopId: '201',
            expectedVersion: 1,
            now: BASE_NOW,
          });
          alloc1 = u;
          return { result: { allocation_id: u.id, version: u.version }, currentState: { version: u.version } };
        },
        async () => ({ version: alloc1.version }),
      );

      // Artisan 2 starts production on Allocation 702 concurrently
      const res2 = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': keyArtisan2 },
          accountId: '202',
          action: 'start_production',
          objectType: 'Allocation',
          objectId: '702',
          body: { expected_allocation_version: 1 },
        },
        async () => {
          const { allocation: u } = alloc2.startProduction({
            request: req,
            actorId: '22',
            actorWorkshopId: '202',
            expectedVersion: 1,
            now: BASE_NOW,
          });
          alloc2 = u;
          return { result: { allocation_id: u.id, version: u.version }, currentState: { version: u.version } };
        },
        async () => ({ version: alloc2.version }),
      );

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(alloc1.version).toBe(2);
      expect(alloc2.version).toBe(2);
      expect(harness.countStoredRecords()).toBe(2);
    });

    it('Scenario 5: 24h TTL Expiration & Safe Post-TTL Invariant Guard', async () => {
      // Flow: At T0, Buyer accepts quote with idempotency key K1.
      // 25 hours later, the 24h TTL cleanup runs and deletes the IdempotencyRecord.
      // If a delayed duplicate request with K1 arrives post-TTL, the system no longer has the idempotency
      // record, but the domain entity state machine safely blocks re-execution (QuoteRequest is already buyer_accepted).
      const clockT0 = new Date('2026-11-11T08:00:00.000Z');
      const harness = createInMemoryTradingE2EHarness(clockT0);
      const keyK1 = 'd0b80101-0000-4000-8000-000000000006';

      let reqEntity = buildSentRequest({ version: 1, status: 'artisans_bidding' });
      const quote = buildQuote({ version: 1, status: 'active' });

      // 1. Initial execution at T0
      const resT0 = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': keyK1 },
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 1 },
        },
        async () => {
          const { request: accepted } = reqEntity.markBuyerAccepted({
            buyerId: '10',
            expectedVersion: 1,
            now: clockT0,
          });
          reqEntity = accepted;
          return { result: { status: accepted.status }, currentState: { status: accepted.status } };
        },
        async () => ({ status: reqEntity.status }),
      );

      expect(resT0.status).toBe(200);
      expect(reqEntity.status).toBe('buyer_accepted');
      expect(reqEntity.version).toBe(2);
      expect(harness.countStoredRecords()).toBe(1);

      // 2. 25 hours later, cleanup runs
      const clockT25 = new Date('2026-11-12T09:00:00.000Z');
      const deleted = await harness.cleanupExpired(clockT25);
      expect(deleted).toBe(1);
      expect(harness.countStoredRecords()).toBe(0);

      // 3. Delayed duplicate arrives post-TTL with key K1 and expected_request_version: 1
      const resPostTtl = await harness.executeHttpMutation(
        {
          headers: { 'X-Idempotency-Key': keyK1 },
          accountId: '10',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '100',
          body: { expected_request_version: 1 },
        },
        async () => {
          // Domain check: QuoteRequest is at version 2 (and status buyer_accepted)
          reqEntity.assertVersionMatches(1); // throws ConcurrencyConflictError!
          return { result: { ok: true }, currentState: {} };
        },
        async () => ({ status: reqEntity.status }),
      );

      // Rejected safely by domain concurrency check without mutating state!
      expect(resPostTtl.status).toBe(409);
      expect(resPostTtl.body).toMatchObject({ code: 'CONCURRENCY_CONFLICT' });
      expect(reqEntity.status).toBe('buyer_accepted');
      expect(reqEntity.version).toBe(2);
    });
  });
});
