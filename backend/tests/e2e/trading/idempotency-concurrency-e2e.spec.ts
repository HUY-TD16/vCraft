import { describe, expect, it, vi } from 'vitest';
import { IdempotencyRecord as PrismaIdempotencyRecord, Prisma } from '../../../src/generated/prisma/client';
import type { PrismaService } from '../../../src/infrastructure/database/prisma/prisma.service';
import { PrismaTransactionRunner } from '../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import { PrismaIdempotencyRecordRepository } from '../../../src/modules/trading/adapters/persistence';
import type { TradingCurrentStateDto } from '../../../src/modules/trading/application/dtos/trading-persistence.dtos';
import { IdempotencyCleanupService, TradingIdempotencyService } from '../../../src/modules/trading/application/services';
import { Allocation, ConcurrencyConflictError, IdempotencyConflictError, Quote, QuoteRequest, RequestRecipient } from '../../../src/modules/trading/domain';
import { computeCanonicalFingerprint, normalizeUuidV4 } from '../../../src/modules/trading/domain/utilities';
import { expectHttpProblem, expectRejectsProblem } from '../../support/pg-trading-harness';

const BASE_NOW = new Date('2026-11-11T08:00:00.000Z');
const H = 3600 * 1000;
const COMMITTED_DELIVERY = new Date(BASE_NOW.getTime() + 168 * H);

/** Minimal in-memory Prisma adapter backing real `TradingIdempotencyService` + `PrismaTransactionRunner`. */
function createInMemoryHarness(baseClock = BASE_NOW) {
  const table = new Map<string, PrismaIdempotencyRecord>();
  let nextId = 1000n;
  let triggerP2002Next: PrismaIdempotencyRecord | null = null;
  const makeKey = (r: { account_id: bigint; action: string; object_type: string; object_id: bigint; idempotency_key: string }) =>
    `${r.account_id}:${r.action.trim()}:${r.object_type.trim()}:${r.object_id}:${r.idempotency_key.trim().toLowerCase()}`;
  const p2002 = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.20.0' });

  const makeClient = (state: { aborted: boolean; competingRow: PrismaIdempotencyRecord | null }) => ({
    idempotencyRecord: {
      findUnique: async (args: { where: { account_id_action_object_type_object_id_idempotency_key: { account_id: bigint; action: string; object_type: string; object_id: bigint; idempotency_key: string } } }) => {
        if (state.aborted) throw new Error('current transaction is aborted (25P02)');
        const row = table.get(makeKey(args.where.account_id_action_object_type_object_id_idempotency_key));
        return row ? { ...row } : null;
      },
      create: async (args: { data: Prisma.IdempotencyRecordUncheckedCreateInput }) => {
        if (triggerP2002Next) {
          state.competingRow = triggerP2002Next;
          triggerP2002Next = null;
          state.aborted = true;
          throw p2002();
        }
        const row: PrismaIdempotencyRecord = {
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
        if (table.has(makeKey(row))) {
          state.aborted = true;
          throw p2002();
        }
        table.set(makeKey(row), row);
        return { ...row };
      },
      deleteMany: async (args: { where: { expires_at: { lt: Date } } }) => {
        const cutoff = args.where.expires_at.lt.getTime();
        let count = 0;
        for (const [k, v] of Array.from(table.entries())) {
          if (v.expires_at.getTime() < cutoff) (table.delete(k), count++);
        }
        return { count };
      },
    },
  });

  const mockPrisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = new Map(table);
      const txState = { aborted: false, competingRow: null as PrismaIdempotencyRecord | null };
      try {
        return await fn(makeClient(txState));
      } catch (err) {
        table.clear();
        for (const [k, v] of snapshot.entries()) table.set(k, v);
        if (txState.competingRow) table.set(makeKey(txState.competingRow), txState.competingRow);
        throw err;
      }
    },
  } as unknown as PrismaService;

  const txRunner = new PrismaTransactionRunner(mockPrisma);
  const repo = new PrismaIdempotencyRecordRepository(txRunner);
  const service = new TradingIdempotencyService(repo, txRunner);
  const cleanup = new IdempotencyCleanupService(repo, txRunner, () => baseClock);
  return {
    service,
    cleanup,
    countRecords: () => table.size,
    simulateNextP2002: (winner: PrismaIdempotencyRecord) => {
      triggerP2002Next = winner;
    },
    runOp: <TResult>(opts: {
      action?: string;
      key: string;
      payload: unknown;
      now?: Date;
      execute: () => Promise<{ result: TResult; currentState: TradingCurrentStateDto }>;
      getCurrentState: () => Promise<TradingCurrentStateDto>;
    }) =>
      service.executeWithIdempotency<TResult>({
        accountId: '10',
        action: opts.action ?? 'accept_quote',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: opts.key,
        payload: opts.payload,
        now: opts.now ?? baseClock,
        execute: opts.execute,
        getCurrentState: opts.getCurrentState,
      }),
  };
}

