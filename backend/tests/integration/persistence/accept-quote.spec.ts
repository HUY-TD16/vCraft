import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransactionContext } from '../../../src/common/application/ports/transaction-runner';
import { BusinessRuleException } from '../../../src/common/domain/errors/business-rule.exception';
import type { PrismaService } from '../../../src/infrastructure/database/prisma/prisma.service';
import type { PrismaTransactionRunner } from '../../../src/infrastructure/database/transactions/prisma-transaction-runner';
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
      throw new Error('Not used in accept-quote integration test');
    },
    async changeStatus() {
      throw new Error('Not used in accept-quote integration test');
    },
    async getProfileImageAccess() {
      throw new Error('Not used in accept-quote integration test');
    },
  };
}

describe.skipIf(!testUrl)(
  'Task 23 AcceptQuotationWorkflow on PostgreSQL test schema',
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

    it('creates Allocation with DB-generated BIGSERIAL id and updates Quote/QuoteRequest/logs atomically', async () => {
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
        '../../../src/workflows/accept-quotation/accept-quotation.workflow'
      );

      const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      const buyer = await db.account.create({
        data: {
          username: `buyer_${suffix}`,
          password_hash: 'hash',
          role: 'buyer',
          display_name: 'Buyer Test',
          phone: '0901234567',
        },
      });
      const artisan = await db.account.create({
        data: {
          username: `art_${suffix}`,
          password_hash: 'hash',
          role: 'artisan',
          display_name: 'Artisan Test',
        },
      });
      const workshop = await db.workshop.create({
        data: {
          account_id: artisan.id,
          name: `Workshop ${suffix}`,
          status: 'active',
        },
      });
      const category = await db.category.create({
        data: { name: `Cat ${suffix}` },
      });

      const now = new Date();
      const biddingDeadline = new Date(now.getTime() + 48 * 3600 * 1000);
      const deliveryDeadline = new Date(now.getTime() + 120 * 3600 * 1000);
      const bidAcceptDeadline = new Date(now.getTime() + 72 * 3600 * 1000);
      const committedDelivery = new Date(now.getTime() + 96 * 3600 * 1000);

      const request = await db.quoteRequest.create({
        data: {
          buyer_id: buyer.id,
          category_id: category.id,
          spec: '500 chén trà men ngọc',
          quantity: 500,
          unit: 'piece',
          status: 'artisans_bidding',
          delivery_mode: 'at_buyer_address',
          delivery_region: 'Hà Nội',
          delivery_address: 'Bát Tràng, Gia Lâm',
          recipient_name: 'Buyer Test',
          recipient_phone: '0901234567',
          bidding_deadline: biddingDeadline,
          delivery_deadline: deliveryDeadline,
          version: 2,
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
          unit_price: 45000,
          max_quantity: 500,
          bid_accept_deadline: bidAcceptDeadline,
          committed_delivery_at: committedDelivery,
          status: 'active',
          version: 1,
        },
      });

      const workshopContract = createPgWorkshopContract(db, txRunner);
      const tradingService = new TradingAcceptanceService(
        new PrismaQuoteRequestRepository(txRunner),
        new PrismaRequestRecipientRepository(txRunner),
        new PrismaQuoteRepository(txRunner),
        new PrismaAllocationRepository(txRunner),
        new PrismaIdempotencyRecordRepository(txRunner),
        workshopContract,
      );
      const workflow = new AcceptQuotationWorkflow(
        txRunner,
        tradingService,
        workshopContract,
      );

      const idempotencyKey = randomUUID();
      try {
        const result = await workflow.execute({
          actor: {
            accountId: buyer.id.toString(),
            role: 'buyer',
            workshopId: null,
            authVersion: 1,
            sessionId: 'pg-test-session',
          },
          requestId: request.id.toString(),
          quoteId: quote.id.toString(),
          expectedRequestVersion: 2,
          expectedQuoteVersion: 1,
          idempotencyKey,
          now,
        });

        expect(result.data.request_status).toBe('buyer_accepted');
        expect(result.operation?.replayed).toBe(false);
        expect(result.data.allocations).toHaveLength(1);
        expect(result.data.allocations[0].status).toBe('not_started');
        expect(result.data.allocations[0].workshop).toEqual({
          id: workshop.id.toString(),
          name: workshop.name,
        });

        const persistedRequest = await db.quoteRequest.findUnique({
          where: { id: request.id },
        });
        expect(persistedRequest?.status).toBe('buyer_accepted');
        expect(persistedRequest?.version).toBe(3);
        expect(persistedRequest?.bidding_closed_at?.toISOString()).toBe(
          now.toISOString(),
        );

        const persistedQuote = await db.quote.findUnique({
          where: { id: quote.id },
        });
        expect(persistedQuote?.status).toBe('accepted');
        expect(persistedQuote?.version).toBe(2);

        const persistedAlloc = await db.allocation.findUnique({
          where: { quote_id: quote.id },
        });
        expect(persistedAlloc).not.toBeNull();
        expect(persistedAlloc?.status).toBe('not_started');
        expect(persistedAlloc?.quantity).toBe(500);
        expect(Number(persistedAlloc?.unit_price)).toBe(45000);
        expect(persistedAlloc?.committed_delivery_at.toISOString()).toBe(
          committedDelivery.toISOString(),
        );
        expect(persistedAlloc?.version).toBe(1);
        expect(persistedAlloc?.admin_handed_over).toBe(false);

        const statusLogs = await db.statusLog.findMany({
          where: { request_id: request.id },
          orderBy: { id: 'asc' },
        });
        expect(statusLogs.map((row) => row.event_type)).toEqual([
          'bidding_closed',
          'accepted',
        ]);
        expect(statusLogs[1].prev_status).toBe('artisans_bidding');
        expect(statusLogs[1].new_status).toBe('buyer_accepted');
        expect(statusLogs[1].performed_by).toBe(buyer.id);

        const recipientHistories = await db.recipientResponseHistory.findMany({
          where: { recipient_id: recipient.id },
        });
        expect(recipientHistories).toHaveLength(1);
        expect(recipientHistories[0].event_type).toBe('quote_accepted');
        expect(recipientHistories[0].quote_id).toBe(quote.id);

        const allocationLogs = await db.allocationLog.findMany({
          where: { allocation_id: persistedAlloc!.id },
        });
        expect(allocationLogs).toHaveLength(1);
        expect(allocationLogs[0].event_type).toBe('created');
        expect(allocationLogs[0].prev_status).toBeNull();
        expect(allocationLogs[0].new_status).toBe('not_started');

        const idempotencyRecords = await db.idempotencyRecord.findMany({
          where: {
            account_id: buyer.id,
            action: 'accept_quote',
            object_type: 'QuoteRequest',
            object_id: request.id,
            idempotency_key: idempotencyKey,
          },
        });
        expect(idempotencyRecords).toHaveLength(1);

        // Replay with same key & payload returns cached result with replayed: true
        const replayResult = await workflow.execute({
          actor: {
            accountId: buyer.id.toString(),
            role: 'buyer',
            workshopId: null,
            authVersion: 1,
            sessionId: 'pg-test-session',
          },
          requestId: request.id.toString(),
          quoteId: quote.id.toString(),
          expectedRequestVersion: 2,
          expectedQuoteVersion: 1,
          idempotencyKey,
          now,
        });
        expect(replayResult.operation?.replayed).toBe(true);
        expect(replayResult.data).toEqual(result.data);
        expect(
          await db.allocation.count({ where: { request_id: request.id } }),
        ).toBe(1);

        // Same key with mismatched payload throws 409 IDEMPOTENCY_CONFLICT
        await expect(
          workflow.execute({
            actor: {
              accountId: buyer.id.toString(),
              role: 'buyer',
              workshopId: null,
              authVersion: 1,
              sessionId: 'pg-test-session',
            },
            requestId: request.id.toString(),
            quoteId: quote.id.toString(),
            expectedRequestVersion: 2,
            expectedQuoteVersion: 99,
            idempotencyKey,
            now,
          }),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      } finally {
        await db.allocationLog.deleteMany({
          where: { allocation: { request_id: request.id } },
        });
        await db.allocation.deleteMany({ where: { request_id: request.id } });
        await db.recipientResponseHistory.deleteMany({
          where: { recipient_id: recipient.id },
        });
        await db.statusLog.deleteMany({ where: { request_id: request.id } });
        await db.idempotencyRecord.deleteMany({
          where: { account_id: buyer.id },
        });
        await db.quote.deleteMany({ where: { id: quote.id } });
        await db.requestRecipient.deleteMany({ where: { id: recipient.id } });
        await db.quoteRequest.deleteMany({ where: { id: request.id } });
        await db.category.deleteMany({ where: { id: category.id } });
        await db.workshop.deleteMany({ where: { id: workshop.id } });
        await db.account.deleteMany({
          where: { id: { in: [buyer.id, artisan.id] } },
        });
      }
    });

    it('rejects suspended workshop and rolls back Quote, QuoteRequest, and logs on mid-transaction failure', async () => {
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
        '../../../src/workflows/accept-quotation/accept-quotation.workflow'
      );

      const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      const buyer = await db.account.create({
        data: {
          username: `buyer_rb_${suffix}`,
          password_hash: 'hash',
          role: 'buyer',
          display_name: 'Buyer Rollback Test',
          phone: '0901234567',
        },
      });
      const artisan = await db.account.create({
        data: {
          username: `art_rb_${suffix}`,
          password_hash: 'hash',
          role: 'artisan',
          display_name: 'Artisan Rollback Test',
        },
      });
      const workshop = await db.workshop.create({
        data: {
          account_id: artisan.id,
          name: `Workshop RB ${suffix}`,
          status: 'suspended',
        },
      });
      const category = await db.category.create({
        data: { name: `Cat RB ${suffix}` },
      });

      const now = new Date();
      const request = await db.quoteRequest.create({
        data: {
          buyer_id: buyer.id,
          category_id: category.id,
          spec: '500 chén trà men ngọc',
          quantity: 500,
          unit: 'piece',
          status: 'artisans_bidding',
          delivery_mode: 'at_buyer_address',
          delivery_region: 'Hà Nội',
          delivery_address: 'Bát Tràng, Gia Lâm',
          recipient_name: 'Buyer Rollback Test',
          recipient_phone: '0901234567',
          bidding_deadline: new Date(now.getTime() + 48 * 3600 * 1000),
          delivery_deadline: new Date(now.getTime() + 120 * 3600 * 1000),
          version: 2,
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
          unit_price: 45000,
          max_quantity: 500,
          bid_accept_deadline: new Date(now.getTime() + 72 * 3600 * 1000),
          committed_delivery_at: new Date(now.getTime() + 96 * 3600 * 1000),
          status: 'active',
          version: 1,
        },
      });

      try {
        const workshopContract = createPgWorkshopContract(db, txRunner);
        const realAllocationRepo = new PrismaAllocationRepository(txRunner);
        const tradingService = new TradingAcceptanceService(
          new PrismaQuoteRequestRepository(txRunner),
          new PrismaRequestRecipientRepository(txRunner),
          new PrismaQuoteRepository(txRunner),
          realAllocationRepo,
          new PrismaIdempotencyRecordRepository(txRunner),
          workshopContract,
        );
        const workflow = new AcceptQuotationWorkflow(
          txRunner,
          tradingService,
          workshopContract,
        );

        // 1. Suspended workshop is rejected under Workshop FOR UPDATE lock
        await expect(
          workflow.execute({
            actor: {
              accountId: buyer.id.toString(),
              role: 'buyer',
              workshopId: null,
              authVersion: 1,
              sessionId: 'pg-test-session',
            },
            requestId: request.id.toString(),
            quoteId: quote.id.toString(),
            expectedRequestVersion: 2,
            expectedQuoteVersion: 1,
            idempotencyKey: randomUUID(),
            now,
          }),
        ).rejects.toThrow(WorkshopSuspended);

        // 2. Reactivate workshop, then fail mid-transaction at Allocation creation
        await db.workshop.update({
          where: { id: workshop.id },
          data: { status: 'active' },
        });
        const failingAllocationRepo = Object.assign(
          Object.create(Object.getPrototypeOf(realAllocationRepo)),
          realAllocationRepo,
          {
            create: async () => {
              throw new Error('Simulated mid-transaction PG failure');
            },
          },
        ) as InstanceType<typeof PrismaAllocationRepository>;

        const failingService = new TradingAcceptanceService(
          new PrismaQuoteRequestRepository(txRunner),
          new PrismaRequestRecipientRepository(txRunner),
          new PrismaQuoteRepository(txRunner),
          failingAllocationRepo,
          new PrismaIdempotencyRecordRepository(txRunner),
          workshopContract,
        );
        const failingWorkflow = new AcceptQuotationWorkflow(
          txRunner,
          failingService,
          workshopContract,
        );

        await expect(
          failingWorkflow.execute({
            actor: {
              accountId: buyer.id.toString(),
              role: 'buyer',
              workshopId: null,
              authVersion: 1,
              sessionId: 'pg-test-session',
            },
            requestId: request.id.toString(),
            quoteId: quote.id.toString(),
            expectedRequestVersion: 2,
            expectedQuoteVersion: 1,
            idempotencyKey: randomUUID(),
            now,
          }),
        ).rejects.toThrow('Simulated mid-transaction PG failure');

        // Verify PostgreSQL rolled back Quote, QuoteRequest, and all logs
        const persistedQuote = await db.quote.findUnique({
          where: { id: quote.id },
        });
        expect(persistedQuote?.status).toBe('active');
        expect(persistedQuote?.version).toBe(1);

        const persistedRequest = await db.quoteRequest.findUnique({
          where: { id: request.id },
        });
        expect(persistedRequest?.status).toBe('artisans_bidding');
        expect(persistedRequest?.version).toBe(2);

        const statusLogs = await db.statusLog.findMany({
          where: { request_id: request.id },
        });
        expect(statusLogs).toHaveLength(0);

        const historyRows = await db.recipientResponseHistory.findMany({
          where: { recipient_id: recipient.id },
        });
        expect(historyRows).toHaveLength(0);

        const allocRows = await db.allocation.findMany({
          where: { request_id: request.id },
        });
        expect(allocRows).toHaveLength(0);

        const allocLogs = await db.allocationLog.findMany({
          where: { allocation: { request_id: request.id } },
        });
        expect(allocLogs).toHaveLength(0);

        const idempRows = await db.idempotencyRecord.findMany({
          where: { account_id: buyer.id },
        });
        expect(idempRows).toHaveLength(0);
      } finally {
        await db.allocationLog.deleteMany({
          where: { allocation: { request_id: request.id } },
        });
        await db.allocation.deleteMany({ where: { request_id: request.id } });
        await db.recipientResponseHistory.deleteMany({
          where: { recipient_id: recipient.id },
        });
        await db.statusLog.deleteMany({ where: { request_id: request.id } });
        await db.idempotencyRecord.deleteMany({
          where: { account_id: buyer.id },
        });
        await db.quote.deleteMany({ where: { id: quote.id } });
        await db.requestRecipient.deleteMany({ where: { id: recipient.id } });
        await db.quoteRequest.deleteMany({ where: { id: request.id } });
        await db.category.deleteMany({ where: { id: category.id } });
        await db.workshop.deleteMany({ where: { id: workshop.id } });
        await db.account.deleteMany({
          where: { id: { in: [buyer.id, artisan.id] } },
        });
      }
    });
  },
);
