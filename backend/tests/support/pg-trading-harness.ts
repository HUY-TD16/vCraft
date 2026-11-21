import { randomUUID } from 'node:crypto';
import type { ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../../src/generated/prisma/client';
import type { TransactionContext } from '../../src/common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
} from '../../src/common/application/types/contract-types';
import { BusinessRuleException } from '../../src/common/domain/errors/business-rule.exception';
import { ProblemDetailsFilter } from '../../src/common/http/filters/problem-details.filter';
import { AppLogger } from '../../src/common/observability/app-logger';
import type { PrismaService } from '../../src/infrastructure/database/prisma/prisma.service';
import type { PrismaTransactionRunner } from '../../src/infrastructure/database/transactions/prisma-transaction-runner';
import type { ICatalogContract } from '../../src/modules/catalog/public/contracts/catalog.contract';
import type { ITraceabilityContract } from '../../src/modules/traceability/public/contracts/traceability.contract';
import {
  EntityId,
  type AllocationStatus,
  type RequestStatus,
} from '../../src/modules/trading/domain';
import { WorkshopSuspended } from '../../src/modules/workshops/domain/errors/workshop-suspended';
import type {
  IWorkshopContract,
  WorkshopStatus,
} from '../../src/modules/workshops/public/contracts/workshop.contract';

/**
 * Deferred promise helper for deterministic concurrency/race ordering tests.
 */
export interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Synchronization barrier ensuring `parties` concurrent tasks all reach the same
 * execution checkpoint before continuing into PostgreSQL lock/insert contention.
 */
export function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  const gate = createDeferred<void>();
  return async () => {
    arrived += 1;
    if (arrived >= parties) {
      gate.resolve();
    }
    await gate.promise;
  };
}

/**
 * Captured RFC 9457 HTTP Problem Details response produced by `ProblemDetailsFilter`.
 */
export interface CapturedProblemDetails {
  readonly statusCode: number;
  readonly contentType: string | null;
  readonly headers: Record<string, string>;
  readonly body: {
    readonly type: string;
    readonly title: string;
    readonly status: number;
    readonly detail: string;
    readonly code: string;
    readonly tracking_id: string;
    readonly errors?: ReadonlyArray<{ readonly field: string; readonly message: string }>;
  };
}

/**
 * Runs an actual error through the production `ProblemDetailsFilter` to verify
 * RFC 9457 `application/problem+json` mapping (e.g., HTTP 409 `CONCURRENCY_CONFLICT`
 * / `IDEMPOTENCY_CONFLICT`) without leaking SQL or stack traces (`api-design.md` §1.3 & §2).
 */
export function mapErrorToProblemDetails(error: unknown): CapturedProblemDetails {
  const silentLogger = new AppLogger('info', (_line, done) => done());
  const filter = new ProblemDetailsFilter(silentLogger);

  let statusCode = 200;
  let contentType: string | null = null;
  const headers: Record<string, string> = {};
  let jsonBody: CapturedProblemDetails['body'] | null = null;

  const mockResponse = {
    headersSent: false,
    removeHeader(name: string) {
      delete headers[name.toLowerCase()];
    },
    setHeader(name: string, value: string | number) {
      headers[name.toLowerCase()] = String(value);
    },
    status(code: number) {
      statusCode = code;
      return mockResponse;
    },
    type(mime: string) {
      contentType = mime;
      return mockResponse;
    },
    json(payload: CapturedProblemDetails['body']) {
      jsonBody = payload;
      return mockResponse;
    },
    destroy() {
      // no-op in test capture
    },
  } as unknown as Response;

  const mockHost = {
    switchToHttp: () => ({
      getResponse: () => mockResponse,
    }),
  } as unknown as ArgumentsHost;

  filter.catch(error, mockHost);

  if (!jsonBody) {
    throw new Error('ProblemDetailsFilter did not produce a JSON body.');
  }

  return {
    statusCode,
    contentType,
    headers,
    body: jsonBody,
  };
}

