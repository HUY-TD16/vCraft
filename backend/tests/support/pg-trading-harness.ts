import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ArgumentsHost, CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { from } from 'rxjs';
import { expect } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client';
import type { TransactionContext } from '../../src/common/application/ports/transaction-runner';
import type { AuthenticatedActor, Id } from '../../src/common/application/types/contract-types';
import { BusinessRuleException } from '../../src/common/domain/errors/business-rule.exception';
import { ProblemDetailsFilter } from '../../src/common/http/filters/problem-details.filter';
import type { HttpResult } from '../../src/common/http/interceptors/response-envelope.interceptor';
import { AppLogger } from '../../src/common/observability/app-logger';
import { authenticatedActors } from '../../src/common/security/guards/authenticated-request';
import type { PrismaService } from '../../src/infrastructure/database/prisma/prisma.service';
import type { PrismaTransactionRunner } from '../../src/infrastructure/database/transactions/prisma-transaction-runner';
import {
  TRADING_MUTATION_METADATA_KEY,
  TRADING_TX_REQUEST_KEY,
  TradingCurrentStateResolver,
  TradingMutationInterceptor,
  type TradingMutationOptions,
} from '../../src/modules/trading/adapters/http';
import { EntityId, type AllocationStatus, type RequestStatus } from '../../src/modules/trading/domain';
import { WorkshopSuspended } from '../../src/modules/workshops/domain/errors/workshop-suspended';
import type { IWorkshopContract, WorkshopStatus } from '../../src/modules/workshops/public/contracts/workshop.contract';

export interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

export function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  const gate = createDeferred<void>();
  return async () => {
    if (++arrived >= parties) gate.resolve();
    await gate.promise;
  };
}

/** Wraps a method to resolve `gate` and pause `holdMs` for deterministic lock-ordering tests. */
export function gateMethod<T extends object, K extends keyof T>(
  target: T,
  method: K,
  gate: Deferred<void>,
  holdMs = 60,
): T {
  const original = target[method] as (...args: unknown[]) => Promise<unknown>;
  return Object.assign(Object.create(Object.getPrototypeOf(target)), target, {
    [method]: async (...args: unknown[]) => {
      gate.resolve();
      await delay(holdMs);
      return original.apply(target, args);
    },
  }) as T;
}

/** Runs `first` until `gate` resolves, then starts `second` concurrently and returns both settled outcomes. */
export async function runGatedRace<A, B>(
  gate: Deferred<void>,
  first: Promise<A>,
  startSecond: () => Promise<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  first.catch(() => gate.resolve());
  await gate.promise;
  return Promise.allSettled([first, startSecond()]);
}

export interface CapturedProblemDetails {
  readonly statusCode: number;
  readonly contentType: string | null;
  readonly body: {
    readonly type: string;
    readonly title: string;
    readonly status: number;
    readonly detail: string;
    readonly code: string;
    readonly tracking_id: string;
  };
}

/** Runs an error through production `ProblemDetailsFilter` (RFC 9457, SEC-06). */
export function mapErrorToProblemDetails(error: unknown): CapturedProblemDetails {
  const filter = new ProblemDetailsFilter(new AppLogger('info', (_line, done) => done()));
  let statusCode = 200;
  let contentType: string | null = null;
  let jsonBody: CapturedProblemDetails['body'] | null = null;
  const mockRes = {
    headersSent: false,
    removeHeader: () => undefined,
    setHeader: () => undefined,
    status: (code: number) => ((statusCode = code), mockRes),
    type: (mime: string) => ((contentType = mime), mockRes),
    json: (payload: CapturedProblemDetails['body']) => ((jsonBody = payload), mockRes),
    destroy: () => undefined,
  } as unknown as Response;

  filter.catch(error, { switchToHttp: () => ({ getResponse: () => mockRes }) } as unknown as ArgumentsHost);
  if (!jsonBody) throw new Error('ProblemDetailsFilter did not produce a JSON body.');
  return { statusCode, contentType, body: jsonBody };
}

export function expectHttpProblem(error: unknown, expectedStatus: number, expectedCode: string): void {
  const { statusCode, contentType, body } = mapErrorToProblemDetails(error);
  expect(statusCode).toBe(expectedStatus);
  expect(contentType).toBe('application/problem+json');
  expect(body).toMatchObject({ status: expectedStatus, code: expectedCode, type: `urn:vcraft:problem:${expectedCode}` });
  expect(body.tracking_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  expect(body.detail).not.toMatch(/SELECT|INSERT|UPDATE|Prisma|stack/i);
}

export async function expectRejectsProblem(
  promise: Promise<unknown>,
  expectedStatus: number,
  expectedCode: string,
): Promise<unknown> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expectHttpProblem(caught, expectedStatus, expectedCode);
  return caught;
}

