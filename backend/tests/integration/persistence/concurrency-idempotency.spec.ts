import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../../src/infrastructure/database/prisma/prisma.service';
import type { PrismaTransactionRunner } from '../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import {
  Allocation,
  ConcurrencyConflictError,
  IdempotencyConflictError,
  InvalidStateTransitionError,
  Quote,
} from '../../../src/modules/trading/domain';
import { computeCanonicalFingerprint } from '../../../src/modules/trading/domain/utilities';
import {
  cleanupTradingFixture,
  createBarrier,
  createPgCatalogContract,
  createPgTraceabilityContract,
  createPgWorkshopContract,
  mapErrorToProblemDetails,
  seedTradingFixture,
} from '../../support/pg-trading-harness';

const testUrl = process.env.VCRAFT_TEST_DATABASE_URL;

function expectHttp409Problem(
  error: unknown,
  expectedCode: 'CONCURRENCY_CONFLICT' | 'IDEMPOTENCY_CONFLICT',
): void {
  const problem = mapErrorToProblemDetails(error);
  expect(problem.statusCode).toBe(409);
  expect(problem.contentType).toBe('application/problem+json');
  expect(problem.body.status).toBe(409);
  expect(problem.body.code).toBe(expectedCode);
  expect(problem.body.type).toBe(`urn:vcraft:problem:${expectedCode}`);
  expect(problem.body.tracking_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  // SEC-06: never leak SQL or stack traces in Problem Details
  expect(problem.body.detail).not.toMatch(/SELECT|INSERT|UPDATE|Prisma|stack/i);
}

async function expectStaleVersion409(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConcurrencyConflictError);
  expectHttp409Problem(caught, 'CONCURRENCY_CONFLICT');
}