/**
 * PostgreSQL-backed `IWorkshopContract` adapter for real lock-order integration tests:
 * locks `Workshop` rows in ascending `id` order (`SELECT ... FOR UPDATE`), asserts `active`,
 * and supports atomic `changeStatus` with `WorkshopStatusLog` (`BR-05`, `data-design.md` §4.2).
 */
export function createPgWorkshopContract(
  db: PrismaService,
  txRunner: PrismaTransactionRunner,
): IWorkshopContract {
  return {
    async lockAndAssertActive(workshopIds: readonly Id[], tx: TransactionContext) {
      const client = txRunner.getClient(tx);
      const sortedIds = EntityId.sortAscending(Array.from(new Set(workshopIds)));
      for (const workshopId of sortedIds) {
        const rows = await client.$queryRaw<Array<{ id: bigint; status: string }>>(
          Prisma.sql`SELECT "id", "status" FROM "Workshop" WHERE "id" = ${BigInt(workshopId)} FOR UPDATE`,
        );
        if (rows.length === 0) {
          throw new BusinessRuleException('RESOURCE_NOT_FOUND');
        }
        if (rows[0].status !== 'active') {
          throw new WorkshopSuspended();
        }
      }
    },

    async getWorkshopSummary(workshopId: Id) {
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
      throw new Error('createWorkshop is not used in trading concurrency integration tests.');
    },

    async changeStatus(input, tx: TransactionContext) {
      const client = txRunner.getClient(tx);
      const workshopIdBigInt = BigInt(input.workshopId);
      const rows = await client.$queryRaw<Array<{ id: bigint; status: string }>>(
        Prisma.sql`SELECT "id", "status" FROM "Workshop" WHERE "id" = ${workshopIdBigInt} FOR UPDATE`,
      );
      if (rows.length === 0) {
        throw new BusinessRuleException('RESOURCE_NOT_FOUND');
      }
      const prevStatus = rows[0].status as WorkshopStatus;
      if (prevStatus === input.status) {
        return {
          workshopId: input.workshopId,
          status: prevStatus,
          changed: false,
        };
      }

      await client.workshop.update({
        where: { id: workshopIdBigInt },
        data: { status: input.status },
      });

      await client.workshopStatusLog.create({
        data: {
          workshop_id: workshopIdBigInt,
          prev_status: prevStatus,
          new_status: input.status,
          performed_by: BigInt(input.actor.accountId),
          reason: input.reason,
        },
      });

      return {
        workshopId: input.workshopId,
        status: input.status,
        changed: true,
      };
    },

    async getProfileImageAccess() {
      throw new Error('getProfileImageAccess is not used in trading concurrency integration tests.');
    },
  };
}

/**
 * PostgreSQL-backed `ICatalogContract` adapter verifying `active` workshops with
 * at least one `published` product in the requested `category_id` (`BR-13`).
 */
export function createPgCatalogContract(
  txRunner: PrismaTransactionRunner,
): ICatalogContract {
  return {
    async findEligibleWorkshopIds(input, tx: TransactionContext): Promise<Id[]> {
      const client = txRunner.getClient(tx);
      const categoryIdBigInt = BigInt(input.categoryId);
      const category = await client.category.findUnique({
        where: { id: categoryIdBigInt },
      });
      if (!category || !category.is_active) {
        throw new BusinessRuleException('RESOURCE_NOT_FOUND');
      }

      const products = await client.product.findMany({
        where: {
          category_id: categoryIdBigInt,
          status: 'published',
          workshop: { status: 'active' },
        },
        select: { workshop_id: true },
        distinct: ['workshop_id'],
        orderBy: { workshop_id: 'asc' },
      });

      return products.map((p) => p.workshop_id.toString());
    },

    async assertEligibleWorkshops(input, tx: TransactionContext): Promise<void> {
      const eligible = await this.findEligibleWorkshopIds(
        { categoryId: input.categoryId },
        tx,
      );
      const eligibleSet = new Set(eligible);
      if (
        input.workshopIds.length === 0 ||
        input.workshopIds.some((id) => !eligibleSet.has(id))
      ) {
        throw new BusinessRuleException('NO_ELIGIBLE_WORKSHOP');
      }
    },

    async getProductImageAccess() {
      throw new Error('getProductImageAccess is not used in trading concurrency integration tests.');
    },
  };
}

