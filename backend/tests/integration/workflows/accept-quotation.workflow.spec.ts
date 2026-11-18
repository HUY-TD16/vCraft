import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransactionContext } from '../../../src/common/application/ports/transaction-runner';
import { BusinessRuleException } from '../../../src/common/domain/errors/business-rule.exception';
import type { PrismaService } from '../../../src/infrastructure/database/prisma/prisma.service';
import type { PrismaTransactionRunner } from '../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import {
  ConcurrencyConflictError,
  InvalidStateTransitionError,
} from '../../../src/modules/trading/domain';
import { computeCanonicalFingerprint } from '../../../src/modules/trading/domain/utilities';
import { WorkshopSuspended } from '../../../src/modules/workshops/domain/errors/workshop-suspended';
import type {
  IWorkshopContract,
  WorkshopStatus,
} from '../../../src/modules/workshops/public/contracts/workshop.contract';

const testUrl = process.env.VCRAFT_TEST_DATABASE_URL;

function createPgWorkshopContract(
  db: PrismaService,
  txRunner: PrismaTransactionRunner,
): IWorkshopContract {
  return {
    async lockAndAssertActive(workshopIds, tx: TransactionContext) {
      const client = txRunner.getClient(tx);
      for (const workshopId of workshopIds) {
        const rows = await client.$queryRaw<
          Array<{ id: bigint; status: string }>
        >`SELECT "id", "status" FROM "Workshop" WHERE "id" = ${BigInt(workshopId)} FOR UPDATE`;
        if (rows.length === 0) {
          throw new BusinessRuleException('RESOURCE_NOT_FOUND');
        }
        if (rows[0].status !== 'active') {
          throw new WorkshopSuspended();
        }
      }
    },
    async getWorkshopSummary(workshopId) {
      const row = await db.workshop.findUnique({
        where: { id: BigInt(workshopId) },
      });
      if (!row) {
        return null;
      }
      return {
        id: row.id.toString(),
        name: row.name,
        status: row.status as WorkshopStatus,
        isProfilePublic: true,
      };
    },
    async createWorkshop() {
      throw new Error('Not used in workflow integration test');
    },
    async changeStatus() {
      throw new Error('Not used in workflow integration test');
    },
    async getProfileImageAccess() {
      throw new Error('Not used in workflow integration test');
    },
  };
}

interface SeededScenario {
  buyerId: bigint;
  categoryId: bigint;
  requestId: bigint;
  now: Date;
  workshops: Array<{
    artisanId: bigint;
    workshopId: bigint;
    recipientId: bigint;
    quoteId: bigint;
  }>;
}