export interface PgTestContext {
  readonly db: PrismaService;
  readonly txRunner: PrismaTransactionRunner;
  readonly close: () => Promise<void>;
}

export async function createPgTestContext(testUrl: string): Promise<PgTestContext> {
  const [{ PrismaService }, { PrismaTransactionRunner }] = await Promise.all([
    import('../../src/infrastructure/database/prisma/prisma.service'),
    import('../../src/infrastructure/database/transactions/prisma-transaction-runner'),
  ]);
  const db = new PrismaService({ DATABASE_URL: testUrl });
  return { db, txRunner: new PrismaTransactionRunner(db), close: () => db.$disconnect() };
}

/** PostgreSQL-backed `IWorkshopContract` locking `Workshop` rows ascending (`BR-05`). */
export function createPgWorkshopContract(
  db: PrismaService,
  txRunner: PrismaTransactionRunner,
): IWorkshopContract {
  const lockRow = async (id: bigint, tx: TransactionContext) => {
    const rows = await txRunner.getClient(tx).$queryRaw<Array<{ id: bigint; status: string }>>(
      Prisma.sql`SELECT "id", "status" FROM "Workshop" WHERE "id" = ${id} FOR UPDATE`,
    );
    if (rows.length === 0) throw new BusinessRuleException('RESOURCE_NOT_FOUND');
    return rows[0];
  };
  return {
    async lockAndAssertActive(workshopIds: readonly Id[], tx: TransactionContext) {
      for (const id of EntityId.sortAscending(Array.from(new Set(workshopIds)))) {
        if ((await lockRow(BigInt(id), tx)).status !== 'active') throw new WorkshopSuspended();
      }
    },
    async getWorkshopSummary(workshopId: Id) {
      const row = await db.workshop.findUnique({ where: { id: BigInt(workshopId) } });
      return row ? { id: row.id.toString(), name: row.name, status: row.status as WorkshopStatus, isProfilePublic: true } : null;
    },
    async createWorkshop() {
      throw new Error('Not used in trading integration tests.');
    },
    async changeStatus(input, tx: TransactionContext) {
      const id = BigInt(input.workshopId);
      const prevStatus = (await lockRow(id, tx)).status as WorkshopStatus;
      if (prevStatus === input.status) return { workshopId: input.workshopId, status: prevStatus, changed: false };
      const client = txRunner.getClient(tx);
      await client.workshop.update({ where: { id }, data: { status: input.status } });
      await client.workshopStatusLog.create({
        data: { workshop_id: id, prev_status: prevStatus, new_status: input.status, performed_by: BigInt(input.actor.accountId), reason: input.reason },
      });
      return { workshopId: input.workshopId, status: input.status, changed: true };
    },
    async getProfileImageAccess() {
      throw new Error('Not used in trading integration tests.');
    },
  };
}

