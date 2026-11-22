import { NestFactory, Reflector } from '@nestjs/core';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransactionContext } from '../../../../src/common/application/ports/transaction-runner';
import { readConfig } from '../../../../src/common/config/app-config';
import { AppLogger } from '../../../../src/common/observability/app-logger';
import { createApiDocument } from '../../../../src/common/http/swagger/configure-swagger';
import { authenticatedActors } from '../../../../src/common/security/guards/authenticated-request';
import { AppModule } from '../../../../src/bootstrap/app.module';
import { configureHttp } from '../../../../src/bootstrap/configure-http';
import { PrismaService } from '../../../../src/infrastructure/database/prisma/prisma.service';
import {
  TRADING_MUTATION_METADATA_KEY,
  TRADING_TX_REQUEST_KEY,
  TradingCurrentStateResolver,
  TradingMutationInterceptor,
  type TradingMutationOptions,
} from '../../../../src/modules/trading/adapters/http';
import { IdempotencyCleanupScheduler } from '../../../../src/modules/trading/adapters/jobs/idempotency-cleanup.scheduler';
import {
  IdempotencyCleanupService,
  TradingIdempotencyService,
} from '../../../../src/modules/trading/application/services';
import {
  IdempotencyConflictError,
  InvalidTradingInputError,
} from '../../../../src/modules/trading/domain';
import {
  computeCanonicalFingerprint,
  normalizeUuidV4,
  validateUuidV4,
} from '../../../../src/modules/trading/domain/utilities';
import {
  BUYER,
  NOW,
  VALID_UUID,
  createTradingTestDeps,
  makeAllocation,
  makeQuote,
  makeRecipient,
  makeRequest,
} from '../../../support/trading-unit-harness';