async function seedScenario(
  db: PrismaService,
  workshopCount: number = 1,
): Promise<SeededScenario> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const now = new Date();

  const buyer = await db.account.create({
    data: {
      username: `buyer_wf_${suffix}`,
      password_hash: 'hash',
      role: 'buyer',
      display_name: 'Buyer Workflow PG',
      phone: '0901234567',
    },
  });
  const category = await db.category.create({
    data: { name: `Cat WF ${suffix}` },
  });

  const request = await db.quoteRequest.create({
    data: {
      buyer_id: buyer.id,
      category_id: category.id,
      spec: '500 chén trà men ngọc Bát Tràng',
      quantity: 500,
      unit: 'piece',
      status: 'artisans_bidding',
      delivery_mode: 'at_buyer_address',
      delivery_region: 'Hà Nội',
      delivery_address: 'Bát Tràng, Gia Lâm',
      recipient_name: 'Buyer Workflow PG',
      recipient_phone: '0901234567',
      bidding_deadline: new Date(now.getTime() + 48 * 3600 * 1000),
      delivery_deadline: new Date(now.getTime() + 120 * 3600 * 1000),
      version: 2,
    },
  });

  const workshops: SeededScenario['workshops'] = [];
  for (let i = 0; i < workshopCount; i++) {
    const artisan = await db.account.create({
      data: {
        username: `art_wf_${i}_${suffix}`,
        password_hash: 'hash',
        role: 'artisan',
        display_name: `Artisan ${i}`,
      },
    });
    const workshop = await db.workshop.create({
      data: {
        account_id: artisan.id,
        name: `Workshop ${i} ${suffix}`,
        status: 'active',
      },
    });
    const recipient = await db.requestRecipient.create({
      data: {
        request_id: request.id,
        workshop_id: workshop.id,
        response_status: 'quoted',
        responded_by: artisan.id,
        responded_at: now,
        sent_at: now,
        version: 2,
      },
    });
    const quote = await db.quote.create({
      data: {
        request_id: request.id,
        workshop_id: workshop.id,
        unit_price: 45000 + i * 1000,
        max_quantity: 500,
        bid_accept_deadline: new Date(now.getTime() + 72 * 3600 * 1000),
        committed_delivery_at: new Date(now.getTime() + 96 * 3600 * 1000),
        status: 'active',
        version: 1,
      },
    });
    workshops.push({
      artisanId: artisan.id,
      workshopId: workshop.id,
      recipientId: recipient.id,
      quoteId: quote.id,
    });
  }

  return {
    buyerId: buyer.id,
    categoryId: category.id,
    requestId: request.id,
    now,
    workshops,
  };
}

async function cleanupScenario(db: PrismaService, seeded: SeededScenario) {
  await db.allocationLog.deleteMany({
    where: { allocation: { request_id: seeded.requestId } },
  });
  await db.allocation.deleteMany({
    where: { request_id: seeded.requestId },
  });
  for (const w of seeded.workshops) {
    await db.recipientResponseHistory.deleteMany({
      where: { recipient_id: w.recipientId },
    });
    await db.quote.deleteMany({ where: { id: w.quoteId } });
    await db.requestRecipient.deleteMany({ where: { id: w.recipientId } });
  }
  await db.statusLog.deleteMany({ where: { request_id: seeded.requestId } });
  await db.idempotencyRecord.deleteMany({
    where: { account_id: seeded.buyerId },
  });
  await db.quoteRequest.deleteMany({ where: { id: seeded.requestId } });
  await db.category.deleteMany({ where: { id: seeded.categoryId } });
  for (const w of seeded.workshops) {
    await db.workshop.deleteMany({ where: { id: w.workshopId } });
  }
  await db.account.deleteMany({
    where: {
      id: {
        in: [seeded.buyerId, ...seeded.workshops.map((w) => w.artisanId)],
      },
    },
  });
}