/** Wires shared PostgreSQL repositories, services, workflows, and main Trading use cases. */
export async function createPgTradingStack(
  db: PrismaService,
  txRunner: PrismaTransactionRunner,
  overrides: {
    workshopContract?: IWorkshopContract;
    quoteRequestRepo?: unknown;
    quoteRepo?: unknown;
    allocationRepo?: unknown;
    idempotencyRepo?: unknown;
  } = {},
) {
  const [reposMod, servicesMod, useCasesMod, workflowMod] = await Promise.all([
    import('../../src/modules/trading/adapters/persistence/repositories'),
    import('../../src/modules/trading/application/services'),
    import('../../src/modules/trading/application/use-cases'),
    import('../../src/workflows/accept-quotation'),
  ]);

  const wsContract = overrides.workshopContract ?? createPgWorkshopContract(db, txRunner);
  const quoteRequestRepo = (overrides.quoteRequestRepo as InstanceType<typeof reposMod.PrismaQuoteRequestRepository>) ?? new reposMod.PrismaQuoteRequestRepository(txRunner);
  const recipientRepo = new reposMod.PrismaRequestRecipientRepository(txRunner);
  const quoteRepo = (overrides.quoteRepo as InstanceType<typeof reposMod.PrismaQuoteRepository>) ?? new reposMod.PrismaQuoteRepository(txRunner);
  const allocationRepo = (overrides.allocationRepo as InstanceType<typeof reposMod.PrismaAllocationRepository>) ?? new reposMod.PrismaAllocationRepository(txRunner);
  const idempotencyRepo = (overrides.idempotencyRepo as InstanceType<typeof reposMod.PrismaIdempotencyRecordRepository>) ?? new reposMod.PrismaIdempotencyRecordRepository(txRunner);

  const acceptanceService = new servicesMod.TradingAcceptanceService(quoteRequestRepo, recipientRepo, quoteRepo, allocationRepo, idempotencyRepo, wsContract);
  const acceptWorkflow = new workflowMod.AcceptQuotationWorkflow(txRunner, acceptanceService, wsContract);
  const idempotencyService = new servicesMod.TradingIdempotencyService(idempotencyRepo, txRunner);
  const stateResolver = new TradingCurrentStateResolver(quoteRequestRepo, allocationRepo, quoteRepo, recipientRepo);
  const interceptor = new TradingMutationInterceptor(new Reflector(), idempotencyService, stateResolver);

  return {
    wsContract,
    repos: { quoteRequestRepo, recipientRepo, quoteRepo, allocationRepo, idempotencyRepo },
    acceptanceService,
    acceptWorkflow,
    idempotencyService,
    interceptor,
    createCleanupService: (nowFn: () => Date) => new servicesMod.IdempotencyCleanupService(idempotencyRepo, txRunner, nowFn),
    useCases: {
      updateContact: new useCasesMod.UpdateRecipientContactUseCase(txRunner, quoteRequestRepo),
      decline: new useCasesMod.DeclineQuoteRequestUseCase(txRunner, quoteRequestRepo, recipientRepo, quoteRepo, wsContract),
      withdraw: new useCasesMod.WithdrawQuoteUseCase(txRunner, quoteRequestRepo, recipientRepo, quoteRepo, wsContract),
      startProduction: new useCasesMod.StartAllocationProductionUseCase(txRunner, allocationRepo, quoteRequestRepo, wsContract),
      confirmDelivery: new useCasesMod.ConfirmDeliveryUseCase(txRunner, quoteRequestRepo, allocationRepo),
      adminCancel: new useCasesMod.CancelQuoteRequestByAdminUseCase(txRunner, quoteRequestRepo),
    },
  };
}