const buildRequest = (overrides: Partial<Parameters<typeof QuoteRequest.reconstitute>[0]> = {}) =>
  QuoteRequest.reconstitute({
    id: '100', buyer_id: '10', category_id: '1', spec: 'Bộ ấm chén men lam', quantity: 100, unit: 'set',
    unit_set_description: '1 ấm + 6 chén', status: 'artisans_bidding', delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội', delivery_address: '10 Hàng Gai', recipient_name: 'Nguyễn Văn Mua',
    recipient_phone: '0912345678', bidding_deadline: new Date(BASE_NOW.getTime() + 48 * H),
    delivery_deadline: new Date(BASE_NOW.getTime() + 216 * H), bidding_closed_at: null, version: 2,
    cancelled_at: null, cancelled_by: null, cancel_reason: null, created_at: BASE_NOW, updated_at: BASE_NOW,
    ...overrides,
  });

const buildQuote = (overrides: Partial<Parameters<typeof Quote.reconstitute>[0]> = {}) =>
  Quote.reconstitute({
    id: '401', request_id: '100', workshop_id: '201', unit_price: 150000, max_quantity: 100,
    bid_accept_deadline: new Date(BASE_NOW.getTime() + 74 * H), committed_delivery_at: COMMITTED_DELIVERY,
    status: 'active', version: 1, withdraw_reason: null, withdrawn_by: null, withdrawn_at: null,
    created_at: BASE_NOW, updated_at: BASE_NOW, ...overrides,
  });

const buildAllocation = (overrides: Partial<Parameters<typeof Allocation.reconstitute>[0]> = {}) =>
  Allocation.reconstitute({
    id: '701', request_id: '100', workshop_id: '201', quote_id: '401', quantity: 100, unit_price: 150000,
    committed_delivery_at: COMMITTED_DELIVERY, status: 'not_started', version: 1, started_at: null, started_by: null,
    handed_over_at: null, handed_over_by: null, delivery_note: null, admin_handed_over: false,
    admin_delivery_evidence: null, admin_handover_reason: null, admin_handover_actual_at: null,
    created_at: BASE_NOW, updated_at: BASE_NOW, batch_links: [], ...overrides,
  });

const toState = (req: QuoteRequest): TradingCurrentStateDto => ({
  request: { id: req.id, status: req.status, version: req.version, cancelled_at: req.cancelled_at?.toISOString() ?? null },
});