describe.skipIf(!testUrl)(
  'Task 24 AcceptQuotationWorkflow PostgreSQL Concurrency & Race Integration',
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

    it('concurrent accept vs withdraw: both commit orders leave consistent PostgreSQL state without deadlocks', async () => {
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

      // Order A: accept locks QuoteRequest first and commits; withdraw blocks on FOR UPDATE then rejects
      const scenarioA = await seedScenario(db, 1);
      try {
        const wsContract = createPgWorkshopContract(db, txRunner);
        const realAllocRepo = new PrismaAllocationRepository(txRunner);
        let releaseWithdrawA!: () => void;
        const acceptLockedPromise = new Promise<void>((resolve) => {
          releaseWithdrawA = resolve;
        });
        const gatedAllocRepo = Object.assign(
          Object.create(Object.getPrototypeOf(realAllocRepo)),
          realAllocRepo,
          {
            create: async (
              ...args: Parameters<PrismaAllocationRepository['create']>
            ) => {
              // Accept now holds Workshop, QuoteRequest, RequestRecipient, Quote FOR UPDATE locks
              releaseWithdrawA();
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

        const wA = scenarioA.workshops[0];
        const acceptPromise = acceptWorkflow.execute({
          actor: {
            accountId: scenarioA.buyerId.toString(),
            role: 'buyer',
            workshopId: null,
            authVersion: 1,
            sessionId: 'sess-buyer-a',
          },
          requestId: scenarioA.requestId.toString(),
          quoteId: wA.quoteId.toString(),
          expectedRequestVersion: 2,
          expectedQuoteVersion: 1,
          idempotencyKey: randomUUID(),
          now: scenarioA.now,
        });
        acceptPromise.catch(() => releaseWithdrawA());

        await acceptLockedPromise;
        const withdrawPromise = withdrawUseCase.execute({
          actor: {
            accountId: wA.artisanId.toString(),
            role: 'artisan',
            workshopId: wA.workshopId.toString(),
            authVersion: 1,
            sessionId: 'sess-artisan-a',
          },
          requestId: scenarioA.requestId.toString(),
          expectedRecipientVersion: 2,
          expectedQuoteVersion: 1,
          withdrawReason: 'Concurrent withdraw attempt',
          now: scenarioA.now,
        });

        const [acceptRes, withdrawRes] = await Promise.allSettled([
          acceptPromise,
          withdrawPromise,
        ]);
        expect(acceptRes.status).toBe('fulfilled');
        expect(withdrawRes.status).toBe('rejected');
        if (withdrawRes.status === 'rejected') {
          expect(withdrawRes.reason).toBeInstanceOf(InvalidStateTransitionError);
        }

        const persistedQuoteA = await db.quote.findUnique({
          where: { id: wA.quoteId },
        });
        expect(persistedQuoteA?.status).toBe('accepted');
        expect(
          await db.allocation.count({ where: { request_id: scenarioA.requestId } }),
        ).toBe(1);
      } finally {
        await cleanupScenario(db, scenarioA);
      }

      // Order B: withdraw locks QuoteRequest first and commits; accept blocks on FOR UPDATE then rejects
      const scenarioB = await seedScenario(db, 1);
      try {
        const wsContract = createPgWorkshopContract(db, txRunner);
        const realQuoteRepo = new PrismaQuoteRepository(txRunner);
        let releaseAcceptB!: () => void;
        const withdrawLockedPromise = new Promise<void>((resolve) => {
          releaseAcceptB = resolve;
        });
        const gatedWithdrawQuoteRepo = Object.assign(
          Object.create(Object.getPrototypeOf(realQuoteRepo)),
          realQuoteRepo,
          {
            update: async (
              ...args: Parameters<PrismaQuoteRepository['update']>
            ) => {
              releaseAcceptB();
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

        const wB = scenarioB.workshops[0];
        const withdrawPromise = withdrawUseCase.execute({
          actor: {
            accountId: wB.artisanId.toString(),
            role: 'artisan',
            workshopId: wB.workshopId.toString(),
            authVersion: 1,
            sessionId: 'sess-artisan-b',
          },
          requestId: scenarioB.requestId.toString(),
          expectedRecipientVersion: 2,
          expectedQuoteVersion: 1,
          withdrawReason: 'Workshop withdrew first',
          now: scenarioB.now,
        });
        withdrawPromise.catch(() => releaseAcceptB());

        await withdrawLockedPromise;
        const acceptPromise = acceptWorkflow.execute({
          actor: {
            accountId: scenarioB.buyerId.toString(),
            role: 'buyer',
            workshopId: null,
            authVersion: 1,
            sessionId: 'sess-buyer-b',
          },
          requestId: scenarioB.requestId.toString(),
          quoteId: wB.quoteId.toString(),
          expectedRequestVersion: 2,
          expectedQuoteVersion: 1,
          idempotencyKey: randomUUID(),
          now: scenarioB.now,
        });

        const [withdrawRes, acceptRes] = await Promise.allSettled([
          withdrawPromise,
          acceptPromise,
        ]);
        expect(withdrawRes.status).toBe('fulfilled');
        expect(acceptRes.status).toBe('rejected');
        if (acceptRes.status === 'rejected') {
          expect(acceptRes.reason).toBeInstanceOf(ConcurrencyConflictError);
        }

        const persistedQuoteB = await db.quote.findUnique({
          where: { id: wB.quoteId },
        });
        expect(persistedQuoteB?.status).toBe('withdrawn');
        expect(
          await db.allocation.count({ where: { request_id: scenarioB.requestId } }),
        ).toBe(0);
      } finally {
        await cleanupScenario(db, scenarioB);
      }
    });

    it('concurrent accept vs Workshop suspension: both orders enforce Workshop FOR UPDATE serialization', async () => {
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

      // Order A: Suspend commits first while accept waits on Workshop FOR UPDATE
      const scenarioA = await seedScenario(db, 1);
      try {
        const wsContract = createPgWorkshopContract(db, txRunner);
        const workflow = new AcceptQuotationWorkflow(
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
        const wA = scenarioA.workshops[0];

        let releaseAccept!: () => void;
        const suspendLockedPromise = new Promise<void>((resolve) => {
          releaseAccept = resolve;
        });

        const suspendPromise = txRunner.run(async (tx) => {
          const client = txRunner.getClient(tx);
          await client.$queryRaw`SELECT "id" FROM "Workshop" WHERE "id" = ${wA.workshopId} FOR UPDATE`;
          releaseAccept();
          await delay(60);
          await client.workshop.update({
            where: { id: wA.workshopId },
            data: { status: 'suspended' },
          });
        });
        suspendPromise.catch(() => releaseAccept());

        await suspendLockedPromise;
        const acceptPromise = workflow.execute({
          actor: {
            accountId: scenarioA.buyerId.toString(),
            role: 'buyer',
            workshopId: null,
            authVersion: 1,
            sessionId: 'sess-susp-a',
          },
          requestId: scenarioA.requestId.toString(),
          quoteId: wA.quoteId.toString(),
          expectedRequestVersion: 2,
          expectedQuoteVersion: 1,
          idempotencyKey: randomUUID(),
          now: scenarioA.now,
        });

        const [suspendRes, acceptRes] = await Promise.allSettled([
          suspendPromise,
          acceptPromise,
        ]);
        expect(suspendRes.status).toBe('fulfilled');
        expect(acceptRes.status).toBe('rejected');
        if (acceptRes.status === 'rejected') {
          expect(acceptRes.reason).toBeInstanceOf(WorkshopSuspended);
        }
        expect(
          await db.allocation.count({ where: { request_id: scenarioA.requestId } }),
        ).toBe(0);
      } finally {
        await cleanupScenario(db, scenarioA);
      }

      // Order B: Accept locks Workshop first and commits; suspend waits on Workshop FOR UPDATE and commits after (Allocation remains intact per BR-05)
      const scenarioB = await seedScenario(db, 1);
      try {
        const wsContract = createPgWorkshopContract(db, txRunner);
        const wB = scenarioB.workshops[0];
        let releaseSuspend!: () => void;
        const acceptLockedWsPromise = new Promise<void>((resolve) => {
          releaseSuspend = resolve;
        });

        const gatedWsContract: IWorkshopContract = {
          ...wsContract,
          async lockAndAssertActive(ids, tx) {
            await wsContract.lockAndAssertActive(ids, tx);
            releaseSuspend();
            await delay(60);
          },
        };

        const workflow = new AcceptQuotationWorkflow(
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

        const acceptPromise = workflow.execute({
          actor: {
            accountId: scenarioB.buyerId.toString(),
            role: 'buyer',
            workshopId: null,
            authVersion: 1,
            sessionId: 'sess-susp-b',
          },
          requestId: scenarioB.requestId.toString(),
          quoteId: wB.quoteId.toString(),
          expectedRequestVersion: 2,
          expectedQuoteVersion: 1,
          idempotencyKey: randomUUID(),
          now: scenarioB.now,
        });
        acceptPromise.catch(() => releaseSuspend());

        await acceptLockedWsPromise;
        const suspendPromise = txRunner.run(async (tx) => {
          const client = txRunner.getClient(tx);
          await client.$queryRaw`SELECT "id" FROM "Workshop" WHERE "id" = ${wB.workshopId} FOR UPDATE`;
          await client.workshop.update({
            where: { id: wB.workshopId },
            data: { status: 'suspended' },
          });
        });

        const [acceptRes, suspendRes] = await Promise.allSettled([
          acceptPromise,
          suspendPromise,
        ]);
        expect(acceptRes.status).toBe('fulfilled');
        expect(suspendRes.status).toBe('fulfilled');
        expect(
          await db.allocation.count({ where: { request_id: scenarioB.requestId } }),
        ).toBe(1);
        const wsAfter = await db.workshop.findUnique({
          where: { id: wB.workshopId },
        });
        expect(wsAfter?.status).toBe('suspended');
      } finally {
        await cleanupScenario(db, scenarioB);
      }
    });

    it('concurrent competing quotes on the same QuoteRequest: exactly 1 succeeds and loser fails with ConcurrencyConflictError', async () => {
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

      const seeded = await seedScenario(db, 2);
      try {
        const wsContract = createPgWorkshopContract(db, txRunner);
        const workflow = new AcceptQuotationWorkflow(
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

        const [res1, res2] = await Promise.allSettled([
          workflow.execute({
            actor: {
              accountId: seeded.buyerId.toString(),
              role: 'buyer',
              workshopId: null,
              authVersion: 1,
              sessionId: 'sess-comp-1',
            },
            requestId: seeded.requestId.toString(),
            quoteId: seeded.workshops[0].quoteId.toString(),
            expectedRequestVersion: 2,
            expectedQuoteVersion: 1,
            idempotencyKey: randomUUID(),
            now: seeded.now,
          }),
          workflow.execute({
            actor: {
              accountId: seeded.buyerId.toString(),
              role: 'buyer',
              workshopId: null,
              authVersion: 1,
              sessionId: 'sess-comp-2',
            },
            requestId: seeded.requestId.toString(),
            quoteId: seeded.workshops[1].quoteId.toString(),
            expectedRequestVersion: 2,
            expectedQuoteVersion: 1,
            idempotencyKey: randomUUID(),
            now: seeded.now,
          }),
        ]);

        const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
        const rejected = [res1, res2].filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
          ConcurrencyConflictError,
        );
        expect(
          await db.allocation.count({ where: { request_id: seeded.requestId } }),
        ).toBe(1);
      } finally {
        await cleanupScenario(db, seeded);
      }
    });

    it('concurrent same-X-Idempotency-Key double-submit race and PG P2002/25P02 recovery return committed replay cleanly', async () => {
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

      // Part A: Barrier after Step 1 findAcceptanceReplay -> both enter prepare/lock concurrently
      const seededA = await seedScenario(db, 1);
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

        let arrived = 0;
        let releaseBoth!: () => void;
        const bothPassedStep1 = new Promise<void>((resolve) => {
          releaseBoth = resolve;
        });
        const barrierService = Object.assign(
          Object.create(Object.getPrototypeOf(realService)),
          realService,
          {
            prepareAcceptance: async (
              ...args: Parameters<TradingAcceptanceService['prepareAcceptance']>
            ) => {
              arrived += 1;
              if (arrived === 2) {
                releaseBoth();
              }
              await bothPassedStep1;
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
        const w = seededA.workshops[0];
        const callInput = {
          actor: {
            accountId: seededA.buyerId.toString(),
            role: 'buyer' as const,
            workshopId: null,
            authVersion: 1,
            sessionId: 'sess-double',
          },
          requestId: seededA.requestId.toString(),
          quoteId: w.quoteId.toString(),
          expectedRequestVersion: 2,
          expectedQuoteVersion: 1,
          idempotencyKey: sharedKey,
          now: seededA.now,
        };

        const [r1, r2] = await Promise.all([
          workflow.execute(callInput),
          workflow.execute(callInput),
        ]);

        expect(r1.data).toEqual(r2.data);
        expect([r1.operation?.replayed, r2.operation?.replayed].sort()).toEqual([
          false,
          true,
        ]);
        expect(
          await db.allocation.count({ where: { request_id: seededA.requestId } }),
        ).toBe(1);
        expect(
          await db.idempotencyRecord.count({
            where: { account_id: seededA.buyerId, idempotency_key: sharedKey },
          }),
        ).toBe(1);
      } finally {
        await cleanupScenario(db, seededA);
      }

      // Part B: Direct real PostgreSQL P2002 -> 25P02 aborted transaction rollback & replay recovery
      const seededB = await seedScenario(db, 1);
      try {
        const wsContract = createPgWorkshopContract(db, txRunner);
        const realIdempRepo = new PrismaIdempotencyRecordRepository(txRunner);
        const w = seededB.workshops[0];
        const sharedKey = randomUUID();
        const expectedSnapshot = {
          request_id: seededB.requestId.toString(),
          request_status: 'buyer_accepted',
          request_version: 3,
          allocations: [],
        };
        const fp = computeCanonicalFingerprint({
          quote_id: w.quoteId.toString(),
          expected_request_version: 2,
          expected_quote_version: 1,
        });

        let injected = false;
        const p2002TriggeringIdempRepo = Object.assign(
          Object.create(Object.getPrototypeOf(realIdempRepo)),
          realIdempRepo,
          {
            save: async (
              ...args: Parameters<PrismaIdempotencyRecordRepository['save']>
            ) => {
              if (!injected) {
                injected = true;
                // Commit an identical IdempotencyRecord from an independent connection so the active tx hits real PG P2002 (23505) + 25P02!
                await db.idempotencyRecord.create({
                  data: {
                    idempotency_key: sharedKey,
                    request_fingerprint: fp,
                    account_id: seededB.buyerId,
                    action: 'accept_quote',
                    object_type: 'QuoteRequest',
                    object_id: seededB.requestId,
                    result_snapshot: expectedSnapshot,
                    created_at: seededB.now,
                    expires_at: new Date(seededB.now.getTime() + 24 * 3600 * 1000),
                  },
                });
              }
              return realIdempRepo.save(...args);
            },
          },
        ) as InstanceType<typeof PrismaIdempotencyRecordRepository>;

        const workflow = new AcceptQuotationWorkflow(
          txRunner,
          new TradingAcceptanceService(
            new PrismaQuoteRequestRepository(txRunner),
            new PrismaRequestRecipientRepository(txRunner),
            new PrismaQuoteRepository(txRunner),
            new PrismaAllocationRepository(txRunner),
            p2002TriggeringIdempRepo,
            wsContract,
          ),
          wsContract,
        );

        const recovered = await workflow.execute({
          actor: {
            accountId: seededB.buyerId.toString(),
            role: 'buyer',
            workshopId: null,
            authVersion: 1,
            sessionId: 'sess-p2002',
          },
          requestId: seededB.requestId.toString(),
          quoteId: w.quoteId.toString(),
          expectedRequestVersion: 2,
          expectedQuoteVersion: 1,
          idempotencyKey: sharedKey,
          now: seededB.now,
        });

        expect(recovered.operation?.replayed).toBe(true);
        expect(recovered.data).toEqual(expectedSnapshot);
        // Confirm the failed tx rolled back its Allocation when P2002 hit
        expect(
          await db.allocation.count({ where: { request_id: seededB.requestId } }),
        ).toBe(0);
      } finally {
        await cleanupScenario(db, seededB);
      }
    });
  },
);
