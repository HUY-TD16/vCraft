import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransactionContext } from '../../../src/common/application/ports/transaction-runner';
import type { AuthenticatedActor } from '../../../src/common/application/types/contract-types';
import { HttpResult } from '../../../src/common/http/interceptors/response-envelope.interceptor';
import { authenticatedActors } from '../../../src/common/security/guards/authenticated-request';
import type { PrismaService } from '../../../src/infrastructure/database/prisma/prisma.service';
import type { PrismaTransactionRunner } from '../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import {
  TRADING_MUTATION_METADATA_KEY,
  TRADING_TX_REQUEST_KEY,
  TradingCurrentStateResolver,
  TradingMutationInterceptor,
  type TradingMutationOptions,
} from '../../../src/modules/trading/adapters/http';
import {
  ConcurrencyConflictError,
  IdempotencyConflictError,
  InvalidStateTransitionError,
  QuoteRequestNotFoundError,
} from '../../../src/modules/trading/domain';
import { WorkshopSuspended } from '../../../src/modules/workshops/domain/errors/workshop-suspended';
import type { IWorkshopContract } from '../../../src/modules/workshops/public/contracts/workshop.contract';
import {
  cleanupTradingFixture,
  createBarrier,
  createDeferred,
  createPgCatalogContract,
  createPgWorkshopContract,
  mapErrorToProblemDetails,
  seedTradingFixture,
} from '../../support/pg-trading-harness';

const testUrl = process.env.VCRAFT_TEST_DATABASE_URL;

/**
 * Helper to invoke the production `TradingMutationInterceptor` directly against
 * PostgreSQL-backed `TradingIdempotencyService` + `TradingCurrentStateResolver`.
 */
