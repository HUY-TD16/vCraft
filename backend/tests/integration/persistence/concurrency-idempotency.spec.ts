import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConcurrencyConflictError, IdempotencyConflictError } from '../../../src/modules/trading/domain';
import {
  acceptInputFor,
  createBarrier,
  createPgTestContext,
  createPgTradingStack,
  expectHttpProblem,
  expectRejectsProblem,
  withSeededFixture,
  type PgTestContext,
  type SeededTradingFixture,
} from '../../support/pg-trading-harness';

const testUrl = process.env.VCRAFT_TEST_DATABASE_URL;

describe.skipIf(!testUrl)('Persistence Concurrency, Idempotency & Stale Version on PostgreSQL (BR-27, SEC-06)', () => {
  let ctx: PgTestContext;
  beforeAll(async () => { ctx = await createPgTestContext(testUrl!); });
  afterAll(async () => { await ctx?.close(); });

  const runEditContact = async (f: SeededTradingFixture, key: string, recipientName: string, waitBoth: () => Promise<void>) => {
    const { repos, idempotencyService, useCases } = await createPgTradingStack(ctx.db, ctx.txRunner);
    return idempotencyService.executeWithIdempotency({
      accountId: f.buyerId.toString(),
      action: 'edit_contact',
      objectType: 'QuoteRequest',
      objectId: f.requestId.toString(),
      idempotencyKey: key,
      payload: { expected_request_version: 4, recipient_name: recipientName, recipient_phone: '0988777666' },
      now: f.now,
      execute: async (tx) => {
        await waitBoth();
        const updated = await useCases.updateContact.execute({
          actor: f.buyerActor,
          requestId: f.requestId.toString(),
          expectedRequestVersion: 4,
          recipientName,
          recipientPhone: '0988777666',
          tx,
        });
        return {
          result: { id: updated.id, version: updated.version, recipient_name: updated.recipient_name },
          currentState: { request: { id: updated.id, status: updated.status, version: updated.version, cancelled_at: null } },
        };
      },
      getCurrentState: async (tx) => {
        const fresh = (await repos.quoteRequestRepo.findById(f.requestId.toString(), tx))!;
        return { request: { id: fresh.id, status: fresh.status, version: fresh.version, cancelled_at: null } };
      },
    });
  };

  it('concurrent same X-Idempotency-Key + same payload: 1 commits (replayed:false) + 1 replays (replayed:true)', async () => {
    await withSeededFixture(ctx.db, { requestStatus: 'in_production', requestVersion: 4, allocationStatus: 'in_production', allocationVersion: 2 }, async (f) => {
      const key = randomUUID();
      const waitBoth = createBarrier(2);
      const [r1, r2] = await Promise.all([runEditContact(f, key, 'Trần Minh Khôi', waitBoth), runEditContact(f, key, 'Trần Minh Khôi', waitBoth)]);
      expect(r1.data).toEqual(r2.data);
      expect(r1.recordId).toBe(r2.recordId);
      expect([r1.replayed, r2.replayed].sort()).toEqual([false, true]);
      expect(await ctx.db.contactEditHistory.count({ where: { request_id: f.requestId } })).toBe(1);
    });
  });

  it('concurrent same X-Idempotency-Key + different payload: 1 commits and loser rejects with 409 IDEMPOTENCY_CONFLICT', async () => {
    await withSeededFixture(ctx.db, { requestStatus: 'in_production', requestVersion: 4, allocationStatus: 'in_production', allocationVersion: 2 }, async (f) => {
      const key = randomUUID();
      const waitBoth = createBarrier(2);
      const results = await Promise.allSettled([runEditContact(f, key, 'Người nhận A', waitBoth), runEditContact(f, key, 'Người nhận B', waitBoth)]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect([fulfilled.length, rejected.length]).toEqual([1, 1]);
      expect(rejected[0].reason).toBeInstanceOf(IdempotencyConflictError);
      expectHttpProblem(rejected[0].reason, 409, 'IDEMPOTENCY_CONFLICT');
      expect(await ctx.db.contactEditHistory.count({ where: { request_id: f.requestId } })).toBe(1);
    });
  });

  it('rejects stale expected_*_version with 409 CONCURRENCY_CONFLICT across all 4 versioned entities', async () => {
    const stack = await createPgTradingStack(ctx.db, ctx.txRunner);

    await withSeededFixture(ctx.db, { requestStatus: 'sent_to_artisans', requestVersion: 2, recipientVersion: 2, seedQuotes: false }, async (f) => {
      expect(
        await expectRejectsProblem(
          stack.useCases.updateContact.execute({ actor: f.buyerActor, requestId: f.requestId.toString(), expectedRequestVersion: 1, recipientName: 'Stale', recipientPhone: '0909999999' }),
          409,
          'CONCURRENCY_CONFLICT',
        ),
      ).toBeInstanceOf(ConcurrencyConflictError);

      expect(
        await expectRejectsProblem(
          stack.useCases.decline.execute({ actor: f.workshops[0].artisanActor, requestId: f.requestId.toString(), expectedRecipientVersion: 1, declineReason: 'Stale', now: f.now }),
          409,
          'CONCURRENCY_CONFLICT',
        ),
      ).toBeInstanceOf(ConcurrencyConflictError);
    });

    await withSeededFixture(ctx.db, { requestStatus: 'artisans_bidding', requestVersion: 2, quoteVersion: 2 }, async (f) => {
      expect(
        await expectRejectsProblem(stack.acceptWorkflow.execute(acceptInputFor(f, { expectedQuoteVersion: 1 })), 409, 'CONCURRENCY_CONFLICT'),
      ).toBeInstanceOf(ConcurrencyConflictError);
    });

    await withSeededFixture(ctx.db, { requestStatus: 'buyer_accepted', requestVersion: 3, allocationStatus: 'not_started', allocationVersion: 2 }, async (f) => {
      const w = f.workshops[0];
      expect(
        await expectRejectsProblem(
          stack.useCases.startProduction.execute({ actor: w.artisanActor, allocationId: w.allocationId!.toString(), expectedAllocationVersion: 1, now: f.now }),
          409,
          'CONCURRENCY_CONFLICT',
        ),
      ).toBeInstanceOf(ConcurrencyConflictError);
    });
  });
});