/** Invokes production `TradingMutationInterceptor` directly with a synthetic HTTP context. */
export async function invokeThroughTradingInterceptor<TData>(params: {
  readonly interceptor: TradingMutationInterceptor;
  readonly options: TradingMutationOptions;
  readonly actor: AuthenticatedActor;
  readonly objectId: string;
  readonly idempotencyKey: string;
  readonly body: Record<string, unknown>;
  readonly handler: (tx: TransactionContext) => Promise<{ readonly data: TData; readonly currentState: unknown }>;
}): Promise<HttpResult<TData, unknown>> {
  const req: Record<PropertyKey, unknown> = {
    headers: { 'x-idempotency-key': params.idempotencyKey },
    params: { id: params.objectId },
    body: params.body,
    get: (name: string) => (name.toLowerCase() === 'x-idempotency-key' ? params.idempotencyKey : undefined),
  };
  authenticatedActors.set(req as never, params.actor);

  const res = { statusCode: 200, headersSent: false, status: (code: number) => ((res.statusCode = code), res) };
  const handlerFn = () => undefined;
  class SyntheticController {}
  Reflect.defineMetadata(TRADING_MUTATION_METADATA_KEY, params.options, handlerFn);

  const ctx = {
    getHandler: () => handlerFn,
    getClass: () => SyntheticController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;

  const next: CallHandler = {
    handle: () =>
      from(
        Promise.resolve().then(() => {
          const tx = req[TRADING_TX_REQUEST_KEY] as TransactionContext | undefined;
          if (!tx) throw new Error('Expected active TransactionContext on request.');
          return params.handler(tx);
        }),
      ),
  };

  const obs$ = await params.interceptor.intercept(ctx, next);
  return new Promise<HttpResult<TData, unknown>>((resolve, reject) => {
    let emitted: HttpResult<TData, unknown> | undefined;
    obs$.subscribe({
      next: (val) => {
        emitted = val as HttpResult<TData, unknown>;
      },
      error: reject,
      complete: () => (emitted ? resolve(emitted) : reject(new Error('Interceptor completed without emitting.'))),
    });
  });
}

export interface SeededWorkshopFixture {
  readonly artisanId: bigint;
  readonly workshopId: bigint;
  readonly workshopName: string;
  readonly recipientId: bigint | null;
  readonly quoteId: bigint | null;
  readonly allocationId: bigint | null;
  readonly artisanActor: AuthenticatedActor;
}

export interface SeededTradingFixture {
  readonly suffix: string;
  readonly now: Date;
  readonly buyerId: bigint;
  readonly adminId: bigint;
  readonly categoryId: bigint;
  readonly requestId: bigint;
  readonly buyerActor: AuthenticatedActor;
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
  readonly quoteVersion?: number;
  readonly allocationStatus?: AllocationStatus;
  readonly allocationVersion?: number;
}

const makeActor = (accountId: bigint, role: AuthenticatedActor['role'], sessionId: string, workshopId: bigint | null = null): AuthenticatedActor =>
  Object.freeze({ accountId: accountId.toString(), role, workshopId: workshopId?.toString() ?? null, authVersion: 1, sessionId, sessionLevel: 'normal' });

/** Builds standard `AcceptQuotationWorkflow.execute` input for a seeded fixture. */
export function acceptInputFor(
  f: SeededTradingFixture,
  overrides: { workshopIndex?: number; idempotencyKey?: string; expectedRequestVersion?: number; expectedQuoteVersion?: number; now?: Date } = {},
) {
  const w = f.workshops[overrides.workshopIndex ?? 0];
  return {
    actor: f.buyerActor,
    requestId: f.requestId.toString(),
    quoteId: w.quoteId!.toString(),
    expectedRequestVersion: overrides.expectedRequestVersion ?? 2,
    expectedQuoteVersion: overrides.expectedQuoteVersion ?? 1,
    idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
    now: overrides.now ?? f.now,
  };
}

/** Seeds an isolated UUID-suffixed PostgreSQL trading fixture. */
export async function seedTradingFixture(
  db: PrismaService,
  options: SeedTradingFixtureOptions = {},
): Promise<SeededTradingFixture> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const now = new Date('2026-11-21T10:00:00.000Z');
  const h = 3600 * 1000;
  const requestStatus = options.requestStatus ?? 'artisans_bidding';
  const requestVersion = options.requestVersion ?? 2;
  const quantity = options.quantity ?? 500;
  const workshopCount = options.workshopCount ?? 1;
  const isPostAccept = requestStatus === 'buyer_accepted' || requestStatus === 'in_production' || requestStatus === 'delivered';
  const seedRecipients = options.seedRecipients ?? requestStatus !== 'draft_request';
  const seedQuotes = options.seedQuotes ?? (requestStatus === 'artisans_bidding' || isPostAccept);
  const recipientResponseStatus = options.recipientResponseStatus ?? (seedQuotes ? 'quoted' : 'pending');
  const recipientVersion = options.recipientVersion ?? (seedQuotes ? 2 : 1);
  const allocationStatus = options.allocationStatus ?? (requestStatus === 'in_production' ? 'in_production' : requestStatus === 'delivered' ? 'handed_over' : 'not_started');

  const [buyer, admin, category] = await Promise.all([
    db.account.create({ data: { username: `buy_${suffix}`, password_hash: 'hash', role: 'buyer', display_name: 'Buyer Test', phone: '0901234567' } }),
    db.account.create({ data: { username: `adm_${suffix}`, password_hash: 'hash', role: 'admin', display_name: 'Admin Test' } }),
    db.category.create({ data: { name: `Cat_${suffix}`, is_active: true } }),
  ]);

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
      bidding_deadline: new Date(now.getTime() + 48 * h),
      delivery_deadline: new Date(now.getTime() + 144 * h),
      bidding_closed_at: isPostAccept ? now : null,
      version: requestVersion,
    },
  });

  const committedDeliveryAt = new Date(now.getTime() + 120 * h);
  const workshops: SeededWorkshopFixture[] = [];
  for (let i = 0; i < workshopCount; i++) {
    const artisan = await db.account.create({ data: { username: `art_${i}_${suffix}`, password_hash: 'hash', role: 'artisan', display_name: `Artisan ${i}` } });
    const workshopName = `Xưởng Gốm ${i} ${suffix}`;
    const workshop = await db.workshop.create({ data: { account_id: artisan.id, name: workshopName, status: options.workshopInitialStatus ?? 'active' } });
    const recipient = seedRecipients
      ? await db.requestRecipient.create({
          data: {
            request_id: request.id,
            workshop_id: workshop.id,
            response_status: recipientResponseStatus,
            responded_by: recipientResponseStatus === 'pending' ? null : artisan.id,
            responded_at: recipientResponseStatus === 'pending' ? null : now,
            sent_at: now,
            version: recipientVersion,
          },
        })
      : null;

    const shouldAllocate = isPostAccept && i === 0;
    const quote =
      seedQuotes && recipient
        ? await db.quote.create({
            data: {
              request_id: request.id,
              workshop_id: workshop.id,
              unit_price: 45000 + i * 2000,
              max_quantity: quantity,
              bid_accept_deadline: new Date(now.getTime() + 72 * h),
              committed_delivery_at: committedDeliveryAt,
              status: shouldAllocate ? 'accepted' : 'active',
              version: options.quoteVersion ?? 1,
            },
          })
        : null;

    const allocation =
      shouldAllocate && quote
        ? await db.allocation.create({
            data: {
              request_id: request.id,
              workshop_id: workshop.id,
              quote_id: quote.id,
              quantity,
              unit_price: 45000 + i * 2000,
              committed_delivery_at: committedDeliveryAt,
              status: allocationStatus,
              version: options.allocationVersion ?? 1,
              started_at: allocationStatus !== 'not_started' ? now : null,
              started_by: allocationStatus !== 'not_started' ? artisan.id : null,
              handed_over_at: allocationStatus === 'handed_over' ? now : null,
              handed_over_by: allocationStatus === 'handed_over' ? artisan.id : null,
              delivery_note: allocationStatus === 'handed_over' ? 'Đã bàn giao đủ số lượng' : null,
              admin_handed_over: false,
            },
          })
        : null;

    workshops.push({
      artisanId: artisan.id,
      workshopId: workshop.id,
      workshopName,
      recipientId: recipient?.id ?? null,
      quoteId: quote?.id ?? null,
      allocationId: allocation?.id ?? null,
      artisanActor: makeActor(artisan.id, 'artisan', `sess-art-${i}-${suffix}`, workshop.id),
    });
  }

  return {
    suffix,
    now,
    buyerId: buyer.id,
    adminId: admin.id,
    categoryId: category.id,
    requestId: request.id,
    buyerActor: makeActor(buyer.id, 'buyer', `sess-buy-${suffix}`),
    adminActor: makeActor(admin.id, 'admin', `sess-adm-${suffix}`),
    workshops,
  };
}