/**
 * PostgreSQL-backed `ITraceabilityContract` adapter verifying batch ownership
 * inside the active transaction (`BR-24`, `docs/contracts/backend.md`).
 */
export function createPgTraceabilityContract(
  txRunner: PrismaTransactionRunner,
): ITraceabilityContract {
  return {
    async assertBatch() {
      throw new Error('assertBatch is not used in trading concurrency integration tests.');
    },

    async assertOwnedBatches(input, tx: TransactionContext) {
      const client = txRunner.getClient(tx);
      const workshopIdBigInt = BigInt(input.workshopId);
      const uniqueIds = Array.from(new Set(input.batchIds)).map((id) => BigInt(id));
      const rows = await client.batch.findMany({
        where: {
          id: { in: uniqueIds },
          workshop_id: workshopIdBigInt,
        },
        orderBy: { id: 'asc' },
      });
      if (rows.length !== uniqueIds.length) {
        throw new BusinessRuleException('RESOURCE_NOT_FOUND');
      }
      return rows.map((row) => ({
        id: row.id.toString(),
        name: row.name,
        status: row.status as 'draft' | 'published',
        traceUrl:
          row.status === 'published'
            ? `/api/v1/trace/${row.qr_token}`
            : null,
      }));
    },

    async getJournalImageAccess() {
      throw new Error('getJournalImageAccess is not used in trading concurrency integration tests.');
    },
  };
}

export interface SeededWorkshopFixture {
  readonly artisanId: bigint;
  readonly workshopId: bigint;
  readonly workshopName: string;
  readonly batchIds: readonly bigint[];
  readonly productId: bigint | null;
  readonly recipientId: bigint | null;
  readonly quoteId: bigint | null;
  readonly allocationId: bigint | null;
  readonly artisanActor: AuthenticatedActor;
}

export interface SeededTradingFixture {
  readonly suffix: string;
  readonly now: Date;
  readonly biddingDeadline: Date;
  readonly deliveryDeadline: Date;
  readonly bidAcceptDeadline: Date;
  readonly committedDeliveryAt: Date;
  readonly buyerId: bigint;
  readonly otherBuyerId: bigint;
  readonly adminId: bigint;
  readonly categoryId: bigint;
  readonly requestId: bigint;
  readonly buyerActor: AuthenticatedActor;
  readonly otherBuyerActor: AuthenticatedActor;
  readonly adminActor: AuthenticatedActor;
  readonly workshops: readonly SeededWorkshopFixture[];
}

export interface SeedTradingFixtureOptions {
  readonly requestStatus?: RequestStatus;
  readonly requestVersion?: number;
  readonly quantity?: number;
  readonly workshopCount?: number;
  readonly workshopInitialStatus?: WorkshopStatus;
  readonly seedRecipients?: boolean;
  readonly recipientResponseStatus?: 'pending' | 'declined' | 'quoted' | 'withdrawn';
  readonly recipientVersion?: number;
  readonly seedQuotes?: boolean;
  readonly quoteStatus?: 'active' | 'withdrawn' | 'accepted';
  readonly quoteVersion?: number;
  readonly seedAllocationForWorkshopIndices?: readonly number[];
  readonly allocationStatus?: AllocationStatus;
  readonly allocationVersion?: number;
  readonly seedPublishedProducts?: boolean;
  readonly batchesPerWorkshop?: number;
}

