import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkshopSuspended } from '../../../src/modules/workshops/domain/errors/workshop-suspended';
import {
  acceptInputFor,
  createPgTestContext,
  createPgTradingStack,
  expectRejectsProblem,
  withSeededFixture,
  type PgTestContext,
} from '../../support/pg-trading-harness';

const testUrl = process.env.VCRAFT_TEST_DATABASE_URL;

describe.skipIf(!testUrl)('AcceptQuotationWorkflow Persistence on PostgreSQL (BR-05, BR-16, BR-20, BR-27)', () => {
  let ctx: PgTestContext;
  beforeAll(async () => { ctx = await createPgTestContext(testUrl!); });
  afterAll(async () => { await ctx?.close(); });

  it('commits Allocation/Quote/QuoteRequest/logs atomically, replays same key, and rejects mismatched payload with 409', async () => {
    await withSeededFixture(ctx.db, { requestStatus: 'artisans_bidding', requestVersion: 2 }, async (f) => {
      const { acceptWorkflow } = await createPgTradingStack(ctx.db, ctx.txRunner);
      const w = f.workshops[0];
      const input = acceptInputFor(f, { idempotencyKey: randomUUID() });

      const result = await acceptWorkflow.execute(input);
      expect(result.data.request_status).toBe('buyer_accepted');
      expect(result.operation?.replayed).toBe(false);
      expect(result.data.allocations).toHaveLength(1);

      const [req, quote, alloc, statusLogs, recipientLogs, allocLogs] = await Promise.all([
        ctx.db.quoteRequest.findUnique({ where: { id: f.requestId } }),
        ctx.db.quote.findUnique({ where: { id: w.quoteId! } }),
        ctx.db.allocation.findUnique({ where: { quote_id: w.quoteId! } }),
        ctx.db.statusLog.findMany({ where: { request_id: f.requestId }, orderBy: { id: 'asc' } }),
        ctx.db.recipientResponseHistory.findMany({ where: { recipient_id: w.recipientId! } }),
        ctx.db.allocationLog.findMany({ where: { allocation: { request_id: f.requestId } } }),
      ]);
      expect(req).toMatchObject({ status: 'buyer_accepted', version: 3 });
      expect(quote).toMatchObject({ status: 'accepted', version: 2 });
      expect(alloc?.status).toBe('not_started');
      expect(statusLogs.map((r) => r.event_type)).toEqual(['bidding_closed', 'accepted']);
      expect([recipientLogs.length, allocLogs.length]).toEqual([1, 1]);

      // Safe replay + 409 mismatch
      const replay = await acceptWorkflow.execute(input);
      expect(replay.operation?.replayed).toBe(true);
      expect(replay.data).toEqual(result.data);
      expect(await ctx.db.allocation.count({ where: { request_id: f.requestId } })).toBe(1);
      await expectRejectsProblem(acceptWorkflow.execute({ ...input, expectedQuoteVersion: 99 }), 409, 'IDEMPOTENCY_CONFLICT');
    });
  });

  it('rejects suspended workshop and rolls back all writes on mid-transaction failure', async () => {
    await withSeededFixture(ctx.db, { requestStatus: 'artisans_bidding', requestVersion: 2, workshopInitialStatus: 'suspended' }, async (f) => {
      const w = f.workshops[0];
      const stack = await createPgTradingStack(ctx.db, ctx.txRunner);
      await expect(stack.acceptWorkflow.execute(acceptInputFor(f))).rejects.toThrow(WorkshopSuspended);

      await ctx.db.workshop.update({ where: { id: w.workshopId }, data: { status: 'active' } });
      const failingAllocRepo = Object.assign(Object.create(Object.getPrototypeOf(stack.repos.allocationRepo)), stack.repos.allocationRepo, {
        create: async () => Promise.reject(new Error('Simulated PG failure')),
      });
      const { acceptWorkflow: failingWorkflow } = await createPgTradingStack(ctx.db, ctx.txRunner, { allocationRepo: failingAllocRepo });
      await expect(failingWorkflow.execute(acceptInputFor(f))).rejects.toThrow('Simulated PG failure');

      const [quote, req, statusCount, allocCount, idempCount] = await Promise.all([
        ctx.db.quote.findUnique({ where: { id: w.quoteId! } }),
        ctx.db.quoteRequest.findUnique({ where: { id: f.requestId } }),
        ctx.db.statusLog.count({ where: { request_id: f.requestId } }),
        ctx.db.allocation.count({ where: { request_id: f.requestId } }),
        ctx.db.idempotencyRecord.count({ where: { account_id: f.buyerId } }),
      ]);
      expect(quote?.status).toBe('active');
      expect(req?.status).toBe('artisans_bidding');
      expect([statusCount, allocCount, idempCount]).toEqual([0, 0, 0]);
    });
  });
});