/** Deletes all rows created by `seedTradingFixture` in FK-safe order. */
export async function cleanupTradingFixture(db: PrismaService, f: SeededTradingFixture): Promise<void> {
  const accountIds = [f.buyerId, f.adminId, ...f.workshops.map((w) => w.artisanId)];
  const workshopIds = f.workshops.map((w) => w.workshopId);
  await db.allocationBatch.deleteMany({ where: { allocation: { request_id: f.requestId } } });
  await db.allocationLog.deleteMany({ where: { allocation: { request_id: f.requestId } } });
  await db.allocation.deleteMany({ where: { request_id: f.requestId } });
  await db.recipientResponseHistory.deleteMany({ where: { recipient: { request_id: f.requestId } } });
  await db.quote.deleteMany({ where: { request_id: f.requestId } });
  await db.requestRecipient.deleteMany({ where: { request_id: f.requestId } });
  await db.contactEditHistory.deleteMany({ where: { request_id: f.requestId } });
  await db.statusLog.deleteMany({ where: { request_id: f.requestId } });
  await db.idempotencyRecord.deleteMany({ where: { account_id: { in: accountIds } } });
  await db.quoteRequest.deleteMany({ where: { id: f.requestId } });
  await db.workshopStatusLog.deleteMany({ where: { workshop_id: { in: workshopIds } } });
  await db.workshop.deleteMany({ where: { id: { in: workshopIds } } });
  await db.category.deleteMany({ where: { id: f.categoryId } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

export async function withSeededFixture<T>(
  db: PrismaService,
  options: SeedTradingFixtureOptions,
  fn: (fixture: SeededTradingFixture) => Promise<T>,
): Promise<T> {
  const fixture = await seedTradingFixture(db, options);
  try {
    return await fn(fixture);
  } finally {
    await cleanupTradingFixture(db, fixture);
  }
}