/**
 * Seeds a completely isolated PostgreSQL test graph with UUID-suffixed unique fields
 * so parallel or repeated integration tests never collide.
 */
export async function seedTradingFixture(
  db: PrismaService,
  options: SeedTradingFixtureOptions = {},
): Promise<SeededTradingFixture> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const now = new Date('2026-11-21T10:00:00.000Z');
  const biddingDeadline = new Date(now.getTime() + 48 * 3600 * 1000);
  const deliveryDeadline = new Date(now.getTime() + 144 * 3600 * 1000);
  const bidAcceptDeadline = new Date(now.getTime() + 72 * 3600 * 1000);
  const committedDeliveryAt = new Date(now.getTime() + 120 * 3600 * 1000);

  const requestStatus = options.requestStatus ?? 'artisans_bidding';
  const requestVersion = options.requestVersion ?? 2;
  const quantity = options.quantity ?? 500;
  const workshopCount = options.workshopCount ?? 1;
  const workshopInitialStatus = options.workshopInitialStatus ?? 'active';
  const seedRecipients =
    options.seedRecipients ?? requestStatus !== 'draft_request';
  const seedQuotes =
    options.seedQuotes ??
    (requestStatus === 'artisans_bidding' ||
      requestStatus === 'buyer_accepted' ||
      requestStatus === 'in_production' ||
      requestStatus === 'delivered');
  const recipientResponseStatus =
    options.recipientResponseStatus ?? (seedQuotes ? 'quoted' : 'pending');
  const recipientVersion = options.recipientVersion ?? (seedQuotes ? 2 : 1);
  const quoteVersion = options.quoteVersion ?? 1;
  const allocationIndices = new Set(
    options.seedAllocationForWorkshopIndices ??
      (requestStatus === 'buyer_accepted' ||
      requestStatus === 'in_production' ||
      requestStatus === 'delivered'
        ? [0]
        : []),
  );
  const allocationStatus =
    options.allocationStatus ??
    (requestStatus === 'in_production'
      ? 'in_production'
      : requestStatus === 'delivered'
        ? 'handed_over'
        : 'not_started');
  const allocationVersion = options.allocationVersion ?? 1;
  const batchesPerWorkshop =
    options.batchesPerWorkshop ?? (options.seedPublishedProducts ? 1 : 0);

  const buyer = await db.account.create({
    data: {
      username: `buy_t40_${suffix}`,
      password_hash: 'hash',
      role: 'buyer',
      display_name: 'Buyer Task40',
      phone: '0901234567',
    },
  });

  const otherBuyer = await db.account.create({
    data: {
      username: `obuy_t40_${suffix}`,
      password_hash: 'hash',
      role: 'buyer',
      display_name: 'Other Buyer Task40',
      phone: '0907654321',
    },
  });

  const admin = await db.account.create({
    data: {
      username: `adm_t40_${suffix}`,
      password_hash: 'hash',
      role: 'admin',
      display_name: 'Admin BQL Task40',
    },
  });

  const category = await db.category.create({
    data: {
      name: `Cat_T40_${suffix}`,
      is_active: true,
    },
  });

  const request = await db.quoteRequest.create({
    data: {
      buyer_id: buyer.id,
      category_id: category.id,
      spec: '500 chén trà gốm Bát Tràng men ngọc cổ',
      quantity,
      unit: 'piece',
      status: requestStatus,
      delivery_mode: 'at_buyer_address',
      delivery_region: 'Huyện Gia Lâm, TP. Hà Nội',
      delivery_address: 'Thôn 1 Làng Cổ Bát Tràng, Gia Lâm, Hà Nội',
      recipient_name: 'Nguyễn Văn Nhận',
      recipient_phone: '0901234567',
      bidding_deadline: biddingDeadline,
      delivery_deadline: deliveryDeadline,
      bidding_closed_at:
        requestStatus === 'buyer_accepted' ||
        requestStatus === 'in_production' ||
        requestStatus === 'delivered'
          ? now
          : null,
      version: requestVersion,
    },
  });

  const workshops: SeededWorkshopFixture[] = [];

  for (let i = 0; i < workshopCount; i++) {
    const artisan = await db.account.create({
      data: {
        username: `art_${i}_${suffix}`,
        password_hash: 'hash',
        role: 'artisan',
        display_name: `Artisan ${i} Task40`,
      },
    });

    const workshopName = `Xưởng Gốm ${i} ${suffix}`;
    const workshop = await db.workshop.create({
      data: {
        account_id: artisan.id,
        name: workshopName,
        status: workshopInitialStatus,
      },
    });

    const batchIds: bigint[] = [];
    for (let b = 0; b < batchesPerWorkshop; b++) {
      const batch = await db.batch.create({
        data: {
          workshop_id: workshop.id,
          name: `Lô ${i}-${b} ${suffix}`,
          qr_token: `qr_${i}_${b}_${randomUUID().replaceAll('-', '')}`,
          status: 'published',
          published_at: now,
        },
      });
      batchIds.push(batch.id);
    }

    let productId: bigint | null = null;
    if (options.seedPublishedProducts) {
      const batchForProduct = batchIds[0];
      const product = await db.product.create({
        data: {
          workshop_id: workshop.id,
          batch_id: batchForProduct,
          category_id: category.id,
          name: `Sản phẩm ${i} ${suffix}`,
          price: 120000,
          status: 'published',
          published_at: now,
        },
      });
      productId = product.id;
    }

    let recipientId: bigint | null = null;
    if (seedRecipients) {
      const recipient = await db.requestRecipient.create({
        data: {
          request_id: request.id,
          workshop_id: workshop.id,
          response_status: recipientResponseStatus,
          responded_by: recipientResponseStatus === 'pending' ? null : artisan.id,
          responded_at: recipientResponseStatus === 'pending' ? null : now,
          sent_at: now,
          version: recipientVersion,
        },
      });
      recipientId = recipient.id;
    }

    let quoteId: bigint | null = null;
    if (seedQuotes && recipientId !== null) {
      const isAllocated = allocationIndices.has(i);
      const quoteStatus =
        options.quoteStatus ?? (isAllocated ? 'accepted' : 'active');
      const quote = await db.quote.create({
        data: {
          request_id: request.id,
          workshop_id: workshop.id,
          unit_price: 45000 + i * 2000,
          max_quantity: quantity,
          bid_accept_deadline: bidAcceptDeadline,
          committed_delivery_at: committedDeliveryAt,
          status: quoteStatus,
          version: quoteVersion,
          withdraw_reason:
            quoteStatus === 'withdrawn' ? 'Seeded withdrawn reason' : null,
          withdrawn_by: quoteStatus === 'withdrawn' ? artisan.id : null,
          withdrawn_at: quoteStatus === 'withdrawn' ? now : null,
        },
      });
      quoteId = quote.id;
    }

    let allocationId: bigint | null = null;
    if (allocationIndices.has(i) && quoteId !== null) {
      const allocation = await db.allocation.create({
        data: {
          request_id: request.id,
          workshop_id: workshop.id,
          quote_id: quoteId,
          quantity,
          unit_price: 45000 + i * 2000,
          committed_delivery_at: committedDeliveryAt,
          status: allocationStatus,
          version: allocationVersion,
          started_at:
            allocationStatus === 'in_production' ||
            allocationStatus === 'handed_over'
              ? now
              : null,
          started_by:
            allocationStatus === 'in_production' ||
            allocationStatus === 'handed_over'
              ? artisan.id
              : null,
          handed_over_at: allocationStatus === 'handed_over' ? now : null,
          handed_over_by: allocationStatus === 'handed_over' ? artisan.id : null,
          delivery_note:
            allocationStatus === 'handed_over'
              ? 'Đã bàn giao đủ số lượng'
              : null,
          admin_handed_over: false,
        },
      });
      allocationId = allocation.id;
    }

    workshops.push({
      artisanId: artisan.id,
      workshopId: workshop.id,
      workshopName,
      batchIds,
      productId,
      recipientId,
      quoteId,
      allocationId,
      artisanActor: Object.freeze({
        accountId: artisan.id.toString(),
        role: 'artisan',
        workshopId: workshop.id.toString(),
        authVersion: 1,
        sessionId: `sess-art-${i}-${suffix}`,
        sessionLevel: 'normal',
      }),
    });
  }

  return {
    suffix,
    now,
    biddingDeadline,
    deliveryDeadline,
    bidAcceptDeadline,
    committedDeliveryAt,
    buyerId: buyer.id,
    otherBuyerId: otherBuyer.id,
    adminId: admin.id,
    categoryId: category.id,
    requestId: request.id,
    buyerActor: Object.freeze({
      accountId: buyer.id.toString(),
      role: 'buyer',
      workshopId: null,
      authVersion: 1,
      sessionId: `sess-buy-${suffix}`,
      sessionLevel: 'normal',
    }),
    otherBuyerActor: Object.freeze({
      accountId: otherBuyer.id.toString(),
      role: 'buyer',
      workshopId: null,
      authVersion: 1,
      sessionId: `sess-obuy-${suffix}`,
      sessionLevel: 'normal',
    }),
    adminActor: Object.freeze({
      accountId: admin.id.toString(),
      role: 'admin',
      workshopId: null,
      authVersion: 1,
      sessionId: `sess-adm-${suffix}`,
      sessionLevel: 'normal',
    }),
    workshops,
  };
}