describe.skipIf(!testUrl)(
  'Task 40: Persistence Concurrency, Idempotency & 409 Stale-Version Integration on PostgreSQL',
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
    // 1. Concurrent Same X-Idempotency-Key & P2002 / 25P02 Recovery on PostgreSQL
    // =========================================================================
    describe('1) Concurrent Idempotency Key Races, PG P2002/25P02 Recovery & Scope Isolation (BR-27, SEC-06, data-design.md §2.20)', () => {
      it('two concurrent TradingIdempotencyService mutations with SAME key & SAME payload: 1 commits (replayed:false) + 1 replays (replayed:true) with exactly 1 DB mutation', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaIdempotencyRecordRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository'
        );
        const { TradingIdempotencyService } = await import(
          '../../../src/modules/trading/application/services/trading-idempotency.service'
        );
        const { UpdateRecipientContactUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/update-recipient-contact.use-case'
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
          const idempotencyRepo = new PrismaIdempotencyRecordRepository(txRunner);
          const idempotencyService = new TradingIdempotencyService(
            idempotencyRepo,
            txRunner,
          );
          const updateContactUseCase = new UpdateRecipientContactUseCase(
            txRunner,
            quoteRequestRepo,
          );

          const sharedKey = randomUUID();
          const waitBothPastPrecheck = createBarrier(2);
          const payload = {
            expected_request_version: 4,
            recipient_name: 'Trần Minh Khôi',
            recipient_phone: '0988777666',
          };

          const runConcurrent = () =>
            idempotencyService.executeWithIdempotency({
              accountId: fixture.buyerId.toString(),
              action: 'edit_contact',
              objectType: 'QuoteRequest',
              objectId: fixture.requestId.toString(),
              idempotencyKey: sharedKey,
              payload,
              now: fixture.now,
              execute: async (tx) => {
                await waitBothPastPrecheck();
                const updated = await updateContactUseCase.execute({
                  actor: fixture.buyerActor,
                  requestId: fixture.requestId.toString(),
                  expectedRequestVersion: 4,
                  recipientName: payload.recipient_name,
                  recipientPhone: payload.recipient_phone,
                  tx,
                });
                const currentState = {
                  request: {
                    id: updated.id,
                    status: updated.status,
                    version: updated.version,
                    cancelled_at: updated.cancelled_at
                      ? updated.cancelled_at.toISOString()
                      : null,
                  },
                };
                return {
                  result: {
                    id: updated.id,
                    version: updated.version,
                    recipient_name: updated.recipient_name,
                    recipient_phone: updated.recipient_phone,
                  },
                  currentState,
                };
              },
              getCurrentState: async (tx) => {
                const fresh = await quoteRequestRepo.findById(
                  fixture.requestId.toString(),
                  tx,
                );
                return {
                  request: {
                    id: fresh!.id,
                    status: fresh!.status,
                    version: fresh!.version,
                    cancelled_at: fresh!.cancelled_at
                      ? fresh!.cancelled_at.toISOString()
                      : null,
                  },
                };
              },
            });

          const [r1, r2] = await Promise.all([runConcurrent(), runConcurrent()]);

          expect(r1.data).toEqual(r2.data);
          expect(r1.recordId).toBe(r2.recordId);
          expect([r1.replayed, r2.replayed].sort()).toEqual([false, true]);
          expect(r1.operation.current_state.request.version).toBe(5);
          expect(r2.operation.current_state.request.version).toBe(5);

          const persistedReq = await db.quoteRequest.findUnique({
            where: { id: fixture.requestId },
          });
          expect(persistedReq?.version).toBe(5);
          expect(persistedReq?.recipient_name).toBe('Trần Minh Khôi');
          expect(persistedReq?.recipient_phone).toBe('0988777666');

          expect(
            await db.contactEditHistory.count({
              where: { request_id: fixture.requestId },
            }),
          ).toBe(1);
          expect(
            await db.idempotencyRecord.count({
              where: {
                account_id: fixture.buyerId,
                action: 'edit_contact',
                idempotency_key: sharedKey,
              },
            }),
          ).toBe(1);
        } finally {
          await cleanupTradingFixture(db, fixture);
        }
      });

      it('two concurrent TradingIdempotencyService mutations with SAME key & DIFFERENT payload: 1 commits and loser rejects with HTTP 409 IDEMPOTENCY_CONFLICT', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaIdempotencyRecordRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository'
        );
        const { TradingIdempotencyService } = await import(
          '../../../src/modules/trading/application/services/trading-idempotency.service'
        );
        const { UpdateRecipientContactUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/update-recipient-contact.use-case'
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
          const idempotencyService = new TradingIdempotencyService(
            new PrismaIdempotencyRecordRepository(txRunner),
            txRunner,
          );
          const updateContactUseCase = new UpdateRecipientContactUseCase(
            txRunner,
            quoteRequestRepo,
          );

          const sharedKey = randomUUID();
          const waitBothPastPrecheck = createBarrier(2);

          const callWithName = (recipientName: string) =>
            idempotencyService.executeWithIdempotency({
              accountId: fixture.buyerId.toString(),
              action: 'edit_contact',
              objectType: 'QuoteRequest',
              objectId: fixture.requestId.toString(),
              idempotencyKey: sharedKey,
              payload: {
                expected_request_version: 4,
                recipient_name: recipientName,
                recipient_phone: '0988777666',
              },
              now: fixture.now,
              execute: async (tx) => {
                await waitBothPastPrecheck();
                const updated = await updateContactUseCase.execute({
                  actor: fixture.buyerActor,
                  requestId: fixture.requestId.toString(),
                  expectedRequestVersion: 4,
                  recipientName,
                  recipientPhone: '0988777666',
                  tx,
                });
                return {
                  result: {
                    id: updated.id,
                    version: updated.version,
                    recipient_name: updated.recipient_name,
                  },
                  currentState: {
                    request: {
                      id: updated.id,
                      status: updated.status,
                      version: updated.version,
                      cancelled_at: null,
                    },
                  },
                };
              },
              getCurrentState: async (tx) => {
                const fresh = await quoteRequestRepo.findById(
                  fixture.requestId.toString(),
                  tx,
                );
                return {
                  request: {
                    id: fresh!.id,
                    status: fresh!.status,
                    version: fresh!.version,
                    cancelled_at: null,
                  },
                };
              },
            });

          const [res1, res2] = await Promise.allSettled([
            callWithName('Người nhận A'),
            callWithName('Người nhận B'),
          ]);

          const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
          const rejected = [res1, res2].filter((r) => r.status === 'rejected');
          expect(fulfilled).toHaveLength(1);
          expect(rejected).toHaveLength(1);

          const err = (rejected[0] as PromiseRejectedResult).reason;
          expect(err).toBeInstanceOf(IdempotencyConflictError);
          expectHttp409Problem(err, 'IDEMPOTENCY_CONFLICT');

          expect(
            await db.contactEditHistory.count({
              where: { request_id: fixture.requestId },
            }),
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

      it('real PostgreSQL UNIQUE constraint collision (P2002 -> 25P02 aborted tx): rolls back loser side effects and recovers replay (same fingerprint) or throws 409 IDEMPOTENCY_CONFLICT (different fingerprint)', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaIdempotencyRecordRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository'
        );
        const { TradingIdempotencyService } = await import(
          '../../../src/modules/trading/application/services/trading-idempotency.service'
        );
        const { UpdateRecipientContactUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/update-recipient-contact.use-case'
        );

        // Case A: Same fingerprint hits real PG P2002/25P02 -> rolls back ContactEditHistory and returns committed snapshot
        const fixtureA = await seedTradingFixture(db, {
          requestStatus: 'in_production',
          requestVersion: 4,
          workshopCount: 1,
          allocationStatus: 'in_production',
          allocationVersion: 2,
        });
        try {
          const quoteRequestRepo = new PrismaQuoteRequestRepository(txRunner);
          const realIdempRepo = new PrismaIdempotencyRecordRepository(txRunner);
          const updateContact = new UpdateRecipientContactUseCase(
            txRunner,
            quoteRequestRepo,
          );

          const sharedKey = randomUUID();
          const payload = {
            expected_request_version: 4,
            recipient_name: 'Tên Mới P2002',
            recipient_phone: '0911222333',
          };
          const fingerprint = computeCanonicalFingerprint(payload);
          const winningSnapshot = {
            id: fixtureA.requestId.toString(),
            version: 5,
            recipient_name: 'Tên Mới P2002',
            recipient_phone: '0911222333',
          };

          let injected = false;
          const collidingIdempRepo = Object.assign(
            Object.create(Object.getPrototypeOf(realIdempRepo)),
            realIdempRepo,
            {
              save: async (
                ...args: Parameters<typeof realIdempRepo.save>
              ) => {
                if (!injected) {
                  injected = true;
                  // Independent connection commits identical IdempotencyRecord right before tx inserts
                  await db.idempotencyRecord.create({
                    data: {
                      idempotency_key: sharedKey,
                      request_fingerprint: fingerprint,
                      account_id: fixtureA.buyerId,
                      action: 'edit_contact',
                      object_type: 'QuoteRequest',
                      object_id: fixtureA.requestId,
                      result_snapshot: winningSnapshot,
                      created_at: fixtureA.now,
                      expires_at: new Date(
                        fixtureA.now.getTime() + 24 * 3600 * 1000,
                      ),
                    },
                  });
                }
                return realIdempRepo.save(...args);
              },
            },
          ) as InstanceType<typeof PrismaIdempotencyRecordRepository>;

          const serviceA = new TradingIdempotencyService(
            collidingIdempRepo,
            txRunner,
          );

          const recovered = await serviceA.executeWithIdempotency({
            accountId: fixtureA.buyerId.toString(),
            action: 'edit_contact',
            objectType: 'QuoteRequest',
            objectId: fixtureA.requestId.toString(),
            idempotencyKey: sharedKey,
            payload,
            now: fixtureA.now,
            execute: async (tx) => {
              const updated = await updateContact.execute({
                actor: fixtureA.buyerActor,
                requestId: fixtureA.requestId.toString(),
                expectedRequestVersion: 4,
                recipientName: payload.recipient_name,
                recipientPhone: payload.recipient_phone,
                tx,
              });
              return {
                result: {
                  id: updated.id,
                  version: updated.version,
                  recipient_name: updated.recipient_name,
                  recipient_phone: updated.recipient_phone,
                },
                currentState: {
                  request: {
                    id: updated.id,
                    status: updated.status,
                    version: updated.version,
                    cancelled_at: null,
                  },
                },
              };
            },
            getCurrentState: async (tx) => {
              const fresh = await quoteRequestRepo.findById(
                fixtureA.requestId.toString(),
                tx,
              );
              return {
                request: {
                  id: fresh!.id,
                  status: fresh!.status,
                  version: fresh!.version,
                  cancelled_at: null,
                },
              };
            },
          });

          expect(recovered.replayed).toBe(true);
          expect(recovered.data).toEqual(winningSnapshot);
          // Aborted tx MUST have rolled back its own QuoteRequest update + ContactEditHistory!
          expect(
            await db.contactEditHistory.count({
              where: { request_id: fixtureA.requestId },
            }),
          ).toBe(0);
          const reqAfterA = await db.quoteRequest.findUnique({
            where: { id: fixtureA.requestId },
          });
          expect(reqAfterA?.version).toBe(4);
        } finally {
          await cleanupTradingFixture(db, fixtureA);
        }

        // Case B: Different fingerprint hits real PG P2002/25P02 -> rolls back and throws 409 IDEMPOTENCY_CONFLICT
        const fixtureB = await seedTradingFixture(db, {
          requestStatus: 'in_production',
          requestVersion: 4,
          workshopCount: 1,
          allocationStatus: 'in_production',
          allocationVersion: 2,
        });
        try {
          const quoteRequestRepo = new PrismaQuoteRequestRepository(txRunner);
          const realIdempRepo = new PrismaIdempotencyRecordRepository(txRunner);
          const updateContact = new UpdateRecipientContactUseCase(
            txRunner,
            quoteRequestRepo,
          );

          const sharedKey = randomUUID();
          const winnerFingerprint = computeCanonicalFingerprint({
            expected_request_version: 4,
            recipient_name: 'Người Thắng',
            recipient_phone: '0911000000',
          });

          let injected = false;
          const collidingIdempRepo = Object.assign(
            Object.create(Object.getPrototypeOf(realIdempRepo)),
            realIdempRepo,
            {
              save: async (
                ...args: Parameters<typeof realIdempRepo.save>
              ) => {
                if (!injected) {
                  injected = true;
                  await db.idempotencyRecord.create({
                    data: {
                      idempotency_key: sharedKey,
                      request_fingerprint: winnerFingerprint,
                      account_id: fixtureB.buyerId,
                      action: 'edit_contact',
                      object_type: 'QuoteRequest',
                      object_id: fixtureB.requestId,
                      result_snapshot: { winner: true },
                      created_at: fixtureB.now,
                      expires_at: new Date(
                        fixtureB.now.getTime() + 24 * 3600 * 1000,
                      ),
                    },
                  });
                }
                return realIdempRepo.save(...args);
              },
            },
          ) as InstanceType<typeof PrismaIdempotencyRecordRepository>;

          const serviceB = new TradingIdempotencyService(
            collidingIdempRepo,
            txRunner,
          );

          let caught: unknown;
          try {
            await serviceB.executeWithIdempotency({
              accountId: fixtureB.buyerId.toString(),
              action: 'edit_contact',
              objectType: 'QuoteRequest',
              objectId: fixtureB.requestId.toString(),
              idempotencyKey: sharedKey,
              payload: {
                expected_request_version: 4,
                recipient_name: 'Người Khác Payload',
                recipient_phone: '0999888777',
              },
              now: fixtureB.now,
              execute: async (tx) => {
                const updated = await updateContact.execute({
                  actor: fixtureB.buyerActor,
                  requestId: fixtureB.requestId.toString(),
                  expectedRequestVersion: 4,
                  recipientName: 'Người Khác Payload',
                  recipientPhone: '0999888777',
                  tx,
                });
                return {
                  result: { id: updated.id },
                  currentState: {
                    request: {
                      id: updated.id,
                      status: updated.status,
                      version: updated.version,
                      cancelled_at: null,
                    },
                  },
                };
              },
              getCurrentState: async (tx) => {
                const fresh = await quoteRequestRepo.findById(
                  fixtureB.requestId.toString(),
                  tx,
                );
                return {
                  request: {
                    id: fresh!.id,
                    status: fresh!.status,
                    version: fresh!.version,
                    cancelled_at: null,
                  },
                };
              },
            });
          } catch (err) {
            caught = err;
          }

          expect(caught).toBeInstanceOf(IdempotencyConflictError);
          expectHttp409Problem(caught, 'IDEMPOTENCY_CONFLICT');
          expect(
            await db.contactEditHistory.count({
              where: { request_id: fixtureB.requestId },
            }),
          ).toBe(0);
        } finally {
          await cleanupTradingFixture(db, fixtureB);
        }
      });

      it('enforces 5-part scope key isolation on PostgreSQL and rolls back IdempotencyRecord when business mutation fails', async () => {
        const { PrismaIdempotencyRecordRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository'
        );
        const { TradingIdempotencyService } = await import(
          '../../../src/modules/trading/application/services/trading-idempotency.service'
        );

        const fixture = await seedTradingFixture(db, {
          requestStatus: 'in_production',
          requestVersion: 4,
          workshopCount: 1,
          allocationStatus: 'in_production',
          allocationVersion: 2,
        });

        try {
          const service = new TradingIdempotencyService(
            new PrismaIdempotencyRecordRepository(txRunner),
            txRunner,
          );
          const sharedKey = randomUUID();
          const state = {
            request: {
              id: fixture.requestId.toString(),
              status: 'in_production' as const,
              version: 4,
              cancelled_at: null,
            },
          };

          // 1. Same key concurrently across different account_id, action, and object_type
          const [buyerEdit, otherBuyerEdit, buyerClose, buyerAllocAction] =
            await Promise.all([
              service.executeWithIdempotency({
                accountId: fixture.buyerId.toString(),
                action: 'edit_contact',
                objectType: 'QuoteRequest',
                objectId: fixture.requestId.toString(),
                idempotencyKey: sharedKey,
                payload: { k: 1 },
                now: fixture.now,
                execute: async () => ({
                  result: { scope: 'buyer-edit' },
                  currentState: state,
                }),
                getCurrentState: async () => state,
              }),
              service.executeWithIdempotency({
                accountId: fixture.otherBuyerId.toString(),
                action: 'edit_contact',
                objectType: 'QuoteRequest',
                objectId: fixture.requestId.toString(),
                idempotencyKey: sharedKey,
                payload: { k: 2 },
                now: fixture.now,
                execute: async () => ({
                  result: { scope: 'other-buyer-edit' },
                  currentState: state,
                }),
                getCurrentState: async () => state,
              }),
              service.executeWithIdempotency({
                accountId: fixture.buyerId.toString(),
                action: 'close_bidding',
                objectType: 'QuoteRequest',
                objectId: fixture.requestId.toString(),
                idempotencyKey: sharedKey,
                payload: { k: 3 },
                now: fixture.now,
                execute: async () => ({
                  result: { scope: 'buyer-close' },
                  currentState: state,
                }),
                getCurrentState: async () => state,
              }),
              service.executeWithIdempotency({
                accountId: fixture.buyerId.toString(),
                action: 'edit_contact',
                objectType: 'Allocation',
                objectId: fixture.workshops[0].allocationId!.toString(),
                idempotencyKey: sharedKey,
                payload: { k: 4 },
                now: fixture.now,
                execute: async () => ({
                  result: { scope: 'buyer-alloc' },
                  currentState: state,
                }),
                getCurrentState: async () => state,
              }),
            ]);

          expect(buyerEdit.replayed).toBe(false);
          expect(otherBuyerEdit.replayed).toBe(false);
          expect(buyerClose.replayed).toBe(false);
          expect(buyerAllocAction.replayed).toBe(false);
          expect(buyerEdit.data).toEqual({ scope: 'buyer-edit' });
          expect(otherBuyerEdit.data).toEqual({ scope: 'other-buyer-edit' });

          expect(
            await db.idempotencyRecord.count({
              where: { idempotency_key: sharedKey },
            }),
          ).toBe(4);

          // 2. Failed business mutation MUST NOT commit an IdempotencyRecord (allows clean retry with same key)
          const retryableKey = randomUUID();
          await expect(
            service.executeWithIdempotency({
              accountId: fixture.buyerId.toString(),
              action: 'confirm_delivery',
              objectType: 'QuoteRequest',
              objectId: fixture.requestId.toString(),
              idempotencyKey: retryableKey,
              payload: { expected_request_version: 1 },
              now: fixture.now,
              execute: async () => {
                throw new ConcurrencyConflictError('Stale version v1');
              },
              getCurrentState: async () => state,
            }),
          ).rejects.toBeInstanceOf(ConcurrencyConflictError);

          expect(
            await db.idempotencyRecord.count({
              where: {
                account_id: fixture.buyerId,
                idempotency_key: retryableKey,
              },
            }),
          ).toBe(0);

          // Now the same key succeeds once the client fixes the payload
          const retrySuccess = await service.executeWithIdempotency({
            accountId: fixture.buyerId.toString(),
            action: 'confirm_delivery',
            objectType: 'QuoteRequest',
            objectId: fixture.requestId.toString(),
            idempotencyKey: retryableKey,
            payload: { expected_request_version: 4 },
            now: fixture.now,
            execute: async () => ({
              result: { ok: true },
              currentState: state,
            }),
            getCurrentState: async () => state,
          });
          expect(retrySuccess.replayed).toBe(false);
        } finally {
          await cleanupTradingFixture(db, fixture);
        }
      });
    });

    // =========================================================================
    // 2. Stale expected_*_version Rejected with HTTP 409 CONCURRENCY_CONFLICT
    // =========================================================================
    describe('2) Stale expected_*_version Rejected with 409 CONCURRENCY_CONFLICT across ALL 4 Versioned Entities (BR-27, api-design.md §1.4 & §13)', () => {
      it('QuoteRequest stale expected_request_version is rejected with 409 CONCURRENCY_CONFLICT across repository and draft/bidding/fulfillment use cases', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaRequestRecipientRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { UpdateDraftQuoteRequestUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/update-draft-quote-request.use-case'
        );
        const { DeleteDraftQuoteRequestUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/delete-draft-quote-request.use-case'
        );
        const { CloseBiddingUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/close-bidding.use-case'
        );
        const { UpdateRecipientContactUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/update-recipient-contact.use-case'
        );
        const { CancelQuoteRequestByBuyerUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/cancel-quote-request-by-buyer.use-case'
        );
        const { CancelQuoteRequestByAdminUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/cancel-quote-request-by-admin.use-case'
        );
        const { ConfirmDeliveryUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/confirm-delivery.use-case'
        );
        const { ConfirmDeliveryByAdminUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/confirm-delivery-by-admin.use-case'
        );
        const { SendRequestWorkflow } = await import(
          '../../../src/workflows/send-request/send-request.workflow'
        );

        // Part A: Draft operations (version = 2 in DB, client sends stale version = 1)
        const draftFixture = await seedTradingFixture(db, {
          requestStatus: 'draft_request',
          requestVersion: 2,
          workshopCount: 1,
          seedPublishedProducts: true,
          seedRecipients: false,
          seedQuotes: false,
        });
        try {
          const quoteRequestRepo = new PrismaQuoteRequestRepository(txRunner);
          const recipientRepo = new PrismaRequestRecipientRepository(txRunner);
          const wsContract = createPgWorkshopContract(db, txRunner);
          const catalogContract = createPgCatalogContract(txRunner);

          // Repository direct updateMany WHERE version = expectedVersion check
          await expectStaleVersion409(
            txRunner.run(async (tx) => {
              const current = await quoteRequestRepo.findById(
                draftFixture.requestId.toString(),
                tx,
              );
              const mutated = current!.updateDraft({
                buyerId: draftFixture.buyerId.toString(),
                expectedVersion: 2,
                draft: { spec: 'New spec' },
                now: draftFixture.now,
              });
              // Force stale expectedVersion = 1 at persistence layer
              await quoteRequestRepo.update(
                { request: mutated, expectedVersion: 1 },
                tx,
              );
            }),
          );

          // UpdateDraftQuoteRequestUseCase
          const updateDraft = new UpdateDraftQuoteRequestUseCase(
            txRunner,
            quoteRequestRepo,
          );
          await expectStaleVersion409(
            updateDraft.execute({
              actor: draftFixture.buyerActor,
              requestId: draftFixture.requestId.toString(),
              expectedRequestVersion: 1,
              spec: 'Stale draft edit',
            }),
          );

          // DeleteDraftQuoteRequestUseCase
          const deleteDraft = new DeleteDraftQuoteRequestUseCase(
            txRunner,
            quoteRequestRepo,
          );
          await expectStaleVersion409(
            deleteDraft.execute({
              actor: draftFixture.buyerActor,
              requestId: draftFixture.requestId.toString(),
              expectedRequestVersion: 1,
            }),
          );
          // Verify draft was NOT deleted
          expect(
            await db.quoteRequest.findUnique({
              where: { id: draftFixture.requestId },
            }),
          ).not.toBeNull();

          // SendRequestWorkflow
          const sendWorkflow = new SendRequestWorkflow(
            txRunner,
            quoteRequestRepo,
            recipientRepo,
            catalogContract,
            wsContract,
          );
          await expectStaleVersion409(
            sendWorkflow.execute({
              actor: draftFixture.buyerActor,
              requestId: draftFixture.requestId.toString(),
              expectedRequestVersion: 1,
              now: draftFixture.now,
            }),
          );
          expect(
            await db.requestRecipient.count({
              where: { request_id: draftFixture.requestId },
            }),
          ).toBe(0);
        } finally {
          await cleanupTradingFixture(db, draftFixture);
        }

        // Part B: Bidding-phase mutations (version = 3 in DB, client sends stale version = 2)
        const biddingFixture = await seedTradingFixture(db, {
          requestStatus: 'artisans_bidding',
          requestVersion: 3,
          workshopCount: 1,
        });
        try {
          const quoteRequestRepo = new PrismaQuoteRequestRepository(txRunner);

          const closeBidding = new CloseBiddingUseCase(
            txRunner,
            quoteRequestRepo,
          );
          await expectStaleVersion409(
            closeBidding.execute({
              actor: biddingFixture.buyerActor,
              requestId: biddingFixture.requestId.toString(),
              expectedRequestVersion: 2,
              now: biddingFixture.now,
            }),
          );

          const updateContact = new UpdateRecipientContactUseCase(
            txRunner,
            quoteRequestRepo,
          );
          await expectStaleVersion409(
            updateContact.execute({
              actor: biddingFixture.buyerActor,
              requestId: biddingFixture.requestId.toString(),
              expectedRequestVersion: 2,
              recipientName: 'Stale Contact Edit',
            }),
          );
          expect(
            await db.contactEditHistory.count({
              where: { request_id: biddingFixture.requestId },
            }),
          ).toBe(0);

          const buyerCancel = new CancelQuoteRequestByBuyerUseCase(
            txRunner,
            quoteRequestRepo,
          );
          await expectStaleVersion409(
            buyerCancel.execute({
              actor: biddingFixture.buyerActor,
              requestId: biddingFixture.requestId.toString(),
              expectedRequestVersion: 2,
              cancelReason: 'Stale buyer cancel',
              now: biddingFixture.now,
            }),
          );

          const persisted = await db.quoteRequest.findUnique({
            where: { id: biddingFixture.requestId },
          });
          expect(persisted?.version).toBe(3);
          expect(persisted?.bidding_closed_at).toBeNull();
          expect(persisted?.cancelled_at).toBeNull();
        } finally {
          await cleanupTradingFixture(db, biddingFixture);
        }

        // Part C: Fulfillment-phase request mutations (version = 5 in DB, client sends stale version = 4)
        const prodFixture = await seedTradingFixture(db, {
          requestStatus: 'in_production',
          requestVersion: 5,
          workshopCount: 1,
          allocationStatus: 'handed_over',
          allocationVersion: 3,
        });
        try {
          const quoteRequestRepo = new PrismaQuoteRequestRepository(txRunner);
          const allocationRepo = new PrismaAllocationRepository(txRunner);

          const adminCancel = new CancelQuoteRequestByAdminUseCase(
            txRunner,
            quoteRequestRepo,
          );
          await expectStaleVersion409(
            adminCancel.execute({
              actor: prodFixture.adminActor,
              requestId: prodFixture.requestId.toString(),
              expectedRequestVersion: 4,
              cancelReason: 'Stale admin cancel',
              goodsHandlingNote: 'Stale handling',
              now: prodFixture.now,
            }),
          );

          const buyerConfirm = new ConfirmDeliveryUseCase(
            txRunner,
            quoteRequestRepo,
            allocationRepo,
          );
          await expectStaleVersion409(
            buyerConfirm.execute({
              actor: prodFixture.buyerActor,
              requestId: prodFixture.requestId.toString(),
              expectedRequestVersion: 4,
              now: prodFixture.now,
            }),
          );

          const adminConfirm = new ConfirmDeliveryByAdminUseCase(
            txRunner,
            quoteRequestRepo,
            allocationRepo,
          );
          await expectStaleVersion409(
            adminConfirm.execute({
              actor: prodFixture.adminActor,
              requestId: prodFixture.requestId.toString(),
              expectedRequestVersion: 4,
              reason: 'Stale admin confirm',
              evidence: 'Biên bản BB-stale',
              now: prodFixture.now,
            }),
          );

          const persisted = await db.quoteRequest.findUnique({
            where: { id: prodFixture.requestId },
          });
          expect(persisted?.status).toBe('in_production');
          expect(persisted?.version).toBe(5);
          expect(persisted?.cancelled_at).toBeNull();
          expect(
            await db.statusLog.count({
              where: { request_id: prodFixture.requestId },
            }),
          ).toBe(0);
        } finally {
          await cleanupTradingFixture(db, prodFixture);
        }
      });

      it('RequestRecipient & Quote stale versions are rejected with 409 CONCURRENCY_CONFLICT across Decline, Submit/Edit, Withdraw, and Accept (BR-27, api-design.md §13)', async () => {
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
        const { DeclineQuoteRequestUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/quotations/decline-quote-request.use-case'
        );
        const { SubmitQuoteUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/quotations/submit-quote.use-case'
        );
        const { WithdrawQuoteUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/quotations/withdraw-quote.use-case'
        );
        const { AcceptQuotationWorkflow } = await import(
          '../../../src/workflows/accept-quotation'
        );

        // Part A: Pending recipient at version 2 — stale expected_recipient_version: 1 on Decline & Submit
        const pendingFixture = await seedTradingFixture(db, {
          requestStatus: 'sent_to_artisans',
          requestVersion: 2,
          workshopCount: 1,
          seedRecipients: true,
          recipientResponseStatus: 'pending',
          recipientVersion: 2,
          seedQuotes: false,
        });
        try {
          const quoteRequestRepo = new PrismaQuoteRequestRepository(txRunner);
          const recipientRepo = new PrismaRequestRecipientRepository(txRunner);
          const quoteRepo = new PrismaQuoteRepository(txRunner);
          const wsContract = createPgWorkshopContract(db, txRunner);
          const w = pendingFixture.workshops[0];

          // Repository-level stale version check
          await expectStaleVersion409(
            txRunner.run(async (tx) => {
              const rec = await recipientRepo.findById(
                w.recipientId!.toString(),
                tx,
              );
              const { recipient: declined } = rec!.decline({
                actorId: w.artisanId.toString(),
                expectedVersion: 2,
                reason: 'Repo stale test',
                requestBiddingOpen: true,
                requestAcceptedOrCancelled: false,
                now: pendingFixture.now,
              });
              await recipientRepo.update(
                { recipient: declined, expectedVersion: 1 },
                tx,
              );
            }),
          );

          const declineUseCase = new DeclineQuoteRequestUseCase(
            txRunner,
            quoteRequestRepo,
            recipientRepo,
            quoteRepo,
            wsContract,
          );
          await expectStaleVersion409(
            declineUseCase.execute({
              actor: w.artisanActor,
              requestId: pendingFixture.requestId.toString(),
              expectedRecipientVersion: 1,
              declineReason: 'Stale decline',
              now: pendingFixture.now,
            }),
          );

          const submitUseCase = new SubmitQuoteUseCase(
            txRunner,
            quoteRequestRepo,
            recipientRepo,
            quoteRepo,
            wsContract,
          );
          // Stale expected_recipient_version
          await expectStaleVersion409(
            submitUseCase.execute({
              actor: w.artisanActor,
              requestId: pendingFixture.requestId.toString(),
              expectedRecipientVersion: 1,
              expectedQuoteVersion: null,
              unitPrice: 40000,
              maxQuantity: 500,
              bidAcceptDeadline: pendingFixture.bidAcceptDeadline,
              committedDeliveryAt: pendingFixture.committedDeliveryAt,
              now: pendingFixture.now,
            }),
          );

          // Non-null expected_quote_version when no Quote exists yet -> 409 CONCURRENCY_CONFLICT
          await expectStaleVersion409(
            submitUseCase.execute({
              actor: w.artisanActor,
              requestId: pendingFixture.requestId.toString(),
              expectedRecipientVersion: 2,
              expectedQuoteVersion: 1,
              unitPrice: 40000,
              maxQuantity: 500,
              bidAcceptDeadline: pendingFixture.bidAcceptDeadline,
              committedDeliveryAt: pendingFixture.committedDeliveryAt,
              now: pendingFixture.now,
            }),
          );

          expect(
            await db.recipientResponseHistory.count({
              where: { recipient_id: w.recipientId! },
            }),
          ).toBe(0);
        } finally {
          await cleanupTradingFixture(db, pendingFixture);
        }

        // Part B: Existing Quote v2 (recipient v3): stale Quote v1 rejected on Edit, Withdraw, and Buyer Accept
        const quotedFixture = await seedTradingFixture(db, {
          requestStatus: 'artisans_bidding',
          requestVersion: 2,
          workshopCount: 1,
          recipientResponseStatus: 'quoted',
          recipientVersion: 3,
          quoteStatus: 'active',
          quoteVersion: 2,
        });
        try {
          const quoteRequestRepo = new PrismaQuoteRequestRepository(txRunner);
          const recipientRepo = new PrismaRequestRecipientRepository(txRunner);
          const quoteRepo = new PrismaQuoteRepository(txRunner);
          const wsContract = createPgWorkshopContract(db, txRunner);
          const w = quotedFixture.workshops[0];

          const submitUseCase = new SubmitQuoteUseCase(
            txRunner,
            quoteRequestRepo,
            recipientRepo,
            quoteRepo,
            wsContract,
          );
          // Stale expected_quote_version: 1
          await expectStaleVersion409(
            submitUseCase.execute({
              actor: w.artisanActor,
              requestId: quotedFixture.requestId.toString(),
              expectedRecipientVersion: 3,
              expectedQuoteVersion: 1,
              unitPrice: 42000,
              maxQuantity: 500,
              bidAcceptDeadline: quotedFixture.bidAcceptDeadline,
              committedDeliveryAt: quotedFixture.committedDeliveryAt,
              now: quotedFixture.now,
            }),
          );

          // Null expected_quote_version when Quote already exists -> 409 CONCURRENCY_CONFLICT
          await expectStaleVersion409(
            submitUseCase.execute({
              actor: w.artisanActor,
              requestId: quotedFixture.requestId.toString(),
              expectedRecipientVersion: 3,
              expectedQuoteVersion: null,
              unitPrice: 42000,
              maxQuantity: 500,
              bidAcceptDeadline: quotedFixture.bidAcceptDeadline,
              committedDeliveryAt: quotedFixture.committedDeliveryAt,
              now: quotedFixture.now,
            }),
          );

          const withdrawUseCase = new WithdrawQuoteUseCase(
            txRunner,
            quoteRequestRepo,
            recipientRepo,
            quoteRepo,
            wsContract,
          );
          // Stale expected_quote_version: 1
          await expectStaleVersion409(
            withdrawUseCase.execute({
              actor: w.artisanActor,
              requestId: quotedFixture.requestId.toString(),
              expectedRecipientVersion: 3,
              expectedQuoteVersion: 1,
              withdrawReason: 'Stale withdraw',
              now: quotedFixture.now,
            }),
          );

          // api-design.md §13: Buyer saw Quote v1, workshop updated to v2 -> Buyer accept v1 gets 409 CONCURRENCY_CONFLICT
          const acceptWorkflow = new AcceptQuotationWorkflow(
            txRunner,
            new TradingAcceptanceService(
              quoteRequestRepo,
              recipientRepo,
              quoteRepo,
              new PrismaAllocationRepository(txRunner),
              new PrismaIdempotencyRecordRepository(txRunner),
              wsContract,
            ),
            wsContract,
          );
          await expectStaleVersion409(
            acceptWorkflow.execute({
              actor: quotedFixture.buyerActor,
              requestId: quotedFixture.requestId.toString(),
              quoteId: w.quoteId!.toString(),
              expectedRequestVersion: 2,
              expectedQuoteVersion: 1,
              idempotencyKey: randomUUID(),
              now: quotedFixture.now,
            }),
          );

          const persistedQuote = await db.quote.findUnique({
            where: { id: w.quoteId! },
          });
          expect(persistedQuote?.status).toBe('active');
          expect(persistedQuote?.version).toBe(2);
          expect(
            await db.allocation.count({
              where: { request_id: quotedFixture.requestId },
            }),
          ).toBe(0);
        } finally {
          await cleanupTradingFixture(db, quotedFixture);
        }
      });

      it('Allocation stale expected_allocation_version is rejected with 409 CONCURRENCY_CONFLICT and remains isolated from QuoteRequest version bumps (BR-27)', async () => {
        const { PrismaQuoteRequestRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );
        const { PrismaAllocationBatchRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation-batch.repository'
        );
        const { StartAllocationProductionUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/start-allocation-production.use-case'
        );
        const { HandoverAllocationUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/handover-allocation.use-case'
        );
        const { HandoverAllocationByAdminUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/fulfillment/handover-allocation-by-admin.use-case'
        );
        const { UpdateRecipientContactUseCase } = await import(
          '../../../src/modules/trading/application/use-cases/requests/update-recipient-contact.use-case'
        );
        const { LinkBatchesWorkflow } = await import(
          '../../../src/workflows/link-batches'
        );

        // Part A: StartAllocationProductionUseCase with stale expected_allocation_version
        const acceptedFixture = await seedTradingFixture(db, {
          requestStatus: 'buyer_accepted',
          requestVersion: 3,
          workshopCount: 1,
          allocationStatus: 'not_started',
          allocationVersion: 2,
        });
        try {
          const startUseCase = new StartAllocationProductionUseCase(
            txRunner,
            new PrismaAllocationRepository(txRunner),
            new PrismaQuoteRequestRepository(txRunner),
            createPgWorkshopContract(db, txRunner),
          );
          const w = acceptedFixture.workshops[0];

          await expectStaleVersion409(
            startUseCase.execute({
              actor: w.artisanActor,
              allocationId: w.allocationId!.toString(),
              expectedAllocationVersion: 1,
              now: acceptedFixture.now,
            }),
          );
        } finally {
          await cleanupTradingFixture(db, acceptedFixture);
        }

        // Part B: In-production Allocation v3 — stale v2 rejected on LinkBatches, Handover, AdminHandover;
        // AND QuoteRequest contact bump (v4 -> v5) does NOT conflict with Allocation v3!
        const prodFixture = await seedTradingFixture(db, {
          requestStatus: 'in_production',
          requestVersion: 4,
          workshopCount: 1,
          allocationStatus: 'in_production',
          allocationVersion: 3,
          batchesPerWorkshop: 2,
        });
        try {
          const quoteRequestRepo = new PrismaQuoteRequestRepository(txRunner);
          const allocationRepo = new PrismaAllocationRepository(txRunner);
          const allocationBatchRepo = new PrismaAllocationBatchRepository(txRunner);
          const wsContract = createPgWorkshopContract(db, txRunner);
          const traceContract = createPgTraceabilityContract(txRunner);
          const w = prodFixture.workshops[0];

          const linkWorkflow = new LinkBatchesWorkflow(
            txRunner,
            allocationRepo,
            quoteRequestRepo,
            traceContract,
            allocationBatchRepo,
            wsContract,
          );
          const handoverUseCase = new HandoverAllocationUseCase(
            txRunner,
            allocationRepo,
            quoteRequestRepo,
            wsContract,
          );
          const adminHandoverUseCase = new HandoverAllocationByAdminUseCase(
            txRunner,
            allocationRepo,
            quoteRequestRepo,
            wsContract,
          );
          const updateContactUseCase = new UpdateRecipientContactUseCase(
            txRunner,
            quoteRequestRepo,
          );

          // 1. Stale expected_allocation_version: 2 on LinkBatchesWorkflow
          await expectStaleVersion409(
            linkWorkflow.execute({
              actor: w.artisanActor,
              allocationId: w.allocationId!.toString(),
              expectedAllocationVersion: 2,
              links: [{ batch_id: w.batchIds[0].toString(), linked_quantity: 250 }],
              now: prodFixture.now,
            }),
          );

          // 2. Stale expected_allocation_version: 2 on HandoverAllocationUseCase
          await expectStaleVersion409(
            handoverUseCase.execute({
              actor: w.artisanActor,
              allocationId: w.allocationId!.toString(),
              expectedAllocationVersion: 2,
              deliveryNote: 'Stale handover',
              now: prodFixture.now,
            }),
          );

          // 3. Stale expected_allocation_version: 2 on HandoverAllocationByAdminUseCase
          await expectStaleVersion409(
            adminHandoverUseCase.execute({
              actor: prodFixture.adminActor,
              allocationId: w.allocationId!.toString(),
              expectedAllocationVersion: 2,
              reason: 'Stale admin handover',
              evidence: 'Biên bản BB-stale',
              actualHandoverAt: prodFixture.now,
              now: prodFixture.now,
            }),
          );

          expect(
            await db.allocationBatch.count({
              where: { allocation_id: w.allocationId! },
            }),
          ).toBe(0);
          expect(
            await db.allocationLog.count({
              where: { allocation_id: w.allocationId! },
            }),
          ).toBe(0);

          // 4. BR-27 version isolation: Buyer updates QuoteRequest contact (v4 -> v5);
          //    Artisan still succeeds linking batches using unchanged Allocation v3!
          const contactUpdated = await updateContactUseCase.execute({
            actor: prodFixture.buyerActor,
            requestId: prodFixture.requestId.toString(),
            expectedRequestVersion: 4,
            recipientName: 'Người Nhận Mới',
            recipientPhone: '0987000111',
          });
          expect(contactUpdated.version).toBe(5);

          const linked = await linkWorkflow.execute({
            actor: w.artisanActor,
            allocationId: w.allocationId!.toString(),
            expectedAllocationVersion: 3,
            links: [{ batch_id: w.batchIds[0].toString(), linked_quantity: 500 }],
            now: prodFixture.now,
          });
          expect(linked.allocation.version).toBe(4);
          expect(linked.allocation.traceability_warning).toBeNull();

          // 5. Concurrent LinkBatches vs Handover on SAME Allocation v4: exactly 1 succeeds
          const [linkRaceRes, handoverRaceRes] = await Promise.allSettled([
            linkWorkflow.execute({
              actor: w.artisanActor,
              allocationId: w.allocationId!.toString(),
              expectedAllocationVersion: 4,
              links: [
                { batch_id: w.batchIds[0].toString(), linked_quantity: 200 },
                { batch_id: w.batchIds[1].toString(), linked_quantity: 300 },
              ],
              now: prodFixture.now,
            }),
            handoverUseCase.execute({
              actor: w.artisanActor,
              allocationId: w.allocationId!.toString(),
              expectedAllocationVersion: 4,
              deliveryNote: 'Bàn giao cạnh tranh với gắn lô',
              now: prodFixture.now,
            }),
          ]);

          const fulfilled = [linkRaceRes, handoverRaceRes].filter(
            (r) => r.status === 'fulfilled',
          );
          const rejected = [linkRaceRes, handoverRaceRes].filter(
            (r) => r.status === 'rejected',
          );
          expect(fulfilled).toHaveLength(1);
          expect(rejected).toHaveLength(1);
          const loserErr = (rejected[0] as PromiseRejectedResult).reason;
          expect(
            loserErr instanceof ConcurrencyConflictError ||
              loserErr instanceof InvalidStateTransitionError,
          ).toBe(true);

          const finalAlloc = await db.allocation.findUnique({
            where: { id: w.allocationId! },
          });
          expect(finalAlloc?.version).toBe(5);
        } finally {
          await cleanupTradingFixture(db, prodFixture);
        }
      });
    });

    // =========================================================================
    // 3. PostgreSQL Schema Constraints Defense-in-Depth
    // =========================================================================
    describe('3) PostgreSQL Schema Constraints Defense-in-Depth (data-design.md §4.1, SEC-13)', () => {
      it('enforces QuoteRequest_cancellation_check, Allocation unique constraints, and Quote unique constraints at PostgreSQL level', async () => {
        const { PrismaQuoteRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/quote.repository'
        );
        const { PrismaAllocationRepository } = await import(
          '../../../src/modules/trading/adapters/persistence/repositories/allocation.repository'
        );

        const fixture = await seedTradingFixture(db, {
          requestStatus: 'in_production',
          requestVersion: 4,
          workshopCount: 1,
          allocationStatus: 'handed_over',
          allocationVersion: 3,
        });

        try {
          const w = fixture.workshops[0];

          // 1. PostgreSQL CHECK constraint blocks setting both status='delivered' AND cancelled_at != NULL
          await expect(
            db.quoteRequest.update({
              where: { id: fixture.requestId },
              data: {
                status: 'delivered',
                cancelled_at: fixture.now,
                cancelled_by: fixture.adminId,
              },
            }),
          ).rejects.toThrow(/QuoteRequest_cancellation_check/);

          // 2. PrismaQuoteRepository maps PG P2002 on duplicate Quote(request_id, workshop_id) to 409 CONCURRENCY_CONFLICT
          const quoteRepo = new PrismaQuoteRepository(txRunner);
          const duplicateQuote = Quote.reconstitute({
            id: '999999',
            request_id: fixture.requestId.toString(),
            workshop_id: w.workshopId.toString(),
            unit_price: 40000,
            max_quantity: 500,
            bid_accept_deadline: fixture.bidAcceptDeadline,
            committed_delivery_at: fixture.committedDeliveryAt,
            status: 'active',
            version: 1,
            withdraw_reason: null,
            withdrawn_by: null,
            withdrawn_at: null,
            created_at: fixture.now,
            updated_at: fixture.now,
          });
          await expectStaleVersion409(
            txRunner.run((tx) =>
              quoteRepo.create({ quote: duplicateQuote, useEntityId: false }, tx),
            ),
          );

          // 3. PrismaAllocationRepository maps PG P2002 on duplicate Allocation(request_id, workshop_id / quote_id) to 409 CONCURRENCY_CONFLICT
          const allocRepo = new PrismaAllocationRepository(txRunner);
          const duplicateAlloc = Allocation.reconstitute({
            id: '999999',
            request_id: fixture.requestId.toString(),
            workshop_id: w.workshopId.toString(),
            quote_id: w.quoteId!.toString(),
            quantity: 500,
            unit_price: 45000,
            committed_delivery_at: fixture.committedDeliveryAt,
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
            created_at: fixture.now,
            updated_at: fixture.now,
            batch_links: [],
          });
          await expectStaleVersion409(
            txRunner.run((tx) =>
              allocRepo.create(
                { allocation: duplicateAlloc, useEntityId: false },
                tx,
              ),
            ),
          );
        } finally {
          await cleanupTradingFixture(db, fixture);
        }
      });
    });
  },
);
