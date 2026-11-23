import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConcurrencyConflictError } from '../../../src/modules/trading/domain';
import { computeCanonicalFingerprint } from '../../../src/modules/trading/domain/utilities';
import {
  acceptInputFor,
  createBarrier,
  createPgTestContext,
  createPgTradingStack,
  withSeededFixture,
  type PgTestContext,
} from '../../support/pg-trading-harness';

const testUrl = process.env.VCRAFT_TEST_DATABASE_URL;

describe.skipIf(!testUrl)('AcceptQuotationWorkflow Concurrency on PostgreSQL (BR-20, BR-27)', () => {
  let ctx: PgTestContext;
  beforeAll(async () => { ctx = await createPgTestContext(testUrl!); });
  afterAll(async () => { await ctx?.close(); });

  it('concurrent competing quotes on the same QuoteRequest: exactly 1 succeeds and loser fails with ConcurrencyConflictError', async () => {
    await withSeededFixture(ctx.db, { requestStatus: 'artisans_bidding', requestVersion: 2, workshopCount: 2 }, async (f) => {
      const { acceptWorkflow } = await createPgTradingStack(ctx.db, ctx.txRunner);
      const results = await Promise.allSettled([
        acceptWorkflow.execute(acceptInputFor(f, { workshopIndex: 0 })),
        acceptWorkflow.execute(acceptInputFor(f, { workshopIndex: 1 })),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect([fulfilled.length, rejected.length]).toEqual([1, 1]);
      expect(rejected[0].reason).toBeInstanceOf(ConcurrencyConflictError);
      expect(await ctx.db.allocation.count({ where: { request_id: f.requestId } })).toBe(1);
    });
  });

  it('concurrent same-X-Idempotency-Key double-submit & PG P2002/25P02 recovery return committed replay cleanly', async () => {
    // Part A: Two concurrent submissions racing past Step 1 pre-check
    await withSeededFixture(ctx.db, { requestStatus: 'artisans_bidding', requestVersion: 2 }, async (f) => {
      const stack = await createPgTradingStack(ctx.db, ctx.txRunner);
      const { AcceptQuotationWorkflow } = await import('../../../src/workflows/accept-quotation');
      const waitBoth = createBarrier(2);
      const barrierService = Object.assign(Object.create(Object.getPrototypeOf(stack.acceptanceService)), stack.acceptanceService, {
        prepareAcceptance: async (...args: Parameters<typeof stack.acceptanceService.prepareAcceptance>) => {
          await waitBoth();
          return stack.acceptanceService.prepareAcceptance(...args);
        },
      });
      const workflow = new AcceptQuotationWorkflow(ctx.txRunner, barrierService, stack.wsContract);
      const input = acceptInputFor(f, { idempotencyKey: randomUUID() });

      const [r1, r2] = await Promise.all([workflow.execute(input), workflow.execute(input)]);
      expect(r1.data).toEqual(r2.data);
      expect([r1.operation?.replayed, r2.operation?.replayed].sort()).toEqual([false, true]);
      expect(await ctx.db.allocation.count({ where: { request_id: f.requestId } })).toBe(1);
    });

    // Part B: Direct real PostgreSQL P2002 -> 25P02 rollback & replay recovery
    await withSeededFixture(ctx.db, { requestStatus: 'artisans_bidding', requestVersion: 2 }, async (f) => {
      const base = await createPgTradingStack(ctx.db, ctx.txRunner);
      const w = f.workshops[0];
      const sharedKey = randomUUID();
      const expectedSnapshot = { request_id: f.requestId.toString(), request_status: 'buyer_accepted', request_version: 3, allocations: [] };
      const fp = computeCanonicalFingerprint({ quote_id: w.quoteId!.toString(), expected_request_version: 2, expected_quote_version: 1 });

      let injected = false;
      const p2002Repo = Object.assign(Object.create(Object.getPrototypeOf(base.repos.idempotencyRepo)), base.repos.idempotencyRepo, {
        save: async (...args: Parameters<typeof base.repos.idempotencyRepo.save>) => {
          if (!injected) {
            injected = true;
            await ctx.db.idempotencyRecord.create({
              data: {
                idempotency_key: sharedKey,
                request_fingerprint: fp,
                account_id: f.buyerId,
                action: 'accept_quote',
                object_type: 'QuoteRequest',
                object_id: f.requestId,
                result_snapshot: expectedSnapshot,
                created_at: f.now,
                expires_at: new Date(f.now.getTime() + 24 * 3600 * 1000),
              },
            });
          }
          return base.repos.idempotencyRepo.save(...args);
        },
      });
      const { acceptWorkflow } = await createPgTradingStack(ctx.db, ctx.txRunner, { idempotencyRepo: p2002Repo });
      const recovered = await acceptWorkflow.execute(acceptInputFor(f, { idempotencyKey: sharedKey }));
      expect(recovered.operation?.replayed).toBe(true);
      expect(recovered.data).toEqual(expectedSnapshot);
      expect(await ctx.db.allocation.count({ where: { request_id: f.requestId } })).toBe(0);
    });
  });
});