describe('Trading Idempotency & Optimistic Concurrency E2E (Core Flows)', () => {
  it('1. Rejects invalid X-Idempotency-Key with HTTP 400 INVALID_INPUT Problem Details (api-design.md §1.4)', () => {
    for (const bad of [undefined, '', 'not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      let caught: unknown;
      try { normalizeUuidV4(bad); } catch (err) { caught = err; }
      expectHttpProblem(caught, 400, 'INVALID_INPUT');
    }
    expect(normalizeUuidV4('  A0A80101-0000-4000-8000-000000000001  ')).toBe('a0a80101-0000-4000-8000-000000000001');
  });

  it('2. Double-submit Accept Quote replays snapshot with fresh current_state and rejects mismatch with 409 (BR-27)', async () => {
    const h = createInMemoryHarness();
    const key = 'd0b80101-0000-4000-8000-000000000001';
    let req = buildRequest();
    const quote = buildQuote();
    const executeSpy = vi.fn(async () => {
      req = req.markBuyerAccepted({ buyerId: '10', expectedVersion: 2, now: BASE_NOW }).request;
      const { allocation } = Allocation.createFromAcceptedQuote({
        id: '701', request_id: req.id, workshop_id: '201', quote_id: quote.id, quantity: 100,
        unit_price: quote.unit_price, committed_delivery_at: quote.committed_delivery_at, actorId: '10', now: BASE_NOW,
      });
      return { result: { request_id: req.id, allocation_id: allocation.id, status: req.status }, currentState: toState(req) };
    });

    const first = await h.runOp({ key, payload: { expected_request_version: 2, quote_id: '401', expected_quote_version: 1 }, execute: executeSpy, getCurrentState: async () => toState(req) });
    expect(first.replayed).toBe(false);
    expect(first.data.allocation_id).toBe('701');

    // Cancel after accept; canonical replay returns old snapshot + fresh cancelled current_state
    req = req.cancel({ actorId: '1', actorRole: 'admin', expectedVersion: 3, cancelReason: 'Hủy sau chốt', goodsHandlingNote: 'Chưa giao', now: BASE_NOW }).request;
    const replay = await h.runOp({ key, payload: { expected_quote_version: 1, expected_request_version: 2, quote_id: '401' }, execute: executeSpy, getCurrentState: async () => toState(req) });
    expect(replay.replayed).toBe(true);
    expect(replay.data).toEqual(first.data);
    expect(replay.currentState.request).toMatchObject({ version: 4, cancelled_at: BASE_NOW.toISOString() });
    expect(executeSpy).toHaveBeenCalledTimes(1);

    const conflictErr = await expectRejectsProblem(
      h.runOp({ key, payload: { expected_request_version: 2, quote_id: '999', expected_quote_version: 1 }, execute: executeSpy, getCurrentState: async () => toState(req) }),
      409,
      'IDEMPOTENCY_CONFLICT',
    );
    expect(conflictErr).toBeInstanceOf(IdempotencyConflictError);
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it('3. Atomic rollback on concurrency conflict keeps zero IdempotencyRecord and permits clean retry (BR-27)', async () => {
    const h = createInMemoryHarness();
    const key = 'd0b80101-0000-4000-8000-000000000002';
    let req = buildRequest({ version: 2 });

    await expectRejectsProblem(
      h.runOp({
        action: 'edit_contact', key, payload: { expected_request_version: 1, recipient_name: 'Tên mới' },
        execute: async () => { req.assertVersionMatches(1); return { result: { ok: true }, currentState: toState(req) }; },
        getCurrentState: async () => toState(req),
      }),
      409,
      'CONCURRENCY_CONFLICT',
    );
    expect(h.countRecords()).toBe(0);

    const retry = await h.runOp({
      action: 'edit_contact', key, payload: { expected_request_version: 2, recipient_name: 'Tên mới' },
      execute: async () => {
        req = req.updateRecipientContact({ buyerId: '10', expectedVersion: 2, recipientName: 'Tên mới', recipientPhone: '0988776655', now: BASE_NOW }).request;
        return { result: { version: req.version }, currentState: toState(req) };
      },
      getCurrentState: async () => toState(req),
    });
    expect(retry.replayed).toBe(false);
    expect(retry.data.version).toBe(3);
    expect(h.countRecords()).toBe(1);
  });

  it('4. Optimistic concurrency blocks stale versions across all 4 entities and isolates Allocation progress (BR-27)', () => {
    const req = buildRequest({ version: 2 });
    const recipient = RequestRecipient.reconstitute({
      id: '300', request_id: '100', workshop_id: '201', response_status: 'quoted',
      decline_reason: null, responded_by: '21', responded_at: BASE_NOW, sent_at: BASE_NOW, version: 2,
    });
    expect(() => req.assertVersionMatches(1)).toThrow(ConcurrencyConflictError);
    expect(() => recipient.assertVersionMatches(1)).toThrow(ConcurrencyConflictError);

    const withdrawn = buildQuote().withdraw({
      request: req, recipient, actorId: '21', withdrawReason: 'Sự cố lò nung', expectedQuoteVersion: 1, now: BASE_NOW,
    }).quote;
    expect(withdrawn.version).toBe(2);
    expect(() => withdrawn.assertVersionMatches(1)).toThrow(ConcurrencyConflictError);

    const acceptedReq = buildRequest({ status: 'buyer_accepted', version: 3 });
    const u1 = buildAllocation({ id: '701', workshop_id: '201' }).startProduction({ request: acceptedReq, actorId: '21', actorWorkshopId: '201', expectedVersion: 1, now: BASE_NOW }).allocation;
    const u2 = buildAllocation({ id: '702', workshop_id: '202' }).startProduction({ request: acceptedReq, actorId: '22', actorWorkshopId: '202', expectedVersion: 1, now: BASE_NOW }).allocation;
    expect([u1.version, u2.version]).toEqual([2, 2]);
    expect(() => u1.assertVersionMatches(1)).toThrow(ConcurrencyConflictError);
  });

  it('5. 24h TTL cleanup purges expired records and domain version guard blocks post-TTL duplicates (BR-27)', async () => {
    const h = createInMemoryHarness(BASE_NOW);
    const key = 'd0b80101-0000-4000-8000-000000000005';
    let req = buildRequest({ version: 2 });

    await h.runOp({
      key, payload: { expected_request_version: 2 },
      execute: async () => {
        req = req.markBuyerAccepted({ buyerId: '10', expectedVersion: 2, now: BASE_NOW }).request;
        return { result: { status: req.status }, currentState: toState(req) };
      },
      getCurrentState: async () => toState(req),
    });
    expect((await h.cleanup.cleanupExpiredRecords(new Date(BASE_NOW.getTime() + 24 * H))).deletedCount).toBe(0);
    expect((await h.cleanup.cleanupExpiredRecords(new Date(BASE_NOW.getTime() + 25 * H))).deletedCount).toBe(1);
    expect(h.countRecords()).toBe(0);

    await expectRejectsProblem(
      h.runOp({
        key, payload: { expected_request_version: 2 }, now: new Date(BASE_NOW.getTime() + 25 * H),
        execute: async () => { req.assertVersionMatches(2); return { result: { status: req.status }, currentState: toState(req) }; },
        getCurrentState: async () => toState(req),
      }),
      409,
      'CONCURRENCY_CONFLICT',
    );
  });

  it('6. Concurrent P2002 race recovers with replay on matching payload and rejects mismatch with 409 (BR-27)', async () => {
    const h = createInMemoryHarness();
    const req = buildRequest({ status: 'buyer_accepted', version: 3 });
    const winKey = 'd0b80101-0000-4000-8000-000000000006';
    const winPayload = { expected_request_version: 2, quote_id: '401' };
    const winRow: PrismaIdempotencyRecord = {
      id: 9001n, idempotency_key: winKey, request_fingerprint: computeCanonicalFingerprint(winPayload),
      account_id: 10n, action: 'accept_quote', object_type: 'QuoteRequest', object_id: 100n,
      result_snapshot: { allocation_id: '701' }, created_at: BASE_NOW, expires_at: new Date(BASE_NOW.getTime() + 24 * H),
    };

    h.simulateNextP2002(winRow);
    const recovered = await h.runOp({
      key: winKey, payload: winPayload,
      execute: async () => ({ result: { allocation_id: '701' }, currentState: toState(req) }),
      getCurrentState: async () => toState(req),
    });
    expect(recovered.replayed).toBe(true);
    expect(recovered.data).toEqual({ allocation_id: '701' });

    const mismatchKey = 'd0b80101-0000-4000-8000-000000000007';
    h.simulateNextP2002({ ...winRow, id: 9002n, idempotency_key: mismatchKey });
    await expectRejectsProblem(
      h.runOp({
        key: mismatchKey, payload: { expected_request_version: 2, quote_id: '999' },
        execute: async () => ({ result: { allocation_id: '999' }, currentState: toState(req) }),
        getCurrentState: async () => toState(req),
      }),
      409,
      'IDEMPOTENCY_CONFLICT',
    );
  });
});
