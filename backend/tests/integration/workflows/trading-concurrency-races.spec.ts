import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TradingMutationOptions } from '../../../src/modules/trading/adapters/http';
import { ConcurrencyConflictError, IdempotencyConflictError, InvalidStateTransitionError } from '../../../src/modules/trading/domain';
import { WorkshopSuspended } from '../../../src/modules/workshops/domain/errors/workshop-suspended';
import type { IWorkshopContract } from '../../../src/modules/workshops/public/contracts/workshop.contract';
import {
  acceptInputFor,
  createBarrier,
  createDeferred,
  createPgTestContext,
  createPgTradingStack,
  expectHttpProblem,
  expectRejectsProblem,
  gateMethod,
  invokeThroughTradingInterceptor,
  runGatedRace,
  withSeededFixture,
  type PgTestContext,
} from '../../support/pg-trading-harness';

const testUrl = process.env.VCRAFT_TEST_DATABASE_URL;

describe.skipIf(!testUrl)('Trading Workflow Concurrency Races on PostgreSQL (BR-05, BR-15, BR-16, BR-20, BR-21, BR-25, BR-27)', () => {
  let ctx: PgTestContext;
  beforeAll(async () => { ctx = await createPgTestContext(testUrl!); });
  afterAll(async () => { await ctx?.close(); });

  it('1. Accept vs Withdraw (both orders): strict mutual exclusion without deadlocks (BR-15, BR-20, BR-27)', async () => {
    // Order A: Accept commits first -> Withdraw rejects 422 INVALID_STATE
    await withSeededFixture(ctx.db, { requestStatus: 'artisans_bidding', requestVersion: 2 }, async (f) => {
      const base = await createPgTradingStack(ctx.db, ctx.txRunner);
      const gate = createDeferred<void>();
      const { acceptWorkflow } = await createPgTradingStack(ctx.db, ctx.txRunner, { allocationRepo: gateMethod(base.repos.allocationRepo, 'create', gate) });
      const [acceptRes, withdrawRes] = await runGatedRace(gate, acceptWorkflow.execute(acceptInputFor(f)), () =>
        base.useCases.withdraw.execute({
          actor: f.workshops[0].artisanActor,
          requestId: f.requestId.toString(),
          expectedRecipientVersion: 2,
          expectedQuoteVersion: 1,
          withdrawReason: 'Rút báo giá đồng thời',
          now: f.now,
        }),
      );
      expect(acceptRes.status).toBe('fulfilled');
      expect(withdrawRes.status).toBe('rejected');
      expect((withdrawRes as PromiseRejectedResult).reason).toBeInstanceOf(InvalidStateTransitionError);
      expectHttpProblem((withdrawRes as PromiseRejectedResult).reason, 422, 'INVALID_STATE');
      expect(await ctx.db.allocation.count({ where: { request_id: f.requestId } })).toBe(1);
    });

    // Order B: Withdraw commits first -> Accept rejects stale v1 with 409 CONCURRENCY_CONFLICT
    await withSeededFixture(ctx.db, { requestStatus: 'artisans_bidding', requestVersion: 2 }, async (f) => {
      const base = await createPgTradingStack(ctx.db, ctx.txRunner);
      const gate = createDeferred<void>();
      const { useCases } = await createPgTradingStack(ctx.db, ctx.txRunner, { quoteRepo: gateMethod(base.repos.quoteRepo, 'update', gate) });
      const [withdrawRes, acceptRes] = await runGatedRace(
        gate,
        useCases.withdraw.execute({
          actor: f.workshops[0].artisanActor,
          requestId: f.requestId.toString(),
          expectedRecipientVersion: 2,
          expectedQuoteVersion: 1,
          withdrawReason: 'Xưởng rút trước khi chốt',
          now: f.now,
        }),
        () => base.acceptWorkflow.execute(acceptInputFor(f)),
      );
      expect(withdrawRes.status).toBe('fulfilled');
      expect(acceptRes.status).toBe('rejected');
      expect((acceptRes as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrencyConflictError);
      expectHttpProblem((acceptRes as PromiseRejectedResult).reason, 409, 'CONCURRENCY_CONFLICT');
      expect(await ctx.db.allocation.count({ where: { request_id: f.requestId } })).toBe(0);
    });
  });

  it('2. Accept vs Workshop Suspension (both orders): Workshop FOR UPDATE serialization (BR-05, BR-16, BR-27)', async () => {
    // Order A: Suspend commits first -> Accept rejects 422 WORKSHOP_SUSPENDED
    await withSeededFixture(ctx.db, { requestStatus: 'artisans_bidding', requestVersion: 2 }, async (f) => {
      const { wsContract, acceptWorkflow } = await createPgTradingStack(ctx.db, ctx.txRunner);
      const w = f.workshops[0];
      const gate = createDeferred<void>();
      const suspendP = ctx.txRunner.run(async (tx) => {
        await wsContract.changeStatus({ workshopId: w.workshopId.toString(), status: 'suspended', reason: 'Vi phạm quy chuẩn', actor: f.adminActor }, tx);
        gate.resolve();
        await delay(60);
      });
      const [suspendRes, acceptRes] = await runGatedRace(gate, suspendP, () => acceptWorkflow.execute(acceptInputFor(f)));
      expect(suspendRes.status).toBe('fulfilled');
      expect(acceptRes.status).toBe('rejected');
      expect((acceptRes as PromiseRejectedResult).reason).toBeInstanceOf(WorkshopSuspended);
      expectHttpProblem((acceptRes as PromiseRejectedResult).reason, 422, 'WORKSHOP_SUSPENDED');
      expect(await ctx.db.allocation.count({ where: { request_id: f.requestId } })).toBe(0);
    });

    // Order B: Accept commits first, Suspend waits & commits after -> Allocation remains intact (BR-05)
    await withSeededFixture(ctx.db, { requestStatus: 'artisans_bidding', requestVersion: 2 }, async (f) => {
      const base = await createPgTradingStack(ctx.db, ctx.txRunner);
      const w = f.workshops[0];
      const gate = createDeferred<void>();
      const gatedWs: IWorkshopContract = {
        ...base.wsContract,
        async lockAndAssertActive(ids, tx) {
          await base.wsContract.lockAndAssertActive(ids, tx);
          gate.resolve();
          await delay(60);
        },
      };
      const { acceptWorkflow } = await createPgTradingStack(ctx.db, ctx.txRunner, { workshopContract: gatedWs });
      const [acceptRes, suspendRes] = await runGatedRace(gate, acceptWorkflow.execute(acceptInputFor(f)), () =>
        ctx.txRunner.run((tx) => base.wsContract.changeStatus({ workshopId: w.workshopId.toString(), status: 'suspended', reason: 'Tạm ngừng sau chốt', actor: f.adminActor }, tx)),
      );
      expect([acceptRes.status, suspendRes.status]).toEqual(['fulfilled', 'fulfilled']);
      expect(await ctx.db.allocation.count({ where: { request_id: f.requestId } })).toBe(1);
      expect((await ctx.db.workshop.findUnique({ where: { id: w.workshopId } }))?.status).toBe('suspended');
    });
  });

  it('3. Admin Cancel vs Buyer Confirm Delivery (both orders): cancelled XOR delivered (BR-21, BR-25, BR-27)', async () => {
    const opts = { requestStatus: 'in_production' as const, requestVersion: 4, allocationStatus: 'handed_over' as const, allocationVersion: 3 };

    // Order A: Admin Cancel commits first -> Buyer Confirm rejects 422 INVALID_STATE
    await withSeededFixture(ctx.db, opts, async (f) => {
      const base = await createPgTradingStack(ctx.db, ctx.txRunner);
      const gate = createDeferred<void>();
      const { useCases } = await createPgTradingStack(ctx.db, ctx.txRunner, { quoteRequestRepo: gateMethod(base.repos.quoteRequestRepo, 'update', gate) });
      const [cancelRes, confirmRes] = await runGatedRace(
        gate,
        useCases.adminCancel.execute({
          actor: f.adminActor,
          requestId: f.requestId.toString(),
          expectedRequestVersion: 4,
          cancelReason: 'Thiên tai ngập xưởng trước khi xác nhận đủ',
          goodsHandlingNote: 'Hai bên đối soát ngoài hệ thống',
          now: f.now,
        }),
        () => base.useCases.confirmDelivery.execute({ actor: f.buyerActor, requestId: f.requestId.toString(), expectedRequestVersion: 4, now: f.now }),
      );
      expect(cancelRes.status).toBe('fulfilled');
      expect(confirmRes.status).toBe('rejected');
      expectHttpProblem((confirmRes as PromiseRejectedResult).reason, 422, 'INVALID_STATE');
      const req = await ctx.db.quoteRequest.findUnique({ where: { id: f.requestId } });
      expect(req?.status).toBe('in_production');
      expect(req?.cancelled_at).not.toBeNull();
    });

    // Order B: Buyer Confirm commits first -> Admin Cancel rejects stale v4 (409) and fresh v5 (422)
    await withSeededFixture(ctx.db, opts, async (f) => {
      const base = await createPgTradingStack(ctx.db, ctx.txRunner);
      const gate = createDeferred<void>();
      const { useCases } = await createPgTradingStack(ctx.db, ctx.txRunner, { quoteRequestRepo: gateMethod(base.repos.quoteRequestRepo, 'update', gate) });
      const [confirmRes, cancelRes] = await runGatedRace(
        gate,
        useCases.confirmDelivery.execute({ actor: f.buyerActor, requestId: f.requestId.toString(), expectedRequestVersion: 4, now: f.now }),
        () =>
          base.useCases.adminCancel.execute({
            actor: f.adminActor,
            requestId: f.requestId.toString(),
            expectedRequestVersion: 4,
            cancelReason: 'Hủy đồng thời khi Buyer xác nhận',
            goodsHandlingNote: 'Xử lý ngoài hệ thống',
            now: f.now,
          }),
      );
      expect(confirmRes.status).toBe('fulfilled');
      expect(cancelRes.status).toBe('rejected');
      expectHttpProblem((cancelRes as PromiseRejectedResult).reason, 409, 'CONCURRENCY_CONFLICT');
      await expectRejectsProblem(
        base.useCases.adminCancel.execute({ actor: f.adminActor, requestId: f.requestId.toString(), expectedRequestVersion: 5, cancelReason: 'Thử hủy Delivered', goodsHandlingNote: 'N/A', now: f.now }),
        422,
        'INVALID_STATE',
      );
    });
  });

  it('4. Concurrent same X-Idempotency-Key through TradingMutationInterceptor & AcceptQuotationWorkflow (BR-27)', async () => {
    // Part A: Same key + same payload via TradingMutationInterceptor -> 1 commit + 1 replay
    await withSeededFixture(ctx.db, { requestStatus: 'in_production', requestVersion: 4, allocationStatus: 'handed_over', allocationVersion: 3 }, async (f) => {
      const { interceptor, useCases } = await createPgTradingStack(ctx.db, ctx.txRunner);
      const waitBoth = createBarrier(2);
      const sharedKey = randomUUID();
      const options: TradingMutationOptions = { action: 'confirm_delivery', objectType: 'QuoteRequest', objectIdParam: 'id', expectedVersionField: 'expected_request_version' };
      const runOnce = () =>
        invokeThroughTradingInterceptor({
          interceptor,
          options,
          actor: f.buyerActor,
          objectId: f.requestId.toString(),
          idempotencyKey: sharedKey,
          body: { expected_request_version: 4 },
          handler: async (tx) => {
            await waitBoth();
            const out = await useCases.confirmDelivery.execute({ actor: f.buyerActor, requestId: f.requestId.toString(), expectedRequestVersion: 4, now: f.now, tx });
            return { data: out.request, currentState: out.currentState };
          },
        });
      const [r1, r2] = await Promise.all([runOnce(), runOnce()]);
      expect(r1.data).toEqual(r2.data);
      expect([r1.metadata?.operation?.replayed, r2.metadata?.operation?.replayed].sort()).toEqual([false, true]);
      expect(await ctx.db.statusLog.count({ where: { request_id: f.requestId, event_type: 'received_by_buyer' } })).toBe(1);
    });

    // Part B: Same key + different quote_id -> 1 commits + loser 409 IDEMPOTENCY_CONFLICT
    await withSeededFixture(ctx.db, { requestStatus: 'artisans_bidding', requestVersion: 2, workshopCount: 2 }, async (f) => {
      const { acceptWorkflow } = await createPgTradingStack(ctx.db, ctx.txRunner);
      const sharedKey = randomUUID();
      const results = await Promise.allSettled([0, 1].map((workshopIndex) => acceptWorkflow.execute(acceptInputFor(f, { workshopIndex, idempotencyKey: sharedKey }))));
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect([fulfilled.length, rejected.length]).toEqual([1, 1]);
      expect(rejected[0].reason).toBeInstanceOf(IdempotencyConflictError);
      expectHttpProblem(rejected[0].reason, 409, 'IDEMPOTENCY_CONFLICT');
    });
  });

  it('5. Idempotency replay after state progression returns original snapshot + fresh current_state (BR-27)', async () => {
    await withSeededFixture(ctx.db, { requestStatus: 'artisans_bidding', requestVersion: 2 }, async (f) => {
      const { acceptWorkflow, useCases } = await createPgTradingStack(ctx.db, ctx.txRunner);
      const input = acceptInputFor(f, { idempotencyKey: randomUUID() });
      const initial = await acceptWorkflow.execute(input);
      expect(initial.operation?.replayed).toBe(false);

      await useCases.startProduction.execute({ actor: f.workshops[0].artisanActor, allocationId: initial.data.allocations[0].id, expectedAllocationVersion: 1, now: new Date(f.now.getTime() + 60_000) });
      const cancelTime = new Date(f.now.getTime() + 120_000);
      await useCases.adminCancel.execute({ actor: f.adminActor, requestId: f.requestId.toString(), expectedRequestVersion: 4, cancelReason: 'Hủy sau sản xuất', goodsHandlingNote: 'Chưa giao', now: cancelTime });

      const replayed = await acceptWorkflow.execute({ ...input, now: new Date(f.now.getTime() + 180_000) });
      expect(replayed.operation?.replayed).toBe(true);
      expect(replayed.data).toEqual(initial.data);
      expect(replayed.operation?.current_state.request).toEqual({ id: f.requestId.toString(), status: 'in_production', version: 5, cancelled_at: cancelTime.toISOString() });
    });
  });
});