/**
 * Deletes every record created by `seedTradingFixture` and any child audit/history
 * rows produced during the test, honoring PostgreSQL `ON DELETE RESTRICT` FK order.
 */
export async function cleanupTradingFixture(
  db: PrismaService,
  fixture: SeededTradingFixture,
): Promise<void> {
  const accountIds = [
    fixture.buyerId,
    fixture.otherBuyerId,
    fixture.adminId,
    ...fixture.workshops.map((w) => w.artisanId),
  ];
  const workshopIds = fixture.workshops.map((w) => w.workshopId);

  await db.allocationBatch.deleteMany({
    where: { allocation: { request_id: fixture.requestId } },
  });
  await db.allocationLog.deleteMany({
    where: { allocation: { request_id: fixture.requestId } },
  });
  await db.allocation.deleteMany({
    where: { request_id: fixture.requestId },
  });
  await db.recipientResponseHistory.deleteMany({
    where: { recipient: { request_id: fixture.requestId } },
  });
  await db.quote.deleteMany({
    where: { request_id: fixture.requestId },
  });
  await db.requestRecipient.deleteMany({
    where: { request_id: fixture.requestId },
  });
  await db.contactEditHistory.deleteMany({
    where: { request_id: fixture.requestId },
  });
  await db.statusLog.deleteMany({
    where: { request_id: fixture.requestId },
  });
  await db.idempotencyRecord.deleteMany({
    where: { account_id: { in: accountIds } },
  });
  await db.quoteRequest.deleteMany({
    where: { id: fixture.requestId },
  });
  await db.product.deleteMany({
    where: { workshop_id: { in: workshopIds } },
  });
  await db.batch.deleteMany({
    where: { workshop_id: { in: workshopIds } },
  });
  await db.workshopStatusLog.deleteMany({
    where: { workshop_id: { in: workshopIds } },
  });
  await db.workshop.deleteMany({
    where: { id: { in: workshopIds } },
  });
  await db.category.deleteMany({
    where: { id: fixture.categoryId },
  });
  await db.account.deleteMany({
    where: { id: { in: accountIds } },
  });
}