async function invokeThroughTradingInterceptor<TData>(params: {
  readonly interceptor: TradingMutationInterceptor;
  readonly options: TradingMutationOptions;
  readonly actor: AuthenticatedActor;
  readonly objectId: string;
  readonly idempotencyKey: string;
  readonly body: Record<string, unknown>;
  readonly handler: (tx: TransactionContext) => Promise<{
    readonly data: TData;
    readonly currentState: unknown;
  }>;
}): Promise<HttpResult<TData, unknown>> {
  const req: Record<PropertyKey, unknown> = {
    headers: { 'x-idempotency-key': params.idempotencyKey },
    params: { id: params.objectId },
    body: params.body,
    get(headerName: string) {
      return headerName.toLowerCase() === 'x-idempotency-key'
        ? params.idempotencyKey
        : undefined;
    },
  };
  authenticatedActors.set(req as never, params.actor);

  const res = {
    statusCode: 200,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
  };

  const handlerFn = () => undefined;
  class SyntheticController {}
  Reflect.defineMetadata(
    TRADING_MUTATION_METADATA_KEY,
    params.options,
    handlerFn,
  );

  const executionContext = {
    getHandler: () => handlerFn,
    getClass: () => SyntheticController,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;

  const next: CallHandler = {
    handle: () =>
      from(
        Promise.resolve().then(() => {
          const tx = req[TRADING_TX_REQUEST_KEY] as
            | TransactionContext
            | undefined;
          if (!tx) {
            throw new Error(
              'Expected TradingMutationInterceptor to attach active TransactionContext.',
            );
          }
          return params.handler(tx);
        }),
      ),
  };

  const obs$ = await params.interceptor.intercept(executionContext, next);
  return new Promise<HttpResult<TData, unknown>>((resolve, reject) => {
    let resolvedValue: HttpResult<TData, unknown> | undefined;
    obs$.subscribe({
      next: (val) => {
        resolvedValue = val as HttpResult<TData, unknown>;
      },
      error: reject,
      complete: () => {
        if (!resolvedValue) {
          reject(new Error('Interceptor observable completed without emitting.'));
          return;
        }
        resolve(resolvedValue);
      },
    });
  });
}

describe.skipIf(!testUrl)(
  'Task 40: Workflow Concurrency & Race Conditions Integration on PostgreSQL',
  () => {
    let db: PrismaService;
    let txRunner: PrismaTransactionRunner;

    beforeAll(async () => {
      const { PrismaService } = await import(
        '../../../src/infrastructure/database/prisma/prisma.service'
      );
      const { PrismaTransactionRunner } = await import(
        '../../../src/infrastructure/database/transactions/prisma-transaction-runner'
      );
      db = new PrismaService({ DATABASE_URL: testUrl! });
      txRunner = new PrismaTransactionRunner(db);
    });

    afterAll(async () => {
      await db?.$disconnect();
    });

    // =========================================================================
    // 1. Accept vs Withdraw / Workshop Suspension / Price Edit / Cancel / Send vs Delete
    // =========================================================================
    describe('1) Accept-Quote racing with Withdraw / Workshop Suspension / Edit / Cancel (BR-05, BR-15, BR-16, BR-20, BR-27, AT-13)', () => {
      it('Accept vs Withdraw — Order A (Accept commits first): Withdraw blocks on FOR UPDATE and rejects with 422 INVALID_STATE', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaRequestRecipientRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository'
        );
        const { PrismaQuoteRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { PrismaIdempotencyRecordRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository'
        );
        const { TradingAcceptanceService } = await import(
          '../../../src/modules/trading/application/services/trading-acceptance.service'
        );
        const { WithdrawQuoteUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/quotations/withdraw-quote.use-case'
        );
        const { AcceptQuotationWorkflow } = await import(
          '../../../src/workflows/accept-quotation'
        );

        const fixture = await seedTradingFixture(db, {
          requestStatus: 'artisans_bidding',
          requestVersion: 2,
          workshopCount: 1,
        });

        try {
          const wsContract = createPgWorkshopContract(db, txRunner);
          const realAllocRepo = new PrismaAllocationRepository(txRunner);
          const acceptLockedGate = createDeferred<void>();

          const gatedAllocRepo = Object.assign(
            Object.create(Object.getPrototypeOf(realAllocRepo)),
            realAllocRepo,
            {
              create: async (
                ...args: Parameters<typeof realAllocRepo.create>
              ) => {
                // Accept now holds Workshop -> QuoteRequest -> RequestRecipient -> Quote FOR UPDATE locks
                acceptLockedGate.resolve();
                await delay(60);
                return realAllocRepo.create(...args);
              },
            },
          ) as InstanceType<typeof PrismaAllocationRepository>;

          const acceptWorkflow = new AcceptQuotationWorkflow(
            txRunner,
            new TradingAcceptanceService(
              new PrismaQuoteRequestRepository(txRunner),
              new PrismaRequestRecipientRepository(txRunner),
              new PrismaQuoteRepository(txRunner),
              gatedAllocRepo,
              new PrismaIdempotencyRecordRepository(txRunner),
              wsContract,
            ),
            wsContract,
          );

          const withdrawUseCase = new WithdrawQuoteUseCase(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
            new PrismaRequestRecipientRepository(txRunner),
            new PrismaQuoteRepository(txRunner),
            wsContract,
          );

          const w = fixture.workshops[0];
          const acceptPromise = acceptWorkflow.execute({
            actor: fixture.buyerActor,
            requestId: fixture.requestId.toString(),
            quoteId: w.quoteId!.toString(),
            expectedRequestVersion: 2,
            expectedQuoteVersion: 1,
            idempotencyKey: randomUUID(),
            now: fixture.now,
          });
          acceptPromise.catch(() => acceptLockedGate.resolve());

          await acceptLockedGate.promise;
          const withdrawPromise = withdrawUseCase.execute({
            actor: w.artisanActor,
            requestId: fixture.requestId.toString(),
            expectedRecipientVersion: 2,
            expectedQuoteVersion: 1,
            withdrawReason: 'Lò nung gặp sự cố ngay lúc Buyer đang chốt',
            now: fixture.now,
          });

          const [acceptRes, withdrawRes] = await Promise.allSettled([
            acceptPromise,
            withdrawPromise,
          ]);

          expect(acceptRes.status).toBe('fulfilled');
          expect(withdrawRes.status).toBe('rejected');
          if (withdrawRes.status === 'rejected') {
            expect(withdrawRes.reason).toBeInstanceOf(InvalidStateTransitionError);
            const problem = mapErrorToProblemDetails(withdrawRes.reason);
            expect(problem.statusCode).toBe(422);
            expect(problem.body.code).toBe('INVALID_STATE');
          }

          const persistedReq = await db.quoteRequest.findUnique({
            where: { id: fixture.requestId },
          });
          expect(persistedReq?.status).toBe('buyer_accepted');
          expect(persistedReq?.version).toBe(3);

          const persistedQuote = await db.quote.findUnique({
            where: { id: w.quoteId! },
          });
          expect(persistedQuote?.status).toBe('accepted');
          expect(persistedQuote?.version).toBe(2);
          expect(persistedQuote?.withdrawn_at).toBeNull();

          expect(
            await db.allocation.count({ where: { request_id: fixture.requestId } }),
          ).toBe(1);

          const histories = await db.recipientResponseHistory.findMany({
            where: { recipient_id: w.recipientId! },
          });
          expect(histories.map((h) => h.event_type)).toEqual(['quote_accepted']);
        } finally {
          await cleanupTradingFixture(db, fixture);
        }
      });

      it('Accept vs Withdraw — Order B (Withdraw commits first): Accept rejects stale v1 with 409 CONCURRENCY_CONFLICT and fresh v2 with 422 INVALID_STATE', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaRequestRecipientRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository'
        );
        const { PrismaQuoteRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { PrismaIdempotencyRecordRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository'
        );
        const { TradingAcceptanceService } = await import(
          '../../../src/modules/trading/application/services/trading-acceptance.service'
        );
        const { WithdrawQuoteUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/quotations/withdraw-quote.use-case'
        );
        const { AcceptQuotationWorkflow } = await import(
          '../../../src/workflows/accept-quotation'
        );

        const fixture = await seedTradingFixture(db, {
          requestStatus: 'artisans_bidding',
          requestVersion: 2,
          workshopCount: 1,
        });

        try {
          const wsContract = createPgWorkshopContract(db, txRunner);
          const realQuoteRepo = new PrismaQuoteRepository(txRunner);
          const withdrawLockedGate = createDeferred<void>();

          const gatedWithdrawQuoteRepo = Object.assign(
            Object.create(Object.getPrototypeOf(realQuoteRepo)),
            realQuoteRepo,
            {
              update: async (
                ...args: Parameters<typeof realQuoteRepo.update>
              ) => {
                withdrawLockedGate.resolve();
                await delay(60);
                return realQuoteRepo.update(...args);
              },
            },
          ) as InstanceType<typeof PrismaQuoteRepository>;

          const withdrawUseCase = new WithdrawQuoteUseCase(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
            new PrismaRequestRecipientRepository(txRunner),
            gatedWithdrawQuoteRepo,
            wsContract,
          );
          const acceptWorkflow = new AcceptQuotationWorkflow(
            txRunner,
            new TradingAcceptanceService(
              new PrismaQuoteRequestRepository(txRunner),
              new PrismaRequestRecipientRepository(txRunner),
              new PrismaQuoteRepository(txRunner),
              new PrismaAllocationRepository(txRunner),
              new PrismaIdempotencyRecordRepository(txRunner),
              wsContract,
            ),
            wsContract,
          );

          const w = fixture.workshops[0];
          const withdrawPromise = withdrawUseCase.execute({
            actor: w.artisanActor,
            requestId: fixture.requestId.toString(),
            expectedRecipientVersion: 2,
            expectedQuoteVersion: 1,
            withdrawReason: 'Hộ rút báo giá trước khi Buyer chốt',
            now: fixture.now,
          });
          withdrawPromise.catch(() => withdrawLockedGate.resolve());

          await withdrawLockedGate.promise;
          const acceptPromise = acceptWorkflow.execute({
            actor: fixture.buyerActor,
            requestId: fixture.requestId.toString(),
            quoteId: w.quoteId!.toString(),
            expectedRequestVersion: 2,
            expectedQuoteVersion: 1,
            idempotencyKey: randomUUID(),
            now: fixture.now,
          });

          const [withdrawRes, acceptRes] = await Promise.allSettled([
            withdrawPromise,
            acceptPromise,
          ]);

          expect(withdrawRes.status).toBe('fulfilled');
          expect(acceptRes.status).toBe('rejected');
          if (acceptRes.status === 'rejected') {
            expect(acceptRes.reason).toBeInstanceOf(ConcurrencyConflictError);
            const problem = mapErrorToProblemDetails(acceptRes.reason);
            expect(problem.statusCode).toBe(409);
            expect(problem.body.code).toBe('CONCURRENCY_CONFLICT');
          }

          // Retrying with the refreshed Quote version (v2) must still reject with 422 INVALID_STATE
          await expect(
            acceptWorkflow.execute({
              actor: fixture.buyerActor,
              requestId: fixture.requestId.toString(),
              quoteId: w.quoteId!.toString(),
              expectedRequestVersion: 2,
              expectedQuoteVersion: 2,
              idempotencyKey: randomUUID(),
              now: fixture.now,
            }),
          ).rejects.toBeInstanceOf(InvalidStateTransitionError);

          const persistedQuote = await db.quote.findUnique({
            where: { id: w.quoteId! },
          });
          expect(persistedQuote?.status).toBe('withdrawn');
          expect(persistedQuote?.version).toBe(2);
          expect(
            await db.allocation.count({ where: { request_id: fixture.requestId } }),
          ).toBe(0);
          expect(
            await db.idempotencyRecord.count({
              where: { account_id: fixture.buyerId },
            }),
          ).toBe(0);
        } finally {
          await cleanupTradingFixture(db, fixture);
        }
      });

      it('Accept vs Workshop Suspension — Order A (Suspend commits first): Accept blocks on Workshop FOR UPDATE and rejects with 422 WORKSHOP_SUSPENDED', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaRequestRecipientRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository'
        );
        const { PrismaQuoteRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { PrismaIdempotencyRecordRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository'
        );
        const { TradingAcceptanceService } = await import(
          '../../../src/modules/trading/application/services/trading-acceptance.service'
        );
        const { AcceptQuotationWorkflow } = await import(
          '../../../src/workflows/accept-quotation'
        );

        const fixture = await seedTradingFixture(db, {
          requestStatus: 'artisans_bidding',
          requestVersion: 2,
          workshopCount: 1,
        });

        try {
          const wsContract = createPgWorkshopContract(db, txRunner);
          const acceptWorkflow = new AcceptQuotationWorkflow(
            txRunner,
            new TradingAcceptanceService(
              new PrismaQuoteRequestRepository(txRunner),
              new PrismaRequestRecipientRepository(txRunner),
              new PrismaQuoteRepository(txRunner),
              new PrismaAllocationRepository(txRunner),
              new PrismaIdempotencyRecordRepository(txRunner),
              wsContract,
            ),
            wsContract,
          );

          const w = fixture.workshops[0];
          const suspendLockedGate = createDeferred<void>();

          const suspendPromise = txRunner.run(async (tx) => {
            await wsContract.changeStatus(
              {
                workshopId: w.workshopId.toString(),
                status: 'suspended',
                reason: 'Tạm ngừng hộ vì vi phạm quy chuẩn môi trường lò nung',
                actor: fixture.adminActor,
              },
              tx,
            );
            suspendLockedGate.resolve();
            await delay(60);
          });
          suspendPromise.catch(() => suspendLockedGate.resolve());

          await suspendLockedGate.promise;
          const acceptPromise = acceptWorkflow.execute({
            actor: fixture.buyerActor,
            requestId: fixture.requestId.toString(),
            quoteId: w.quoteId!.toString(),
            expectedRequestVersion: 2,
            expectedQuoteVersion: 1,
            idempotencyKey: randomUUID(),
            now: fixture.now,
          });

          const [suspendRes, acceptRes] = await Promise.allSettled([
            suspendPromise,
            acceptPromise,
          ]);

          expect(suspendRes.status).toBe('fulfilled');
          expect(acceptRes.status).toBe('rejected');
          if (acceptRes.status === 'rejected') {
            expect(acceptRes.reason).toBeInstanceOf(WorkshopSuspended);
            const problem = mapErrorToProblemDetails(acceptRes.reason);
            expect(problem.statusCode).toBe(422);
            expect(problem.body.code).toBe('WORKSHOP_SUSPENDED');
          }

          expect(
            await db.allocation.count({ where: { request_id: fixture.requestId } }),
          ).toBe(0);
          expect(
            await db.idempotencyRecord.count({
              where: { account_id: fixture.buyerId },
            }),
          ).toBe(0);
          expect(
            await db.workshopStatusLog.count({
              where: { workshop_id: w.workshopId, new_status: 'suspended' },
            }),
          ).toBe(1);
        } finally {
          await cleanupTradingFixture(db, fixture);
        }
      });

      it('Accept vs Workshop Suspension — Order B (Accept commits first, Suspend waits & commits after): Allocation remains intact and suspended Artisan can still start & hand over (BR-05)', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaRequestRecipientRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository'
        );
        const { PrismaQuoteRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { PrismaIdempotencyRecordRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository'
        );
        const { TradingAcceptanceService } = await import(
          '../../../src/modules/trading/application/services/trading-acceptance.service'
        );
        const { StartAllocationProductionUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/start-allocation-production.use-case'
        );
        const { HandoverAllocationUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/handover-allocation.use-case'
        );
        const { AcceptQuotationWorkflow } = await import(
          '../../../src/workflows/accept-quotation'
        );

        const fixture = await seedTradingFixture(db, {
          requestStatus: 'artisans_bidding',
          requestVersion: 2,
          workshopCount: 1,
        });

        try {
          const wsContract = createPgWorkshopContract(db, txRunner);
          const acceptLockedWsGate = createDeferred<void>();
          const gatedWsContract: IWorkshopContract = {
            ...wsContract,
            async lockAndAssertActive(ids, tx) {
              await wsContract.lockAndAssertActive(ids, tx);
              acceptLockedWsGate.resolve();
              await delay(60);
            },
          };

          const acceptWorkflow = new AcceptQuotationWorkflow(
            txRunner,
            new TradingAcceptanceService(
              new PrismaQuoteRequestRepository(txRunner),
              new PrismaRequestRecipientRepository(txRunner),
              new PrismaQuoteRepository(txRunner),
              new PrismaAllocationRepository(txRunner),
              new PrismaIdempotencyRecordRepository(txRunner),
              gatedWsContract,
            ),
            gatedWsContract,
          );

          const w = fixture.workshops[0];
          const acceptPromise = acceptWorkflow.execute({
            actor: fixture.buyerActor,
            requestId: fixture.requestId.toString(),
            quoteId: w.quoteId!.toString(),
            expectedRequestVersion: 2,
            expectedQuoteVersion: 1,
            idempotencyKey: randomUUID(),
            now: fixture.now,
          });
          acceptPromise.catch(() => acceptLockedWsGate.resolve());

          await acceptLockedWsGate.promise;
          const suspendPromise = txRunner.run((tx) =>
            wsContract.changeStatus(
              {
                workshopId: w.workshopId.toString(),
                status: 'suspended',
                reason: 'Tạm ngừng nhận việc mới sau khi đã chốt đơn',
                actor: fixture.adminActor,
              },
              tx,
            ),
          );

          const [acceptRes, suspendRes] = await Promise.allSettled([
            acceptPromise,
            suspendPromise,
          ]);

          expect(acceptRes.status).toBe('fulfilled');
          expect(suspendRes.status).toBe('fulfilled');

          const alloc = await db.allocation.findFirst({
            where: { request_id: fixture.requestId },
          });
          expect(alloc).not.toBeNull();
          expect(alloc?.status).toBe('not_started');

          const wsAfter = await db.workshop.findUnique({
            where: { id: w.workshopId },
          });
          expect(wsAfter?.status).toBe('suspended');

          // BR-05 verification: suspended workshop can STILL complete previously awarded Allocation
          const startUseCase = new StartAllocationProductionUseCase(
            txRunner,
            new PrismaAllocationRepository(txRunner),
            new PrismaQuoteRequestRepository(txRunner),
            wsContract,
          );
          const started = await startUseCase.execute({
            actor: w.artisanActor,
            allocationId: alloc!.id.toString(),
            expectedAllocationVersion: 1,
            now: fixture.now,
          });
          expect(started.allocation.status).toBe('in_production');
          expect(started.allocation.version).toBe(2);

          const handoverUseCase = new HandoverAllocationUseCase(
            txRunner,
            new PrismaAllocationRepository(txRunner),
            new PrismaQuoteRequestRepository(txRunner),
            wsContract,
          );
          const handedOver = await handoverUseCase.execute({
            actor: w.artisanActor,
            allocationId: alloc!.id.toString(),
            expectedAllocationVersion: 2,
            deliveryNote: 'Hộ tạm ngừng vẫn bàn giao đủ phần việc đã chốt',
            now: fixture.now,
          });
          expect(handedOver.allocation.status).toBe('handed_over');
          expect(handedOver.allocation.version).toBe(3);
        } finally {
          await cleanupTradingFixture(db, fixture);
        }
      });

      it('Accept vs Edit Quote Price (SubmitQuoteUseCase): both commit orders prevent accepting a silently modified price (UC-16, UC-19, BR-27)', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaRequestRecipientRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository'
        );
        const { PrismaQuoteRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { PrismaIdempotencyRecordRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository'
        );
        const { TradingAcceptanceService } = await import(
          '../../../src/modules/trading/application/services/trading-acceptance.service'
        );
        const { SubmitQuoteUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/quotations/submit-quote.use-case'
        );
        const { AcceptQuotationWorkflow } = await import(
          '../../../src/workflows/accept-quotation'
        );

        // Order A: Artisan edits price (45,000 -> 55,000, v1 -> v2) first; Buyer accept holding v1 gets 409 CONCURRENCY_CONFLICT
        const fixtureA = await seedTradingFixture(db, {
          requestStatus: 'artisans_bidding',
          requestVersion: 2,
          workshopCount: 1,
        });
        try {
          const wsContract = createPgWorkshopContract(db, txRunner);
          const realQuoteRepo = new PrismaQuoteRepository(txRunner);
          const editLockedGate = createDeferred<void>();

          const gatedEditQuoteRepo = Object.assign(
            Object.create(Object.getPrototypeOf(realQuoteRepo)),
            realQuoteRepo,
            {
              update: async (
                ...args: Parameters<typeof realQuoteRepo.update>
              ) => {
                editLockedGate.resolve();
                await delay(60);
                return realQuoteRepo.update(...args);
              },
            },
          ) as InstanceType<typeof PrismaQuoteRepository>;

          const submitQuoteUseCase = new SubmitQuoteUseCase(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
            new PrismaRequestRecipientRepository(txRunner),
            gatedEditQuoteRepo,
            wsContract,
          );
          const acceptWorkflow = new AcceptQuotationWorkflow(
            txRunner,
            new TradingAcceptanceService(
              new PrismaQuoteRequestRepository(txRunner),
              new PrismaRequestRecipientRepository(txRunner),
              new PrismaQuoteRepository(txRunner),
              new PrismaAllocationRepository(txRunner),
              new PrismaIdempotencyRecordRepository(txRunner),
              wsContract,
            ),
            wsContract,
          );

          const wA = fixtureA.workshops[0];
          const editPromise = submitQuoteUseCase.execute({
            actor: wA.artisanActor,
            requestId: fixtureA.requestId.toString(),
            expectedRecipientVersion: 2,
            expectedQuoteVersion: 1,
            unitPrice: 55000,
            maxQuantity: 500,
            bidAcceptDeadline: fixtureA.bidAcceptDeadline,
            committedDeliveryAt: fixtureA.committedDeliveryAt,
            now: fixtureA.now,
          });
          editPromise.catch(() => editLockedGate.resolve());

          await editLockedGate.promise;
          const acceptPromise = acceptWorkflow.execute({
            actor: fixtureA.buyerActor,
            requestId: fixtureA.requestId.toString(),
            quoteId: wA.quoteId!.toString(),
            expectedRequestVersion: 2,
            expectedQuoteVersion: 1,
            idempotencyKey: randomUUID(),
            now: fixtureA.now,
          });

          const [editRes, acceptRes] = await Promise.allSettled([
            editPromise,
            acceptPromise,
          ]);
          expect(editRes.status).toBe('fulfilled');
          expect(acceptRes.status).toBe('rejected');
          if (acceptRes.status === 'rejected') {
            expect(acceptRes.reason).toBeInstanceOf(ConcurrencyConflictError);
            expect(mapErrorToProblemDetails(acceptRes.reason).statusCode).toBe(409);
          }

          const quoteAfterA = await db.quote.findUnique({
            where: { id: wA.quoteId! },
          });
          expect(Number(quoteAfterA?.unit_price)).toBe(55000);
          expect(quoteAfterA?.version).toBe(2);
          expect(quoteAfterA?.status).toBe('active');
          expect(
            await db.allocation.count({ where: { request_id: fixtureA.requestId } }),
          ).toBe(0);
        } finally {
          await cleanupTradingFixture(db, fixtureA);
        }

        // Order B: Buyer accepts first (at 45,000); Artisan edit blocks on Workshop FOR UPDATE and fails without altering price
        const fixtureB = await seedTradingFixture(db, {
          requestStatus: 'artisans_bidding',
          requestVersion: 2,
          workshopCount: 1,
        });
        try {
          const wsContract = createPgWorkshopContract(db, txRunner);
          const acceptLockedGate = createDeferred<void>();
          const gatedWsContract: IWorkshopContract = {
            ...wsContract,
            async lockAndAssertActive(ids, tx) {
              await wsContract.lockAndAssertActive(ids, tx);
              acceptLockedGate.resolve();
              await delay(60);
            },
          };

          const acceptWorkflow = new AcceptQuotationWorkflow(
            txRunner,
            new TradingAcceptanceService(
              new PrismaQuoteRequestRepository(txRunner),
              new PrismaRequestRecipientRepository(txRunner),
              new PrismaQuoteRepository(txRunner),
              new PrismaAllocationRepository(txRunner),
              new PrismaIdempotencyRecordRepository(txRunner),
              gatedWsContract,
            ),
            gatedWsContract,
          );
          const submitQuoteUseCase = new SubmitQuoteUseCase(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
            new PrismaRequestRecipientRepository(txRunner),
            new PrismaQuoteRepository(txRunner),
            wsContract,
          );

          const wB = fixtureB.workshops[0];
          const acceptPromise = acceptWorkflow.execute({
            actor: fixtureB.buyerActor,
            requestId: fixtureB.requestId.toString(),
            quoteId: wB.quoteId!.toString(),
            expectedRequestVersion: 2,
            expectedQuoteVersion: 1,
            idempotencyKey: randomUUID(),
            now: fixtureB.now,
          });
          acceptPromise.catch(() => acceptLockedGate.resolve());

          await acceptLockedGate.promise;
          const editPromise = submitQuoteUseCase.execute({
            actor: wB.artisanActor,
            requestId: fixtureB.requestId.toString(),
            expectedRecipientVersion: 2,
            expectedQuoteVersion: 1,
            unitPrice: 55000,
            maxQuantity: 500,
            bidAcceptDeadline: fixtureB.bidAcceptDeadline,
            committedDeliveryAt: fixtureB.committedDeliveryAt,
            now: fixtureB.now,
          });

          const [acceptRes, editRes] = await Promise.allSettled([
            acceptPromise,
            editPromise,
          ]);
          expect(acceptRes.status).toBe('fulfilled');
          expect(editRes.status).toBe('rejected');
          if (editRes.status === 'rejected') {
            expect(editRes.reason).toBeInstanceOf(ConcurrencyConflictError);
          }

          const allocB = await db.allocation.findFirst({
            where: { request_id: fixtureB.requestId },
          });
          expect(Number(allocB?.unit_price)).toBe(45000);
          const quoteAfterB = await db.quote.findUnique({
            where: { id: wB.quoteId! },
          });
          expect(quoteAfterB?.status).toBe('accepted');
          expect(Number(quoteAfterB?.unit_price)).toBe(45000);
        } finally {
          await cleanupTradingFixture(db, fixtureB);
        }
      });

      it('Accept vs Buyer Cancel (CancelQuoteRequestByBuyerUseCase): both commit orders enforce strict mutual exclusion', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaRequestRecipientRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository'
        );
        const { PrismaQuoteRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { PrismaIdempotencyRecordRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository'
        );
        const { TradingAcceptanceService } = await import(
          '../../../src/modules/trading/application/services/trading-acceptance.service'
        );
        const { CancelQuoteRequestByBuyerUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/cancel-quote-request-by-buyer.use-case'
        );
        const { AcceptQuotationWorkflow } = await import(
          '../../../src/workflows/accept-quotation'
        );

        // Order A: Buyer Cancel commits first; Accept blocks on QuoteRequest FOR UPDATE then rejects with 422 INVALID_STATE
        const fixtureA = await seedTradingFixture(db, {
          requestStatus: 'artisans_bidding',
          requestVersion: 2,
          workshopCount: 1,
        });
        try {
          const wsContract = createPgWorkshopContract(db, txRunner);
          const realReqRepo = new PrismaQuoteRequestRepository(txRunner);
          const cancelLockedGate = createDeferred<void>();

          const gatedCancelReqRepo = Object.assign(
            Object.create(Object.getPrototypeOf(realReqRepo)),
            realReqRepo,
            {
              update: async (
                ...args: Parameters<typeof realReqRepo.update>
              ) => {
                cancelLockedGate.resolve();
                await delay(60);
                return realReqRepo.update(...args);
              },
            },
          ) as InstanceType<typeof PrismaQuoteRequestRepository>;

          const cancelUseCase = new CancelQuoteRequestByBuyerUseCase(
            txRunner,
            gatedCancelReqRepo,
          );
          const acceptWorkflow = new AcceptQuotationWorkflow(
            txRunner,
            new TradingAcceptanceService(
              new PrismaQuoteRequestRepository(txRunner),
              new PrismaRequestRecipientRepository(txRunner),
              new PrismaQuoteRepository(txRunner),
              new PrismaAllocationRepository(txRunner),
              new PrismaIdempotencyRecordRepository(txRunner),
              wsContract,
            ),
            wsContract,
          );

          const wA = fixtureA.workshops[0];
          const cancelPromise = cancelUseCase.execute({
            actor: fixtureA.buyerActor,
            requestId: fixtureA.requestId.toString(),
            expectedRequestVersion: 2,
            cancelReason: 'Thay đổi kế hoạch đặt hàng',
            now: fixtureA.now,
          });
          cancelPromise.catch(() => cancelLockedGate.resolve());

          await cancelLockedGate.promise;
          const acceptPromise = acceptWorkflow.execute({
            actor: fixtureA.buyerActor,
            requestId: fixtureA.requestId.toString(),
            quoteId: wA.quoteId!.toString(),
            expectedRequestVersion: 2,
            expectedQuoteVersion: 1,
            idempotencyKey: randomUUID(),
            now: fixtureA.now,
          });

          const [cancelRes, acceptRes] = await Promise.allSettled([
            cancelPromise,
            acceptPromise,
          ]);
          expect(cancelRes.status).toBe('fulfilled');
          expect(acceptRes.status).toBe('rejected');
          if (acceptRes.status === 'rejected') {
            expect(acceptRes.reason).toBeInstanceOf(InvalidStateTransitionError);
          }

          const reqAfterA = await db.quoteRequest.findUnique({
            where: { id: fixtureA.requestId },
          });
          expect(reqAfterA?.status).toBe('artisans_bidding');
          expect(reqAfterA?.cancelled_at).not.toBeNull();
          expect(
            await db.allocation.count({ where: { request_id: fixtureA.requestId } }),
          ).toBe(0);
        } finally {
          await cleanupTradingFixture(db, fixtureA);
        }

        // Order B: Accept commits first; Buyer Cancel blocks on QuoteRequest FOR UPDATE then rejects
        const fixtureB = await seedTradingFixture(db, {
          requestStatus: 'artisans_bidding',
          requestVersion: 2,
          workshopCount: 1,
        });
        try {
          const wsContract = createPgWorkshopContract(db, txRunner);
          const realAllocRepo = new PrismaAllocationRepository(txRunner);
          const acceptLockedGate = createDeferred<void>();

          const gatedAllocRepo = Object.assign(
            Object.create(Object.getPrototypeOf(realAllocRepo)),
            realAllocRepo,
            {
              create: async (
                ...args: Parameters<typeof realAllocRepo.create>
              ) => {
                acceptLockedGate.resolve();
                await delay(60);
                return realAllocRepo.create(...args);
              },
            },
          ) as InstanceType<typeof PrismaAllocationRepository>;

          const acceptWorkflow = new AcceptQuotationWorkflow(
            txRunner,
            new TradingAcceptanceService(
              new PrismaQuoteRequestRepository(txRunner),
              new PrismaRequestRecipientRepository(txRunner),
              new PrismaQuoteRepository(txRunner),
              gatedAllocRepo,
              new PrismaIdempotencyRecordRepository(txRunner),
              wsContract,
            ),
            wsContract,
          );
          const cancelUseCase = new CancelQuoteRequestByBuyerUseCase(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
          );

          const wB = fixtureB.workshops[0];
          const acceptPromise = acceptWorkflow.execute({
            actor: fixtureB.buyerActor,
            requestId: fixtureB.requestId.toString(),
            quoteId: wB.quoteId!.toString(),
            expectedRequestVersion: 2,
            expectedQuoteVersion: 1,
            idempotencyKey: randomUUID(),
            now: fixtureB.now,
          });
          acceptPromise.catch(() => acceptLockedGate.resolve());

          await acceptLockedGate.promise;
          const cancelPromise = cancelUseCase.execute({
            actor: fixtureB.buyerActor,
            requestId: fixtureB.requestId.toString(),
            expectedRequestVersion: 2,
            cancelReason: 'Thử hủy khi đơn vừa được chốt',
            now: fixtureB.now,
          });

          const [acceptRes, cancelRes] = await Promise.allSettled([
            acceptPromise,
            cancelPromise,
          ]);
          expect(acceptRes.status).toBe('fulfilled');
          expect(cancelRes.status).toBe('rejected');
          if (cancelRes.status === 'rejected') {
            expect(cancelRes.reason).toBeInstanceOf(ConcurrencyConflictError);
          }

          const reqAfterB = await db.quoteRequest.findUnique({
            where: { id: fixtureB.requestId },
          });
          expect(reqAfterB?.status).toBe('buyer_accepted');
          expect(reqAfterB?.cancelled_at).toBeNull();
          expect(
            await db.allocation.count({ where: { request_id: fixtureB.requestId } }),
          ).toBe(1);
        } finally {
          await cleanupTradingFixture(db, fixtureB);
        }
      });

      it('Delete Draft vs SendRequestWorkflow: both commit orders leave zero orphan recipients or lost sent requests (UC-14, UC-15, api-design.md §13)', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaRequestRecipientRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository'
        );
        const { DeleteDraftQuoteRequestUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/delete-draft-quote-request.use-case'
        );
        const { SendRequestWorkflow } = await import(
          '../../../src/workflows/send-request/send-request.workflow'
        );

        // Order A: Send commits first; Delete blocks on QuoteRequest FOR UPDATE then rejects with 422 INVALID_STATE
        const fixtureA = await seedTradingFixture(db, {
          requestStatus: 'draft_request',
          requestVersion: 1,
          workshopCount: 1,
          seedPublishedProducts: true,
          seedRecipients: false,
          seedQuotes: false,
        });
        try {
          const wsContract = createPgWorkshopContract(db, txRunner);
          const catalogContract = createPgCatalogContract(txRunner);
          const realRecipientRepo = new PrismaRequestRecipientRepository(txRunner);
          const sendLockedGate = createDeferred<void>();

          const gatedRecipientRepo = Object.assign(
            Object.create(Object.getPrototypeOf(realRecipientRepo)),
            realRecipientRepo,
            {
              createMany: async (
                ...args: Parameters<typeof realRecipientRepo.createMany>
              ) => {
                sendLockedGate.resolve();
                await delay(60);
                return realRecipientRepo.createMany(...args);
              },
            },
          ) as InstanceType<typeof PrismaRequestRecipientRepository>;

          const sendWorkflow = new SendRequestWorkflow(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
            gatedRecipientRepo,
            catalogContract,
            wsContract,
          );
          const deleteUseCase = new DeleteDraftQuoteRequestUseCase(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
          );

          const sendPromise = sendWorkflow.execute({
            actor: fixtureA.buyerActor,
            requestId: fixtureA.requestId.toString(),
            expectedRequestVersion: 1,
            now: fixtureA.now,
          });
          sendPromise.catch(() => sendLockedGate.resolve());

          await sendLockedGate.promise;
          const deletePromise = deleteUseCase.execute({
            actor: fixtureA.buyerActor,
            requestId: fixtureA.requestId.toString(),
            expectedRequestVersion: 1,
          });

          const [sendRes, deleteRes] = await Promise.allSettled([
            sendPromise,
            deletePromise,
          ]);
          expect(sendRes.status).toBe('fulfilled');
          expect(deleteRes.status).toBe('rejected');
          if (deleteRes.status === 'rejected') {
            expect(deleteRes.reason).toBeInstanceOf(InvalidStateTransitionError);
          }

          const persistedA = await db.quoteRequest.findUnique({
            where: { id: fixtureA.requestId },
          });
          expect(persistedA?.status).toBe('sent_to_artisans');
          expect(
            await db.requestRecipient.count({
              where: { request_id: fixtureA.requestId },
            }),
          ).toBe(1);
        } finally {
          await cleanupTradingFixture(db, fixtureA);
        }

        // Order B: Delete commits first; Send blocks then rejects with 404 RESOURCE_NOT_FOUND
        const fixtureB = await seedTradingFixture(db, {
          requestStatus: 'draft_request',
          requestVersion: 1,
          workshopCount: 1,
          seedPublishedProducts: true,
          seedRecipients: false,
          seedQuotes: false,
        });
        try {
          const wsContract = createPgWorkshopContract(db, txRunner);
          const catalogContract = createPgCatalogContract(txRunner);
          const realReqRepo = new PrismaQuoteRequestRepository(txRunner);
          const deleteLockedGate = createDeferred<void>();

          const gatedDeleteReqRepo = Object.assign(
            Object.create(Object.getPrototypeOf(realReqRepo)),
            realReqRepo,
            {
              deleteDraft: async (
                ...args: Parameters<typeof realReqRepo.deleteDraft>
              ) => {
                deleteLockedGate.resolve();
                await delay(60);
                return realReqRepo.deleteDraft(...args);
              },
            },
          ) as InstanceType<typeof PrismaQuoteRequestRepository>;

          const deleteUseCase = new DeleteDraftQuoteRequestUseCase(
            txRunner,
            gatedDeleteReqRepo,
          );
          const sendWorkflow = new SendRequestWorkflow(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
            new PrismaRequestRecipientRepository(txRunner),
            catalogContract,
            wsContract,
          );

          const deletePromise = deleteUseCase.execute({
            actor: fixtureB.buyerActor,
            requestId: fixtureB.requestId.toString(),
            expectedRequestVersion: 1,
          });
          deletePromise.catch(() => deleteLockedGate.resolve());

          await deleteLockedGate.promise;
          const sendPromise = sendWorkflow.execute({
            actor: fixtureB.buyerActor,
            requestId: fixtureB.requestId.toString(),
            expectedRequestVersion: 1,
            now: fixtureB.now,
          });

          const [deleteRes, sendRes] = await Promise.allSettled([
            deletePromise,
            sendPromise,
          ]);
          expect(deleteRes.status).toBe('fulfilled');
          expect(sendRes.status).toBe('rejected');
          if (sendRes.status === 'rejected') {
            expect(sendRes.reason).toBeInstanceOf(QuoteRequestNotFoundError);
          }

          expect(
            await db.quoteRequest.findUnique({ where: { id: fixtureB.requestId } }),
          ).toBeNull();
          expect(
            await db.requestRecipient.count({
              where: { request_id: fixtureB.requestId },
            }),
          ).toBe(0);
        } finally {
          await cleanupTradingFixture(db, fixtureB);
        }
      });
    });

    // =========================================================================
    // 2. Cancel racing with Confirm Delivery & Handover
    // =========================================================================
    describe('2) Cancel racing with Confirm Delivery & Handover (UC-24, UC-25, UC-26, UC-27, BR-21, BR-22, BR-25, BR-27, AT-13)', () => {
      it('Admin Cancel vs Buyer Confirm Delivery — Order A (Admin Cancel commits first): Buyer Confirm blocks on QuoteRequest FOR UPDATE and rejects with 422 INVALID_STATE', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { CancelQuoteRequestByAdminUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/cancel-quote-request-by-admin.use-case'
        );
        const { ConfirmDeliveryUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/confirm-delivery.use-case'
        );

        const fixture = await seedTradingFixture(db, {
          requestStatus: 'in_production',
          requestVersion: 4,
          workshopCount: 1,
          allocationStatus: 'handed_over',
          allocationVersion: 3,
        });

        try {
          const realReqRepo = new PrismaQuoteRequestRepository(txRunner);
          const cancelLockedGate = createDeferred<void>();

          const gatedCancelReqRepo = Object.assign(
            Object.create(Object.getPrototypeOf(realReqRepo)),
            realReqRepo,
            {
              update: async (
                ...args: Parameters<typeof realReqRepo.update>
              ) => {
                cancelLockedGate.resolve();
                await delay(60);
                return realReqRepo.update(...args);
              },
            },
          ) as InstanceType<typeof PrismaQuoteRequestRepository>;

          const adminCancelUseCase = new CancelQuoteRequestByAdminUseCase(
            txRunner,
            gatedCancelReqRepo,
          );
          const confirmDeliveryUseCase = new ConfirmDeliveryUseCase(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
            new PrismaAllocationRepository(txRunner),
          );

          const cancelPromise = adminCancelUseCase.execute({
            actor: fixture.adminActor,
            requestId: fixture.requestId.toString(),
            expectedRequestVersion: 4,
            cancelReason: 'Thiên tai ngập xưởng trước khi Buyer xác nhận nhận đủ',
            goodsHandlingNote:
              '500 sản phẩm đã bàn giao được hai bên đối soát thanh toán ngoài hệ thống',
            now: fixture.now,
          });
          cancelPromise.catch(() => cancelLockedGate.resolve());

          await cancelLockedGate.promise;
          const confirmPromise = confirmDeliveryUseCase.execute({
            actor: fixture.buyerActor,
            requestId: fixture.requestId.toString(),
            expectedRequestVersion: 4,
            now: fixture.now,
          });

          const [cancelRes, confirmRes] = await Promise.allSettled([
            cancelPromise,
            confirmPromise,
          ]);

          expect(cancelRes.status).toBe('fulfilled');
          expect(confirmRes.status).toBe('rejected');
          if (confirmRes.status === 'rejected') {
            expect(confirmRes.reason).toBeInstanceOf(InvalidStateTransitionError);
            const problem = mapErrorToProblemDetails(confirmRes.reason);
            expect(problem.statusCode).toBe(422);
            expect(problem.body.code).toBe('INVALID_STATE');
          }

          // Invariant verification: primary status stays 'in_production', cancelled_at set,
          // Allocation stays 'handed_over' (BR-22), zero 'received_by_buyer' log
          const persistedReq = await db.quoteRequest.findUnique({
            where: { id: fixture.requestId },
          });
          expect(persistedReq?.status).toBe('in_production');
          expect(persistedReq?.version).toBe(5);
          expect(persistedReq?.cancelled_at).not.toBeNull();
          expect(persistedReq?.cancelled_by).toBe(fixture.adminId);

          const persistedAlloc = await db.allocation.findUnique({
            where: { id: fixture.workshops[0].allocationId! },
          });
          expect(persistedAlloc?.status).toBe('handed_over');

          const statusLogs = await db.statusLog.findMany({
            where: { request_id: fixture.requestId },
            orderBy: { id: 'asc' },
          });
          expect(statusLogs).toHaveLength(1);
          expect(statusLogs[0].event_type).toBe('cancelled');
          expect(statusLogs[0].prev_status).toBe('in_production');
          expect(statusLogs[0].new_status).toBe('in_production');
          expect(statusLogs[0].is_admin_action).toBe(true);
          expect(statusLogs[0].evidence).toContain('đối soát thanh toán');
        } finally {
          await cleanupTradingFixture(db, fixture);
        }
      });

      it('Admin Cancel vs Buyer Confirm Delivery — Order B (Buyer Confirm commits first): Admin Cancel rejects stale v4 with 409 CONCURRENCY_CONFLICT and fresh v5 with 422 INVALID_STATE', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { CancelQuoteRequestByAdminUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/cancel-quote-request-by-admin.use-case'
        );
        const { ConfirmDeliveryUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/confirm-delivery.use-case'
        );

        const fixture = await seedTradingFixture(db, {
          requestStatus: 'in_production',
          requestVersion: 4,
          workshopCount: 1,
          allocationStatus: 'handed_over',
          allocationVersion: 3,
        });

        try {
          const realReqRepo = new PrismaQuoteRequestRepository(txRunner);
          const confirmLockedGate = createDeferred<void>();

          const gatedConfirmReqRepo = Object.assign(
            Object.create(Object.getPrototypeOf(realReqRepo)),
            realReqRepo,
            {
              update: async (
                ...args: Parameters<typeof realReqRepo.update>
              ) => {
                confirmLockedGate.resolve();
                await delay(60);
                return realReqRepo.update(...args);
              },
            },
          ) as InstanceType<typeof PrismaQuoteRequestRepository>;

          const confirmDeliveryUseCase = new ConfirmDeliveryUseCase(
            txRunner,
            gatedConfirmReqRepo,
            new PrismaAllocationRepository(txRunner),
          );
          const adminCancelUseCase = new CancelQuoteRequestByAdminUseCase(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
          );

          const confirmPromise = confirmDeliveryUseCase.execute({
            actor: fixture.buyerActor,
            requestId: fixture.requestId.toString(),
            expectedRequestVersion: 4,
            now: fixture.now,
          });
          confirmPromise.catch(() => confirmLockedGate.resolve());

          await confirmLockedGate.promise;
          const cancelPromise = adminCancelUseCase.execute({
            actor: fixture.adminActor,
            requestId: fixture.requestId.toString(),
            expectedRequestVersion: 4,
            cancelReason: 'Thử hủy đồng thời khi Buyer vừa xác nhận nhận đủ',
            goodsHandlingNote: 'Xử lý ngoài hệ thống',
            now: fixture.now,
          });

          const [confirmRes, cancelRes] = await Promise.allSettled([
            confirmPromise,
            cancelPromise,
          ]);

          expect(confirmRes.status).toBe('fulfilled');
          expect(cancelRes.status).toBe('rejected');
          if (cancelRes.status === 'rejected') {
            expect(cancelRes.reason).toBeInstanceOf(ConcurrencyConflictError);
            const problem = mapErrorToProblemDetails(cancelRes.reason);
            expect(problem.statusCode).toBe(409);
            expect(problem.body.code).toBe('CONCURRENCY_CONFLICT');
          }

          // Retrying Admin Cancel with refreshed version 5 MUST still fail because 'delivered' can never be cancelled (BR-21)
          await expect(
            adminCancelUseCase.execute({
              actor: fixture.adminActor,
              requestId: fixture.requestId.toString(),
              expectedRequestVersion: 5,
              cancelReason: 'Thử hủy đơn đã Delivered',
              goodsHandlingNote: 'Không hợp lệ',
              now: fixture.now,
            }),
          ).rejects.toBeInstanceOf(InvalidStateTransitionError);

          const persistedReq = await db.quoteRequest.findUnique({
            where: { id: fixture.requestId },
          });
          expect(persistedReq?.status).toBe('delivered');
          expect(persistedReq?.version).toBe(5);
          expect(persistedReq?.cancelled_at).toBeNull();
          expect(persistedReq?.cancelled_by).toBeNull();

          const statusLogs = await db.statusLog.findMany({
            where: { request_id: fixture.requestId },
            orderBy: { id: 'asc' },
          });
          expect(statusLogs.map((l) => l.event_type)).toEqual(['received_by_buyer']);
        } finally {
          await cleanupTradingFixture(db, fixture);
        }
      });

      it('Admin Cancel vs Admin Confirm Delivery (ConfirmDeliveryByAdminUseCase): both commit orders enforce cancelled XOR delivered', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { CancelQuoteRequestByAdminUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/cancel-quote-request-by-admin.use-case'
        );
        const { ConfirmDeliveryByAdminUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/confirm-delivery-by-admin.use-case'
        );

        // Order A: Admin Confirm Delivery commits first; Admin Cancel fails
        const fixtureA = await seedTradingFixture(db, {
          requestStatus: 'in_production',
          requestVersion: 4,
          workshopCount: 1,
          allocationStatus: 'handed_over',
          allocationVersion: 3,
        });
        try {
          const realReqRepo = new PrismaQuoteRequestRepository(txRunner);
          const confirmLockedGate = createDeferred<void>();
          const gatedConfirmRepo = Object.assign(
            Object.create(Object.getPrototypeOf(realReqRepo)),
            realReqRepo,
            {
              update: async (
                ...args: Parameters<typeof realReqRepo.update>
              ) => {
                confirmLockedGate.resolve();
                await delay(60);
                return realReqRepo.update(...args);
              },
            },
          ) as InstanceType<typeof PrismaQuoteRequestRepository>;

          const adminConfirm = new ConfirmDeliveryByAdminUseCase(
            txRunner,
            gatedConfirmRepo,
            new PrismaAllocationRepository(txRunner),
          );
          const adminCancel = new CancelQuoteRequestByAdminUseCase(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
          );

          const confirmPromise = adminConfirm.execute({
            actor: fixtureA.adminActor,
            requestId: fixtureA.requestId.toString(),
            expectedRequestVersion: 4,
            reason: 'Buyer đã ký biên bản nhận đủ hàng nhưng chưa bấm xác nhận',
            evidence: 'Biên bản nghiệm thu số BB-2026-099 có chữ ký đại diện Buyer',
            now: fixtureA.now,
          });
          confirmPromise.catch(() => confirmLockedGate.resolve());

          await confirmLockedGate.promise;
          const cancelPromise = adminCancel.execute({
            actor: fixtureA.adminActor,
            requestId: fixtureA.requestId.toString(),
            expectedRequestVersion: 4,
            cancelReason: 'Thử hủy đồng thời',
            goodsHandlingNote: 'Xử lý ngoài hệ thống',
            now: fixtureA.now,
          });

          const [confirmRes, cancelRes] = await Promise.allSettled([
            confirmPromise,
            cancelPromise,
          ]);
          expect(confirmRes.status).toBe('fulfilled');
          expect(cancelRes.status).toBe('rejected');

          const reqA = await db.quoteRequest.findUnique({
            where: { id: fixtureA.requestId },
          });
          expect(reqA?.status).toBe('delivered');
          expect(reqA?.cancelled_at).toBeNull();
          const logsA = await db.statusLog.findMany({
            where: { request_id: fixtureA.requestId },
          });
          expect(logsA.map((l) => l.event_type)).toEqual(['received_by_admin']);
          expect(logsA[0].is_admin_action).toBe(true);
        } finally {
          await cleanupTradingFixture(db, fixtureA);
        }

        // Order B: Admin Cancel commits first; Admin Confirm Delivery fails
        const fixtureB = await seedTradingFixture(db, {
          requestStatus: 'in_production',
          requestVersion: 4,
          workshopCount: 1,
          allocationStatus: 'handed_over',
          allocationVersion: 3,
        });
        try {
          const realReqRepo = new PrismaQuoteRequestRepository(txRunner);
          const cancelLockedGate = createDeferred<void>();
          const gatedCancelRepo = Object.assign(
            Object.create(Object.getPrototypeOf(realReqRepo)),
            realReqRepo,
            {
              update: async (
                ...args: Parameters<typeof realReqRepo.update>
              ) => {
                cancelLockedGate.resolve();
                await delay(60);
                return realReqRepo.update(...args);
              },
            },
          ) as InstanceType<typeof PrismaQuoteRequestRepository>;

          const adminCancel = new CancelQuoteRequestByAdminUseCase(
            txRunner,
            gatedCancelRepo,
          );
          const adminConfirm = new ConfirmDeliveryByAdminUseCase(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
            new PrismaAllocationRepository(txRunner),
          );

          const cancelPromise = adminCancel.execute({
            actor: fixtureB.adminActor,
            requestId: fixtureB.requestId.toString(),
            expectedRequestVersion: 4,
            cancelReason: 'Hủy đơn có căn cứ trước khi hoàn tất',
            goodsHandlingNote: 'Đổi trả và thanh toán ngoài hệ thống',
            now: fixtureB.now,
          });
          cancelPromise.catch(() => cancelLockedGate.resolve());

          await cancelLockedGate.promise;
          const confirmPromise = adminConfirm.execute({
            actor: fixtureB.adminActor,
            requestId: fixtureB.requestId.toString(),
            expectedRequestVersion: 4,
            reason: 'Thử xác nhận thay sau khi đã hủy',
            evidence: 'Biên bản BB-2026-100',
            now: fixtureB.now,
          });

          const [cancelRes, confirmRes] = await Promise.allSettled([
            cancelPromise,
            confirmPromise,
          ]);
          expect(cancelRes.status).toBe('fulfilled');
          expect(confirmRes.status).toBe('rejected');
          if (confirmRes.status === 'rejected') {
            expect(confirmRes.reason).toBeInstanceOf(InvalidStateTransitionError);
          }

          const reqB = await db.quoteRequest.findUnique({
            where: { id: fixtureB.requestId },
          });
          expect(reqB?.status).toBe('in_production');
          expect(reqB?.cancelled_at).not.toBeNull();
          const logsB = await db.statusLog.findMany({
            where: { request_id: fixtureB.requestId },
          });
          expect(logsB.map((l) => l.event_type)).toEqual(['cancelled']);
        } finally {
          await cleanupTradingFixture(db, fixtureB);
        }
      });

      it('Buyer Confirm Delivery vs Admin Confirm Delivery racing concurrently: exactly 1 succeeds and winning actor is never overwritten (UC-26)', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { ConfirmDeliveryUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/confirm-delivery.use-case'
        );
        const { ConfirmDeliveryByAdminUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/confirm-delivery-by-admin.use-case'
        );

        const fixture = await seedTradingFixture(db, {
          requestStatus: 'in_production',
          requestVersion: 4,
          workshopCount: 1,
          allocationStatus: 'handed_over',
          allocationVersion: 3,
        });

        try {
          const buyerConfirm = new ConfirmDeliveryUseCase(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
            new PrismaAllocationRepository(txRunner),
          );
          const adminConfirm = new ConfirmDeliveryByAdminUseCase(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
            new PrismaAllocationRepository(txRunner),
          );

          const [buyerRes, adminRes] = await Promise.allSettled([
            buyerConfirm.execute({
              actor: fixture.buyerActor,
              requestId: fixture.requestId.toString(),
              expectedRequestVersion: 4,
              now: fixture.now,
            }),
            adminConfirm.execute({
              actor: fixture.adminActor,
              requestId: fixture.requestId.toString(),
              expectedRequestVersion: 4,
              reason: 'Xác nhận nhận đủ thay Buyer',
              evidence: 'Biên bản ký nhận số BB-2026-101',
              now: fixture.now,
            }),
          ]);

          const fulfilled = [buyerRes, adminRes].filter(
            (r) => r.status === 'fulfilled',
          );
          const rejected = [buyerRes, adminRes].filter(
            (r) => r.status === 'rejected',
          );
          expect(fulfilled).toHaveLength(1);
          expect(rejected).toHaveLength(1);
          expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
            ConcurrencyConflictError,
          );

          const logs = await db.statusLog.findMany({
            where: { request_id: fixture.requestId },
          });
          expect(logs).toHaveLength(1);
          if (buyerRes.status === 'fulfilled') {
            expect(logs[0].event_type).toBe('received_by_buyer');
            expect(logs[0].performed_by).toBe(fixture.buyerId);
            expect(logs[0].is_admin_action).toBe(false);
          } else {
            expect(logs[0].event_type).toBe('received_by_admin');
            expect(logs[0].performed_by).toBe(fixture.adminId);
            expect(logs[0].is_admin_action).toBe(true);
          }
        } finally {
          await cleanupTradingFixture(db, fixture);
        }
      });

      it('Admin Cancel vs Artisan Handover (AT-13): both commit orders serialize cleanly without deadlock and enforce BR-21/BR-22/BR-24', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { CancelQuoteRequestByAdminUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/cancel-quote-request-by-admin.use-case'
        );
        const { HandoverAllocationUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/handover-allocation.use-case'
        );
        const { ConfirmDeliveryUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/confirm-delivery.use-case'
        );

        // Order A: Admin Cancel commits first -> Handover blocks on QuoteRequest FOR UPDATE then fails with 422 INVALID_STATE
        const fixtureA = await seedTradingFixture(db, {
          requestStatus: 'in_production',
          requestVersion: 4,
          workshopCount: 1,
          allocationStatus: 'in_production',
          allocationVersion: 2,
        });
        try {
          const wsContract = createPgWorkshopContract(db, txRunner);
          const realReqRepo = new PrismaQuoteRequestRepository(txRunner);
          const cancelLockedGate = createDeferred<void>();

          const gatedCancelRepo = Object.assign(
            Object.create(Object.getPrototypeOf(realReqRepo)),
            realReqRepo,
            {
              update: async (
                ...args: Parameters<typeof realReqRepo.update>
              ) => {
                cancelLockedGate.resolve();
                await delay(60);
                return realReqRepo.update(...args);
              },
            },
          ) as InstanceType<typeof PrismaQuoteRequestRepository>;

          const adminCancel = new CancelQuoteRequestByAdminUseCase(
            txRunner,
            gatedCancelRepo,
          );
          const handover = new HandoverAllocationUseCase(
            txRunner,
            new PrismaAllocationRepository(txRunner),
            new PrismaQuoteRequestRepository(txRunner),
            wsContract,
          );

          const wA = fixtureA.workshops[0];
          const cancelPromise = adminCancel.execute({
            actor: fixtureA.adminActor,
            requestId: fixtureA.requestId.toString(),
            expectedRequestVersion: 4,
            cancelReason: 'Hủy khẩn cấp trước khi bàn giao',
            goodsHandlingNote: 'Chưa có hàng bàn giao',
            now: fixtureA.now,
          });
          cancelPromise.catch(() => cancelLockedGate.resolve());

          await cancelLockedGate.promise;
          const handoverPromise = handover.execute({
            actor: wA.artisanActor,
            allocationId: wA.allocationId!.toString(),
            expectedAllocationVersion: 2,
            deliveryNote: 'Bàn giao đúng lúc đơn đang bị hủy',
            now: fixtureA.now,
          });

          const [cancelRes, handoverRes] = await Promise.allSettled([
            cancelPromise,
            handoverPromise,
          ]);
          expect(cancelRes.status).toBe('fulfilled');
          expect(handoverRes.status).toBe('rejected');
          if (handoverRes.status === 'rejected') {
            expect(handoverRes.reason).toBeInstanceOf(InvalidStateTransitionError);
          }

          const allocA = await db.allocation.findUnique({
            where: { id: wA.allocationId! },
          });
          expect(allocA?.status).toBe('in_production');
          expect(allocA?.version).toBe(2);
        } finally {
          await cleanupTradingFixture(db, fixtureA);
        }

        // Order B: Artisan Handover commits first -> Admin Cancel commits after (BR-21 allows cancel before Delivered),
        // Allocation remains handed_over (BR-22), and subsequent Buyer confirm-delivery is blocked
        const fixtureB = await seedTradingFixture(db, {
          requestStatus: 'in_production',
          requestVersion: 4,
          workshopCount: 1,
          allocationStatus: 'in_production',
          allocationVersion: 2,
        });
        try {
          const wsContract = createPgWorkshopContract(db, txRunner);
          const realAllocRepo = new PrismaAllocationRepository(txRunner);
          const handoverLockedGate = createDeferred<void>();

          const gatedHandoverAllocRepo = Object.assign(
            Object.create(Object.getPrototypeOf(realAllocRepo)),
            realAllocRepo,
            {
              update: async (
                ...args: Parameters<typeof realAllocRepo.update>
              ) => {
                handoverLockedGate.resolve();
                await delay(60);
                return realAllocRepo.update(...args);
              },
            },
          ) as InstanceType<typeof PrismaAllocationRepository>;

          const handover = new HandoverAllocationUseCase(
            txRunner,
            gatedHandoverAllocRepo,
            new PrismaQuoteRequestRepository(txRunner),
            wsContract,
          );
          const adminCancel = new CancelQuoteRequestByAdminUseCase(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
          );
          const buyerConfirm = new ConfirmDeliveryUseCase(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
            new PrismaAllocationRepository(txRunner),
          );

          const wB = fixtureB.workshops[0];
          const handoverPromise = handover.execute({
            actor: wB.artisanActor,
            allocationId: wB.allocationId!.toString(),
            expectedAllocationVersion: 2,
            deliveryNote: 'Đã bàn giao đủ 500 chiếc',
            now: fixtureB.now,
          });
          handoverPromise.catch(() => handoverLockedGate.resolve());

          await handoverLockedGate.promise;
          // Note: Handover does NOT bump QuoteRequest.version (BR-27), so Admin Cancel with v4 succeeds after lock release
          const cancelPromise = adminCancel.execute({
            actor: fixtureB.adminActor,
            requestId: fixtureB.requestId.toString(),
            expectedRequestVersion: 4,
            cancelReason: 'Hủy sau bàn giao nhưng trước xác nhận nhận đủ',
            goodsHandlingNote: 'Giữ lại trạng thái đã bàn giao để hai bên đối soát',
            now: fixtureB.now,
          });

          const [handoverRes, cancelRes] = await Promise.allSettled([
            handoverPromise,
            cancelPromise,
          ]);
          expect(handoverRes.status).toBe('fulfilled');
          expect(cancelRes.status).toBe('fulfilled');

          const allocB = await db.allocation.findUnique({
            where: { id: wB.allocationId! },
          });
          expect(allocB?.status).toBe('handed_over');
          const reqB = await db.quoteRequest.findUnique({
            where: { id: fixtureB.requestId },
          });
          expect(reqB?.status).toBe('in_production');
          expect(reqB?.cancelled_at).not.toBeNull();

          await expect(
            buyerConfirm.execute({
              actor: fixtureB.buyerActor,
              requestId: fixtureB.requestId.toString(),
              expectedRequestVersion: 5,
              now: fixtureB.now,
            }),
          ).rejects.toBeInstanceOf(InvalidStateTransitionError);
        } finally {
          await cleanupTradingFixture(db, fixtureB);
        }
      });
    });

    // =========================================================================
    // 3. Concurrent Same X-Idempotency-Key across Workflows & HTTP Interceptor
    // =========================================================================
    describe('3) Concurrent Same X-Idempotency-Key across Workflows & TradingMutationInterceptor (BR-27, SEC-06, api-design.md §1.4)', () => {
      it('two concurrent AcceptQuotationWorkflow calls with SAME key & DIFFERENT quote_id: 1 commits and loser rejects with 409 IDEMPOTENCY_CONFLICT', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaRequestRecipientRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository'
        );
        const { PrismaQuoteRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { PrismaIdempotencyRecordRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository'
        );
        const { TradingAcceptanceService } = await import(
          '../../../src/modules/trading/application/services/trading-acceptance.service'
        );
        const { AcceptQuotationWorkflow } = await import(
          '../../../src/workflows/accept-quotation'
        );

        const fixture = await seedTradingFixture(db, {
          requestStatus: 'artisans_bidding',
          requestVersion: 2,
          workshopCount: 2,
        });

        try {
          const wsContract = createPgWorkshopContract(db, txRunner);
          const realService = new TradingAcceptanceService(
            new PrismaQuoteRequestRepository(txRunner),
            new PrismaRequestRecipientRepository(txRunner),
            new PrismaQuoteRepository(txRunner),
            new PrismaAllocationRepository(txRunner),
            new PrismaIdempotencyRecordRepository(txRunner),
            wsContract,
          );

          const waitAtPrepare = createBarrier(2);
          const barrierService = Object.assign(
            Object.create(Object.getPrototypeOf(realService)),
            realService,
            {
              prepareAcceptance: async (
                ...args: Parameters<typeof realService.prepareAcceptance>
              ) => {
                await waitAtPrepare();
                return realService.prepareAcceptance(...args);
              },
            },
          ) as InstanceType<typeof TradingAcceptanceService>;

          const workflow = new AcceptQuotationWorkflow(
            txRunner,
            barrierService,
            wsContract,
          );
          const sharedKey = randomUUID();

          const [res1, res2] = await Promise.allSettled([
            workflow.execute({
              actor: fixture.buyerActor,
              requestId: fixture.requestId.toString(),
              quoteId: fixture.workshops[0].quoteId!.toString(),
              expectedRequestVersion: 2,
              expectedQuoteVersion: 1,
              idempotencyKey: sharedKey,
              now: fixture.now,
            }),
            workflow.execute({
              actor: fixture.buyerActor,
              requestId: fixture.requestId.toString(),
              quoteId: fixture.workshops[1].quoteId!.toString(),
              expectedRequestVersion: 2,
              expectedQuoteVersion: 1,
              idempotencyKey: sharedKey,
              now: fixture.now,
            }),
          ]);

          const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
          const rejected = [res1, res2].filter((r) => r.status === 'rejected');
          expect(fulfilled).toHaveLength(1);
          expect(rejected).toHaveLength(1);

          const err = (rejected[0] as PromiseRejectedResult).reason;
          expect(err).toBeInstanceOf(IdempotencyConflictError);
          const problem = mapErrorToProblemDetails(err);
          expect(problem.statusCode).toBe(409);
          expect(problem.contentType).toBe('application/problem+json');
          expect(problem.body.code).toBe('IDEMPOTENCY_CONFLICT');

          expect(
            await db.allocation.count({ where: { request_id: fixture.requestId } }),
          ).toBe(1);
          expect(
            await db.idempotencyRecord.count({
              where: {
                account_id: fixture.buyerId,
                idempotency_key: sharedKey,
              },
            }),
          ).toBe(1);
        } finally {
          await cleanupTradingFixture(db, fixture);
        }
      });

      it('two concurrent ConfirmDelivery calls with SAME X-Idempotency-Key through TradingMutationInterceptor on PostgreSQL: 1 commits (replayed:false) + 1 replays (replayed:true) with 1 StatusLog', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaRequestRecipientRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository'
        );
        const { PrismaQuoteRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { PrismaIdempotencyRecordRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository'
        );
        const { TradingIdempotencyService } = await import(
          '../../../src/modules/trading/application/services/trading-idempotency.service'
        );
        const { ConfirmDeliveryUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/confirm-delivery.use-case'
        );

        const fixture = await seedTradingFixture(db, {
          requestStatus: 'in_production',
          requestVersion: 4,
          workshopCount: 1,
          allocationStatus: 'handed_over',
          allocationVersion: 3,
        });

        try {
          const quoteRequestRepo = new PrismaQuoteRequestRepository(txRunner);
          const allocationRepo = new PrismaAllocationRepository(txRunner);
          const quoteRepo = new PrismaQuoteRepository(txRunner);
          const recipientRepo = new PrismaRequestRecipientRepository(txRunner);
          const idempotencyRepo = new PrismaIdempotencyRecordRepository(txRunner);

          const idempotencyService = new TradingIdempotencyService(
            idempotencyRepo,
            txRunner,
          );
          const stateResolver = new TradingCurrentStateResolver(
            quoteRequestRepo,
            allocationRepo,
            quoteRepo,
            recipientRepo,
          );
          const interceptor = new TradingMutationInterceptor(
            new Reflector(),
            idempotencyService,
            stateResolver,
          );
          const confirmUseCase = new ConfirmDeliveryUseCase(
            txRunner,
            quoteRequestRepo,
            allocationRepo,
          );

          const waitBothPastPrecheck = createBarrier(2);
          const sharedKey = randomUUID();
          const mutationOptions: TradingMutationOptions = {
            action: 'confirm_delivery',
            objectType: 'QuoteRequest',
            objectIdParam: 'id',
            expectedVersionField: 'expected_request_version',
          };

          const runOnce = () =>
            invokeThroughTradingInterceptor({
              interceptor,
              options: mutationOptions,
              actor: fixture.buyerActor,
              objectId: fixture.requestId.toString(),
              idempotencyKey: sharedKey,
              body: { expected_request_version: 4 },
              handler: async (tx) => {
                await waitBothPastPrecheck();
                const out = await confirmUseCase.execute({
                  actor: fixture.buyerActor,
                  requestId: fixture.requestId.toString(),
                  expectedRequestVersion: 4,
                  now: fixture.now,
                  tx,
                });
                return { data: out.request, currentState: out.currentState };
              },
            });

          const [r1, r2] = await Promise.all([runOnce(), runOnce()]);

          expect(r1.data).toEqual(r2.data);
          expect(
            [
              r1.metadata?.operation?.replayed,
              r2.metadata?.operation?.replayed,
            ].sort(),
          ).toEqual([false, true]);
          expect(r1.metadata?.operation?.id).toBe(r2.metadata?.operation?.id);
          expect(r1.metadata?.operation?.current_state).toEqual({
            request: {
              id: fixture.requestId.toString(),
              status: 'delivered',
              version: 5,
              cancelled_at: null,
            },
          });
          expect(r2.metadata?.operation?.current_state).toEqual(
            r1.metadata?.operation?.current_state,
          );

          expect(
            await db.statusLog.count({
              where: {
                request_id: fixture.requestId,
                event_type: 'received_by_buyer',
              },
            }),
          ).toBe(1);
          expect(
            await db.idempotencyRecord.count({
              where: {
                account_id: fixture.buyerId,
                action: 'confirm_delivery',
                idempotency_key: sharedKey,
              },
            }),
          ).toBe(1);
        } finally {
          await cleanupTradingFixture(db, fixture);
        }
      });

      it('two concurrent Admin Cancel calls with SAME X-Idempotency-Key & DIFFERENT payload through TradingMutationInterceptor: 1 commits and 1 rejects with 409 IDEMPOTENCY_CONFLICT', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaRequestRecipientRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository'
        );
        const { PrismaQuoteRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { PrismaIdempotencyRecordRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository'
        );
        const { TradingIdempotencyService } = await import(
          '../../../src/modules/trading/application/services/trading-idempotency.service'
        );
        const { CancelQuoteRequestByAdminUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/cancel-quote-request-by-admin.use-case'
        );

        const fixture = await seedTradingFixture(db, {
          requestStatus: 'in_production',
          requestVersion: 4,
          workshopCount: 1,
          allocationStatus: 'in_production',
          allocationVersion: 2,
        });

        try {
          const quoteRequestRepo = new PrismaQuoteRequestRepository(txRunner);
          const allocationRepo = new PrismaAllocationRepository(txRunner);
          const quoteRepo = new PrismaQuoteRepository(txRunner);
          const recipientRepo = new PrismaRequestRecipientRepository(txRunner);
          const idempotencyRepo = new PrismaIdempotencyRecordRepository(txRunner);

          const interceptor = new TradingMutationInterceptor(
            new Reflector(),
            new TradingIdempotencyService(idempotencyRepo, txRunner),
            new TradingCurrentStateResolver(
              quoteRequestRepo,
              allocationRepo,
              quoteRepo,
              recipientRepo,
            ),
          );
          const cancelUseCase = new CancelQuoteRequestByAdminUseCase(
            txRunner,
            quoteRequestRepo,
          );

          const waitBothPastPrecheck = createBarrier(2);
          const sharedKey = randomUUID();
          const mutationOptions: TradingMutationOptions = {
            action: 'cancel_request_by_admin',
            objectType: 'QuoteRequest',
            objectIdParam: 'id',
            expectedVersionField: 'expected_request_version',
          };

          const callWithReason = (cancelReason: string) =>
            invokeThroughTradingInterceptor({
              interceptor,
              options: mutationOptions,
              actor: fixture.adminActor,
              objectId: fixture.requestId.toString(),
              idempotencyKey: sharedKey,
              body: {
                expected_request_version: 4,
                cancel_reason: cancelReason,
                goods_handling_note: 'Đối soát ngoài hệ thống',
              },
              handler: async (tx) => {
                await waitBothPastPrecheck();
                const out = await cancelUseCase.execute({
                  actor: fixture.adminActor,
                  requestId: fixture.requestId.toString(),
                  expectedRequestVersion: 4,
                  cancelReason,
                  goodsHandlingNote: 'Đối soát ngoài hệ thống',
                  now: fixture.now,
                  tx,
                });
                return { data: out.request, currentState: out.currentState };
              },
            });

          const [r1, r2] = await Promise.allSettled([
            callWithReason('Lý do hủy A — ngập lò'),
            callWithReason('Lý do hủy B — khác payload'),
          ]);

          const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
          const rejected = [r1, r2].filter((r) => r.status === 'rejected');
          expect(fulfilled).toHaveLength(1);
          expect(rejected).toHaveLength(1);

          const err = (rejected[0] as PromiseRejectedResult).reason;
          expect(err).toBeInstanceOf(IdempotencyConflictError);
          const problem = mapErrorToProblemDetails(err);
          expect(problem.statusCode).toBe(409);
          expect(problem.body.code).toBe('IDEMPOTENCY_CONFLICT');

          expect(
            await db.statusLog.count({
              where: { request_id: fixture.requestId, event_type: 'cancelled' },
            }),
          ).toBe(1);
        } finally {
          await cleanupTradingFixture(db, fixture);
        }
      });

      it('Idempotency replay after subsequent state progression returns original snapshot + fresh current_state without failing on stale version (BR-27)', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaRequestRecipientRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository'
        );
        const { PrismaQuoteRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { PrismaIdempotencyRecordRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository'
        );
        const { TradingAcceptanceService } = await import(
          '../../../src/modules/trading/application/services/trading-acceptance.service'
        );
        const { StartAllocationProductionUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/start-allocation-production.use-case'
        );
        const { CancelQuoteRequestByAdminUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/cancel-quote-request-by-admin.use-case'
        );
        const { AcceptQuotationWorkflow } = await import(
          '../../../src/workflows/accept-quotation'
        );

        const fixture = await seedTradingFixture(db, {
          requestStatus: 'artisans_bidding',
          requestVersion: 2,
          workshopCount: 1,
        });

        try {
          const wsContract = createPgWorkshopContract(db, txRunner);
          const acceptWorkflow = new AcceptQuotationWorkflow(
            txRunner,
            new TradingAcceptanceService(
              new PrismaQuoteRequestRepository(txRunner),
              new PrismaRequestRecipientRepository(txRunner),
              new PrismaQuoteRepository(txRunner),
              new PrismaAllocationRepository(txRunner),
              new PrismaIdempotencyRecordRepository(txRunner),
              wsContract,
            ),
            wsContract,
          );
          const startUseCase = new StartAllocationProductionUseCase(
            txRunner,
            new PrismaAllocationRepository(txRunner),
            new PrismaQuoteRequestRepository(txRunner),
            wsContract,
          );
          const adminCancelUseCase = new CancelQuoteRequestByAdminUseCase(
            txRunner,
            new PrismaQuoteRequestRepository(txRunner),
          );

          const w = fixture.workshops[0];
          const acceptKey = randomUUID();

          // Step 1: Buyer accepts at request v2 -> v3
          const initial = await acceptWorkflow.execute({
            actor: fixture.buyerActor,
            requestId: fixture.requestId.toString(),
            quoteId: w.quoteId!.toString(),
            expectedRequestVersion: 2,
            expectedQuoteVersion: 1,
            idempotencyKey: acceptKey,
            now: fixture.now,
          });
          expect(initial.operation?.replayed).toBe(false);
          const allocationId = initial.data.allocations[0].id;

          // Step 2: Artisan starts production (request v3 -> v4, status: in_production)
          await startUseCase.execute({
            actor: w.artisanActor,
            allocationId,
            expectedAllocationVersion: 1,
            now: new Date(fixture.now.getTime() + 60_000),
          });

          // Step 3: Admin cancels post-acceptance (request v4 -> v5, cancelled_at != null)
          const cancelTime = new Date(fixture.now.getTime() + 120_000);
          await adminCancelUseCase.execute({
            actor: fixture.adminActor,
            requestId: fixture.requestId.toString(),
            expectedRequestVersion: 4,
            cancelReason: 'Hủy sau khi sản xuất đã bắt đầu',
            goodsHandlingNote: 'Chưa có sản phẩm bàn giao',
            now: cancelTime,
          });

          // Step 4: Client replays original accept-quote request with original stale expectedRequestVersion: 2
          const replayed = await acceptWorkflow.execute({
            actor: fixture.buyerActor,
            requestId: fixture.requestId.toString(),
            quoteId: w.quoteId!.toString(),
            expectedRequestVersion: 2,
            expectedQuoteVersion: 1,
            idempotencyKey: acceptKey,
            now: new Date(fixture.now.getTime() + 180_000),
          });

          expect(replayed.operation?.replayed).toBe(true);
          expect(replayed.data).toEqual(initial.data);
          expect(replayed.operation?.current_state.request).toEqual({
            id: fixture.requestId.toString(),
            status: 'in_production',
            version: 5,
            cancelled_at: cancelTime.toISOString(),
          });
          expect(replayed.operation?.current_state.quote).toEqual({
            id: w.quoteId!.toString(),
            status: 'accepted',
            version: 2,
          });
          expect(
            await db.allocation.count({ where: { request_id: fixture.requestId } }),
          ).toBe(1);
        } finally {
          await cleanupTradingFixture(db, fixture);
        }
      });
    });
  },
);