describe('Trading Idempotency, Interceptor, CurrentState, Cleanup & OpenAPI Contract', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('validates UUID v4 and computes key-order-invariant canonical SHA-256 fingerprints', () => {
    expect(validateUuidV4(VALID_UUID)).toBe(true);
    expect(validateUuidV4('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(normalizeUuidV4(`  ${VALID_UUID.toUpperCase()}  `)).toBe(VALID_UUID);
    expect(() => normalizeUuidV4('bad')).toThrow(InvalidTradingInputError);
    expect(computeCanonicalFingerprint({ b: 2, a: { y: 1, x: 0 } })).toBe(
      computeCanonicalFingerprint({ a: { x: 0, y: 1 }, b: 2 }),
    );
    expect(computeCanonicalFingerprint({ expected_request_version: 1 })).not.toBe(
      computeCanonicalFingerprint({ expected_request_version: 2 }),
    );
  });

  it('TradingIdempotencyService executes fresh mutation, replays matching key, and rejects mismatch with 409', async () => {
    const deps = createTradingTestDeps();
    const service = new TradingIdempotencyService(deps.idempotencyRepo, deps.txRunner);
    const state = { request: { id: '1001', status: 'buyer_accepted' as const, version: 4, cancelled_at: null } };
    let stored: unknown = null;
    deps.idempotencyRepo.findByScope.mockImplementation(async () => stored);
    deps.idempotencyRepo.save.mockImplementation(async (input) => ((stored = { id: '9001', ...input }), stored));

    const executeSpy = vi.fn(async () => ({ result: { ok: true }, currentState: state }));
    const base = {
      accountId: '10',
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      objectId: '1001',
      idempotencyKey: VALID_UUID,
      payload: { expected_request_version: 3, quote_id: '401' },
      now: NOW,
      execute: executeSpy,
      getCurrentState: async () => state,
    };

    const first = await service.executeWithIdempotency(base);
    expect(first.replayed).toBe(false);
    expect(executeSpy).toHaveBeenCalledTimes(1);

    const replay = await service.executeWithIdempotency(base);
    expect(replay.replayed).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);

    await expect(
      service.executeWithIdempotency({ ...base, payload: { expected_request_version: 3, quote_id: '999' } }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('TradingCurrentStateResolver resolves current_state across all 4 versioned entities', async () => {
    const deps = createTradingTestDeps();
    const tx = {} as TransactionContext;
    deps.quoteRequestRepo.findById.mockResolvedValue(makeRequest({ version: 4 }));
    deps.allocationRepo.findById.mockResolvedValue(makeAllocation({ version: 2, status: 'in_production' }));
    deps.quoteRepo.findById.mockResolvedValue(makeQuote({ version: 2 }));
    deps.recipientRepo.findById.mockResolvedValue(makeRecipient({ version: 3 }));

    const resolver = new TradingCurrentStateResolver(deps.quoteRequestRepo, deps.allocationRepo, deps.quoteRepo, deps.recipientRepo);
    expect((await resolver.resolveCurrentState('QuoteRequest', '1001', tx)).request.version).toBe(4);
    expect((await resolver.resolveCurrentState('Allocation', '5001', tx)).allocation?.version).toBe(2);
    expect((await resolver.resolveCurrentState('Quote', '401', tx)).quote?.version).toBe(2);
    expect((await resolver.resolveCurrentState('RequestRecipient', '2001', tx)).recipient?.version).toBe(3);
  });

  it('TradingMutationInterceptor passes non-mutations, rejects missing key (400), and wraps mutations with operation metadata', async () => {
    const deps = createTradingTestDeps();
    const state = { request: { id: '1001', status: 'artisans_bidding' as const, version: 4, cancelled_at: null } };
    const idempotencyService = new TradingIdempotencyService(deps.idempotencyRepo, deps.txRunner);
    const resolver = new TradingCurrentStateResolver(deps.quoteRequestRepo, deps.allocationRepo, deps.quoteRepo, deps.recipientRepo);
    deps.quoteRequestRepo.findById.mockResolvedValue(makeRequest({ version: 4 }));
    const interceptor = new TradingMutationInterceptor(new Reflector(), idempotencyService, resolver);

    const runIntercept = async (meta: TradingMutationOptions | undefined, key?: string) => {
      const req: Record<PropertyKey, unknown> = {
        headers: key ? { 'x-idempotency-key': key } : {},
        params: { id: '1001' },
        body: { expected_request_version: 3 },
        get: (h: string) => (h.toLowerCase() === 'x-idempotency-key' ? key : undefined),
      };
      authenticatedActors.set(req as never, BUYER);
      const handler = () => undefined;
      if (meta) Reflect.defineMetadata(TRADING_MUTATION_METADATA_KEY, meta, handler);
      const ctx = {
        getHandler: () => handler,
        getClass: () => class {},
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ statusCode: 200, status: () => undefined }) }),
      } as unknown as ExecutionContext;
      const next: CallHandler = {
        handle: () => of(meta ? { data: { id: '1001' }, currentState: state } : { ok: true }),
      };
      const obs$ = await interceptor.intercept(ctx, next);
      return { out: await firstValueFrom(obs$), hadTx: Boolean(req[TRADING_TX_REQUEST_KEY]) };
    };

    // Pass-through for non-mutation route
    expect((await runIntercept(undefined)).out).toEqual({ ok: true });

    // Missing X-Idempotency-Key -> InvalidTradingInputError (400)
    const meta: TradingMutationOptions = { action: 'close_bidding', objectType: 'QuoteRequest', objectIdParam: 'id', expectedVersionField: 'expected_request_version' };
    await expect(runIntercept(meta, undefined)).rejects.toThrow(InvalidTradingInputError);

    // Valid mutation returns HttpResult with operation metadata
    const valid = await runIntercept(meta, VALID_UUID);
    expect(valid.out).toMatchObject({ data: { id: '1001' }, metadata: { operation: { replayed: false } } });
  });

  it('IdempotencyCleanupService & Scheduler purge expired records and respect AppConfig defaults', async () => {
    const devCfg = readConfig({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db', SESSION_SECRET: 's'.repeat(32), NODE_ENV: 'development' });
    const testCfg = readConfig({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db', SESSION_SECRET: 's'.repeat(32), NODE_ENV: 'test' });
    expect([devCfg.IDEMPOTENCY_CLEANUP_ENABLED, testCfg.IDEMPOTENCY_CLEANUP_ENABLED]).toEqual([true, false]);

    const deps = createTradingTestDeps();
    deps.idempotencyRepo.deleteExpiredBefore.mockResolvedValue(3);
    const cleanupSvc = new IdempotencyCleanupService(deps.idempotencyRepo, deps.txRunner, () => NOW);
    const res = await cleanupSvc.cleanupExpiredRecords();
    expect(res).toMatchObject({ status: 'completed', deletedCount: 3 });

    vi.useFakeTimers();
    const logger = { event: vi.fn() };
    const scheduler = new IdempotencyCleanupScheduler(cleanupSvc, { IDEMPOTENCY_CLEANUP_ENABLED: true, IDEMPOTENCY_CLEANUP_INTERVAL_MS: 60_000 }, logger);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await scheduler.onModuleDestroy();
    expect(deps.idempotencyRepo.deleteExpiredBefore).toHaveBeenCalledTimes(2);
  });

  it('AppModule boots cleanly and exposes all 33 Trading endpoints in OpenAPI 3.0 with X-Idempotency-Key metadata', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/test');
    vi.stubEnv('SESSION_SECRET', 'test_secret_32_chars_for_development_purposes');
    vi.stubEnv('NODE_ENV', 'development');
    vi.spyOn(PrismaService.prototype, '$connect').mockResolvedValue(undefined);
    vi.spyOn(PrismaService.prototype, '$disconnect').mockResolvedValue(undefined);

    const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger: false });
    try {
      configureHttp(app, new AppLogger('error', (_l, done) => done()));
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const endpoints: Array<[string, string]> = [
        ['/api/v1/buyer/quote-requests', 'post'],
        ['/api/v1/buyer/quote-requests', 'get'],
        ['/api/v1/buyer/quote-requests/{id}', 'put'],
        ['/api/v1/buyer/quote-requests/{id}', 'delete'],
        ['/api/v1/buyer/quote-requests/{id}/copy', 'post'],
        ['/api/v1/buyer/quote-requests/{id}/contact', 'patch'],
        ['/api/v1/buyer/quote-requests/{id}/close-bidding', 'post'],
        ['/api/v1/buyer/quote-requests/{id}/send', 'post'],
        ['/api/v1/buyer/quote-requests/{id}/accept-quote', 'post'],
        ['/api/v1/buyer/quote-requests/{id}/confirm-delivery', 'post'],
        ['/api/v1/buyer/quote-requests/{id}/cancel', 'post'],
        ['/api/v1/artisan/quote-requests', 'get'],
        ['/api/v1/artisan/quote-requests/{id}/decline', 'post'],
        ['/api/v1/artisan/quote-requests/{id}/quote', 'post'],
        ['/api/v1/artisan/quote-requests/{id}/quote/withdraw', 'post'],
        ['/api/v1/artisan/allocations', 'get'],
        ['/api/v1/artisan/allocations/{id}/start', 'post'],
        ['/api/v1/artisan/allocations/{id}/batches', 'put'],
        ['/api/v1/artisan/allocations/{id}/handover', 'post'],
        ['/api/v1/admin/quote-requests', 'get'],
        ['/api/v1/admin/quote-requests/{id}/cancel-by-admin', 'post'],
        ['/api/v1/admin/quote-requests/{id}/confirm-delivery-by-admin', 'post'],
        ['/api/v1/admin/allocations/{id}/handover-by-admin', 'post'],
        ['/api/v1/quote-requests/{id}', 'get'],
        ['/api/v1/quote-requests/{id}/recipients', 'get'],
        ['/api/v1/quote-requests/{id}/contact-history', 'get'],
        ['/api/v1/quote-requests/{id}/history', 'get'],
        ['/api/v1/quote-requests/{id}/quotes', 'get'],
        ['/api/v1/quote-requests/{id}/allocations', 'get'],
        ['/api/v1/quote-requests/{id}/recipients/{recipientId}/history', 'get'],
        ['/api/v1/allocations/{id}', 'get'],
        ['/api/v1/allocations/{id}/history', 'get'],
        ['/api/v1/allocations/{id}/batches', 'get'],
      ];
      expect(endpoints).toHaveLength(33);
      for (const [path, method] of endpoints) {
        const op = doc.paths[path]?.[method as keyof (typeof doc.paths)[string]] as { parameters?: Array<{ in?: string; name?: string }> } | undefined;
        expect(op, `${method.toUpperCase()} ${path}`).toBeDefined();
        const isExistingMutation = ['post', 'put', 'patch', 'delete'].includes(method) &&
          path !== '/api/v1/buyer/quote-requests' && path !== '/api/v1/buyer/quote-requests/{id}/copy';
        if (isExistingMutation) {
          expect(op?.parameters?.some((p) => p.in === 'header' && p.name?.toLowerCase() === 'x-idempotency-key'), `${method} ${path}`).toBe(true);
        }
      }
    } finally {
      await app.close();
    }
  });
});
