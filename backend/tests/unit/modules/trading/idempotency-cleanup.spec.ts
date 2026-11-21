import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../src/common/application/ports/transaction-runner';
import {
  ConfigurationError,
  readConfig,
} from '../../../../src/common/config/app-config';
import { AppLogger } from '../../../../src/common/observability/app-logger';
import type { PrismaService } from '../../../../src/infrastructure/database/prisma/prisma.service';
import { PrismaService as PrismaServiceClass } from '../../../../src/infrastructure/database/prisma/prisma.service';
import { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import { AppModule } from '../../../../src/bootstrap/app.module';
import { TradingModule } from '../../../../src/modules/trading/trading.module';
import { InvalidTradingInputError } from '../../../../src/modules/trading/domain';
import type { IIdempotencyRecordRepository } from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { IdempotencyCleanupService } from '../../../../src/modules/trading/application/services/idempotency-cleanup.service';
import {
  IdempotencyCleanupScheduler,
  type IdempotencyCleanupLogger,
} from '../../../../src/modules/trading/adapters/jobs/idempotency-cleanup.scheduler';
import { PrismaIdempotencyRecordRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository';
import type { IdempotencyRecord as PrismaIdempotencyRecord } from '../../../../src/generated/prisma/client';

const VALID_BASE_ENV = {
  DATABASE_URL: 'postgresql://user:password@localhost:5432/vcraft?schema=public',
  SESSION_SECRET: 'example_session_secret_with_at_least_32_chars',
};

function createMockTxRunner() {
  const dummyTx = { __brand: 'mock-tx' } as unknown as TransactionContext;
  const runSpy = vi.fn().mockImplementation(
    async <T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> => {
      return work(dummyTx);
    },
  );
  return {
    txRunner: { run: runSpy } as TransactionRunner,
    dummyTx,
    runSpy,
  };
}

function createMockRepo() {
  const deleteExpiredBeforeSpy = vi.fn();
  const repo: IIdempotencyRecordRepository = {
    findByScope: vi.fn(),
    findAndVerifyReplay: vi.fn(),
    save: vi.fn(),
    deleteExpiredBefore: deleteExpiredBeforeSpy,
  };
  return { repo, deleteExpiredBeforeSpy };
}

function createInMemoryIdempotencyStore(initialRows: PrismaIdempotencyRecord[]) {
  const rows = initialRows.map((row) => ({ ...row }));

  const mockClient = {
    idempotencyRecord: {
      deleteMany: vi.fn(
        async (args: { where: { expires_at: { lt: Date } } }) => {
          const cutoffMs = args.where.expires_at.lt.getTime();
          let deleted = 0;
          for (let i = rows.length - 1; i >= 0; i -= 1) {
            if (rows[i].expires_at.getTime() < cutoffMs) {
              rows.splice(i, 1);
              deleted += 1;
            }
          }
          return { count: deleted };
        },
      ),
    },
  };

  const mockPrismaService = {
    $transaction: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) => await fn(mockClient),
    ),
  } as unknown as PrismaService;

  const txRunner = new PrismaTransactionRunner(mockPrismaService);
  const repository = new PrismaIdempotencyRecordRepository(txRunner);

  return { rows, mockClient, txRunner, repository };
}

describe('Task 39: IdempotencyRecord Expired Cleanup (BR-27, SEC-06, SEC-15)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Suite 1: Typed Configuration (NC-09)
  // ==========================================================================
  describe('1. AppConfig — Idempotency Cleanup Settings (NC-09)', () => {
    it('applies safe environment-aware defaults (enabled in dev/prod, disabled in test, 1h interval)', () => {
      const devConfig = readConfig({ ...VALID_BASE_ENV, NODE_ENV: 'development' });
      expect(devConfig.IDEMPOTENCY_CLEANUP_ENABLED).toBe(true);
      expect(devConfig.IDEMPOTENCY_CLEANUP_INTERVAL_MS).toBe(3_600_000);

      const prodConfig = readConfig({ ...VALID_BASE_ENV, NODE_ENV: 'production' });
      expect(prodConfig.IDEMPOTENCY_CLEANUP_ENABLED).toBe(true);
      expect(prodConfig.IDEMPOTENCY_CLEANUP_INTERVAL_MS).toBe(3_600_000);

      const testConfig = readConfig({ ...VALID_BASE_ENV, NODE_ENV: 'test' });
      expect(testConfig.IDEMPOTENCY_CLEANUP_ENABLED).toBe(false);
      expect(testConfig.IDEMPOTENCY_CLEANUP_INTERVAL_MS).toBe(3_600_000);
    });

    it('honors explicit boolean and interval overrides across environments', () => {
      const enabledInTest = readConfig({
        ...VALID_BASE_ENV,
        NODE_ENV: 'test',
        IDEMPOTENCY_CLEANUP_ENABLED: 'true',
        IDEMPOTENCY_CLEANUP_INTERVAL_MS: '60000',
      });
      expect(enabledInTest.IDEMPOTENCY_CLEANUP_ENABLED).toBe(true);
      expect(enabledInTest.IDEMPOTENCY_CLEANUP_INTERVAL_MS).toBe(60_000);

      const disabledInProd = readConfig({
        ...VALID_BASE_ENV,
        NODE_ENV: 'production',
        IDEMPOTENCY_CLEANUP_ENABLED: 'false',
        IDEMPOTENCY_CLEANUP_INTERVAL_MS: '86400000',
      });
      expect(disabledInProd.IDEMPOTENCY_CLEANUP_ENABLED).toBe(false);
      expect(disabledInProd.IDEMPOTENCY_CLEANUP_INTERVAL_MS).toBe(86_400_000);
    });

    it.each([
      ['IDEMPOTENCY_CLEANUP_ENABLED', 'yes'],
      ['IDEMPOTENCY_CLEANUP_ENABLED', '1'],
      ['IDEMPOTENCY_CLEANUP_ENABLED', ''],
      ['IDEMPOTENCY_CLEANUP_INTERVAL_MS', '0'],
      ['IDEMPOTENCY_CLEANUP_INTERVAL_MS', '999'],
      ['IDEMPOTENCY_CLEANUP_INTERVAL_MS', '86400001'],
      ['IDEMPOTENCY_CLEANUP_INTERVAL_MS', '-5000'],
      ['IDEMPOTENCY_CLEANUP_INTERVAL_MS', 'abc'],
    ])('fails fast with ConfigurationError for invalid %s=%s', (field, value) => {
      try {
        readConfig({ ...VALID_BASE_ENV, [field]: value });
        throw new Error('Expected readConfig to throw ConfigurationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        expect((error as ConfigurationError).fields).toContain(field);
      }
    });
  });

  // ==========================================================================
  // Suite 2: Pure Application Layer — IdempotencyCleanupService
  // ==========================================================================
  describe('2. IdempotencyCleanupService (Application Layer Purity & Semantics)', () => {
    it('maintains strict Clean Architecture purity (no NestJS, Prisma, Zod, or adapter imports)', () => {
      const filePath = join(
        __dirname,
        '../../../../src/modules/trading/application/services/idempotency-cleanup.service.ts',
      );
      const source = readFileSync(filePath, 'utf-8');

      expect(source).not.toMatch(/@nestjs\//);
      expect(source).not.toMatch(/@prisma\/client/);
      expect(source).not.toMatch(/generated\/prisma/);
      expect(source).not.toMatch(/from ['"]zod['"]/);
      expect(source).not.toMatch(/adapters\//);
    });

    it('deletes expired records inside a transaction using server clock when cutoff is omitted', async () => {
      const tStart = new Date('2026-11-21T10:00:00.000Z');
      const tEnd = new Date('2026-11-21T10:00:00.125Z');
      let calls = 0;
      const clock = () => (calls++ === 0 ? tStart : tEnd);

      const { txRunner, dummyTx } = createMockTxRunner();
      const { repo, deleteExpiredBeforeSpy } = createMockRepo();
      deleteExpiredBeforeSpy.mockResolvedValue(7);

      const service = new IdempotencyCleanupService(repo, txRunner, clock);
      const result = await service.cleanupExpiredRecords();

      expect(deleteExpiredBeforeSpy).toHaveBeenCalledTimes(1);
      expect(deleteExpiredBeforeSpy).toHaveBeenCalledWith(tStart, dummyTx);
      expect(result).toEqual({
        status: 'completed',
        deletedCount: 7,
        cutoff: tStart,
        startedAt: tStart,
        completedAt: tEnd,
        durationMs: 125,
      });
      expect(Object.isFrozen(result)).toBe(true);

      const metrics = service.getMetrics();
      expect(metrics).toEqual({
        isRunning: false,
        totalRuns: 1,
        totalDeleted: 7,
        totalErrors: 0,
        totalSkipped: 0,
        lastRunAt: tEnd,
        lastSuccessAt: tEnd,
        lastErrorAt: null,
        lastDeletedCount: 7,
      });
      expect(Object.isFrozen(metrics)).toBe(true);
    });

    it('uses explicit cutoff when supplied and rejects invalid Date instances', async () => {
      const explicitCutoff = new Date('2026-11-20T00:00:00.000Z');
      const { txRunner, runSpy, dummyTx } = createMockTxRunner();
      const { repo, deleteExpiredBeforeSpy } = createMockRepo();
      deleteExpiredBeforeSpy.mockResolvedValue(3);

      const service = new IdempotencyCleanupService(repo, txRunner);
      const result = await service.cleanupExpiredRecords(explicitCutoff);

      expect(result.deletedCount).toBe(3);
      expect(result.cutoff.toISOString()).toBe(explicitCutoff.toISOString());
      expect(deleteExpiredBeforeSpy).toHaveBeenCalledWith(explicitCutoff, dummyTx);

      await expect(
        service.cleanupExpiredRecords(new Date('invalid-date')),
      ).rejects.toThrow(InvalidTradingInputError);
      // Transaction was NOT opened for invalid input
      expect(runSpy).toHaveBeenCalledTimes(1);
    });

    it('deletes strictly expires_at < NOW() and preserves expires_at === NOW() and expires_at > NOW()', async () => {
      const now = new Date('2026-11-21T12:00:00.000Z');
      const oneDayMs = 24 * 60 * 60 * 1000;

      const makeRow = (id: bigint, expiresAt: Date): PrismaIdempotencyRecord => ({
        id,
        idempotency_key: `key-${id.toString()}`,
        request_fingerprint: 'a'.repeat(64),
        account_id: 10n,
        action: 'accept_quote',
        object_type: 'QuoteRequest',
        object_id: 100n,
        result_snapshot: { ok: true },
        created_at: new Date(expiresAt.getTime() - oneDayMs),
        expires_at: expiresAt,
      });

      const store = createInMemoryIdempotencyStore([
        makeRow(1n, new Date(now.getTime() - oneDayMs)), // 24h past expiry -> DELETE
        makeRow(2n, new Date(now.getTime() - 1)), // 1ms past expiry -> DELETE
        makeRow(3n, new Date(now.getTime())), // exact boundary === NOW -> KEEP
        makeRow(4n, new Date(now.getTime() + 1)), // 1ms remaining -> KEEP
        makeRow(5n, new Date(now.getTime() + oneDayMs)), // fresh 24h TTL -> KEEP
      ]);

      const service = new IdempotencyCleanupService(
        store.repository,
        store.txRunner,
        () => now,
      );

      const result = await service.cleanupExpiredRecords();

      expect(result.status).toBe('completed');
      expect(result.deletedCount).toBe(2);
      expect(store.rows.map((r) => r.id)).toEqual([3n, 4n, 5n]);
    });

    it('skips overlapping concurrent cleanup runs without starting a second transaction', async () => {
      let releaseFirstRun!: (count: number) => void;
      const firstRunPromise = new Promise<number>((resolve) => {
        releaseFirstRun = resolve;
      });

      const { txRunner, runSpy } = createMockTxRunner();
      const { repo, deleteExpiredBeforeSpy } = createMockRepo();
      deleteExpiredBeforeSpy.mockImplementationOnce(() => firstRunPromise);
      deleteExpiredBeforeSpy.mockResolvedValueOnce(2);

      const service = new IdempotencyCleanupService(repo, txRunner);

      const firstPromise = service.cleanupExpiredRecords();
      expect(service.getMetrics().isRunning).toBe(true);

      // Overlapping call while first run is in flight
      const skippedResult = await service.cleanupExpiredRecords();
      expect(skippedResult.status).toBe('skipped');
      expect(skippedResult.deletedCount).toBe(0);
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(service.getMetrics().totalSkipped).toBe(1);

      // Finish first run
      releaseFirstRun(5);
      const firstResult = await firstPromise;
      expect(firstResult.status).toBe('completed');
      expect(firstResult.deletedCount).toBe(5);
      expect(service.getMetrics().isRunning).toBe(false);

      // Subsequent run executes normally
      const secondResult = await service.cleanupExpiredRecords();
      expect(secondResult.status).toBe('completed');
      expect(secondResult.deletedCount).toBe(2);
      expect(runSpy).toHaveBeenCalledTimes(2);
      expect(service.getMetrics().totalRuns).toBe(2);
      expect(service.getMetrics().totalDeleted).toBe(7);
    });

    it('propagates repository errors explicitly (NC-08), tracks error metrics, and recovers on next run', async () => {
      const { txRunner } = createMockTxRunner();
      const { repo, deleteExpiredBeforeSpy } = createMockRepo();
      deleteExpiredBeforeSpy
        .mockRejectedValueOnce(new Error('PostgreSQL connection lost'))
        .mockResolvedValueOnce(4);

      const service = new IdempotencyCleanupService(repo, txRunner);

      await expect(service.cleanupExpiredRecords()).rejects.toThrow(
        'PostgreSQL connection lost',
      );

      const afterError = service.getMetrics();
      expect(afterError.isRunning).toBe(false);
      expect(afterError.totalRuns).toBe(1);
      expect(afterError.totalErrors).toBe(1);
      expect(afterError.totalDeleted).toBe(0);
      expect(afterError.lastErrorAt).toBeInstanceOf(Date);
      expect(afterError.lastSuccessAt).toBeNull();

      const recovery = await service.cleanupExpiredRecords();
      expect(recovery.status).toBe('completed');
      expect(recovery.deletedCount).toBe(4);
      expect(service.getMetrics().totalRuns).toBe(2);
      expect(service.getMetrics().totalErrors).toBe(1);
      expect(service.getMetrics().totalDeleted).toBe(4);
      expect(service.getMetrics().lastSuccessAt).toBeInstanceOf(Date);
    });
  });

  // ==========================================================================
  // Suite 3: Scheduled Adapter — IdempotencyCleanupScheduler
  // ==========================================================================
  describe('3. IdempotencyCleanupScheduler (Periodic Execution, Shutdown & SEC-15 Logging)', () => {
    let loggerSpy: { event: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      loggerSpy = { event: vi.fn() };
    });

    it('runs cleanup periodically at configured interval and stops cleanly on onModuleDestroy', async () => {
      vi.useFakeTimers();

      const { txRunner } = createMockTxRunner();
      const { repo, deleteExpiredBeforeSpy } = createMockRepo();
      deleteExpiredBeforeSpy.mockResolvedValue(3);

      const cleanupService = new IdempotencyCleanupService(repo, txRunner);
      const scheduler = new IdempotencyCleanupScheduler(
        cleanupService,
        {
          IDEMPOTENCY_CLEANUP_ENABLED: true,
          IDEMPOTENCY_CLEANUP_INTERVAL_MS: 5_000,
        },
        loggerSpy as unknown as IdempotencyCleanupLogger,
      );

      scheduler.onApplicationBootstrap();
      // Calling start() again is idempotent (no duplicate intervals)
      scheduler.start();
      expect(scheduler.isScheduled()).toBe(true);
      expect(deleteExpiredBeforeSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(deleteExpiredBeforeSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(deleteExpiredBeforeSpy).toHaveBeenCalledTimes(3);
      expect(scheduler.getMetrics().totalDeleted).toBe(9);

      await scheduler.onModuleDestroy();
      expect(scheduler.isScheduled()).toBe(false);

      // No further ticks fire after destroy
      await vi.advanceTimersByTimeAsync(20_000);
      expect(deleteExpiredBeforeSpy).toHaveBeenCalledTimes(3);

      expect(loggerSpy.event).toHaveBeenCalledWith(
        'info',
        'idempotency_cleanup_scheduler_started',
        'Trading',
        { outcome: 'ok' },
      );
      expect(loggerSpy.event).toHaveBeenCalledWith(
        'info',
        'idempotency_cleanup_completed',
        'Trading',
        expect.objectContaining({ outcome: 'ok' }),
      );
      expect(loggerSpy.event).toHaveBeenCalledWith(
        'info',
        'idempotency_cleanup_scheduler_stopped',
        'Trading',
        { outcome: 'ok' },
      );
    });

    it('does not schedule a timer when IDEMPOTENCY_CLEANUP_ENABLED is false', async () => {
      vi.useFakeTimers();

      const { txRunner } = createMockTxRunner();
      const { repo, deleteExpiredBeforeSpy } = createMockRepo();
      const cleanupService = new IdempotencyCleanupService(repo, txRunner);
      const scheduler = new IdempotencyCleanupScheduler(
        cleanupService,
        {
          IDEMPOTENCY_CLEANUP_ENABLED: false,
          IDEMPOTENCY_CLEANUP_INTERVAL_MS: 5_000,
        },
        loggerSpy as unknown as IdempotencyCleanupLogger,
      );

      scheduler.onApplicationBootstrap();
      expect(scheduler.isScheduled()).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(deleteExpiredBeforeSpy).not.toHaveBeenCalled();
    });

    it('rejects invalid intervalMs < 1000ms on start() (defense-in-depth)', () => {
      const { txRunner } = createMockTxRunner();
      const { repo } = createMockRepo();
      const cleanupService = new IdempotencyCleanupService(repo, txRunner);
      const scheduler = new IdempotencyCleanupScheduler(
        cleanupService,
        {
          IDEMPOTENCY_CLEANUP_ENABLED: true,
          IDEMPOTENCY_CLEANUP_INTERVAL_MS: 500,
        },
        loggerSpy as unknown as IdempotencyCleanupLogger,
      );

      expect(() => scheduler.start()).toThrow(RangeError);
      expect(scheduler.isScheduled()).toBe(false);
    });

    it('survives transient DB failures on scheduled ticks, logs sanitized SEC-15 events, and retries next tick', async () => {
      vi.useFakeTimers();

      const loggedLines: string[] = [];
      const realLogger = new AppLogger('info', (line, done) => {
        loggedLines.push(line);
        done(null);
      });

      const { txRunner } = createMockTxRunner();
      const { repo, deleteExpiredBeforeSpy } = createMockRepo();
      deleteExpiredBeforeSpy
        .mockRejectedValueOnce(
          new Error(
            'SELECT * FROM "IdempotencyRecord" failed: secret_password_leak',
          ),
        )
        .mockResolvedValueOnce(6);

      const cleanupService = new IdempotencyCleanupService(repo, txRunner);
      const scheduler = new IdempotencyCleanupScheduler(
        cleanupService,
        {
          IDEMPOTENCY_CLEANUP_ENABLED: true,
          IDEMPOTENCY_CLEANUP_INTERVAL_MS: 2_000,
        },
        realLogger,
      );

      scheduler.onApplicationBootstrap();

      // Tick 1 fails -> logged safely without leaking SQL or secret text
      await vi.advanceTimersByTimeAsync(2_000);
      expect(scheduler.getMetrics().totalErrors).toBe(1);
      expect(scheduler.getMetrics().totalDeleted).toBe(0);

      // Tick 2 succeeds -> scheduler remained alive
      await vi.advanceTimersByTimeAsync(2_000);
      expect(scheduler.getMetrics().totalErrors).toBe(1);
      expect(scheduler.getMetrics().totalDeleted).toBe(6);

      await scheduler.onModuleDestroy();

      const serializedLogs = loggedLines.join('\n');
      expect(serializedLogs).toContain('"event":"idempotency_cleanup_failed"');
      expect(serializedLogs).toContain('"code":"INTERNAL_SERVER_ERROR"');
      expect(serializedLogs).toContain('"event":"idempotency_cleanup_completed"');
      // SEC-15: zero leakage of SQL, error details, or secrets
      expect(serializedLogs).not.toContain('SELECT *');
      expect(serializedLogs).not.toContain('secret_password_leak');
    });

    it('awaits in-flight long-running tick during onModuleDestroy even when an overlapping tick was skipped', async () => {
      vi.useFakeTimers();

      let resolveSlowDelete!: (count: number) => void;
      const slowDelete = new Promise<number>((resolve) => {
        resolveSlowDelete = resolve;
      });

      const { txRunner } = createMockTxRunner();
      const { repo, deleteExpiredBeforeSpy } = createMockRepo();
      deleteExpiredBeforeSpy.mockImplementationOnce(() => slowDelete);

      const cleanupService = new IdempotencyCleanupService(repo, txRunner);
      const scheduler = new IdempotencyCleanupScheduler(
        cleanupService,
        {
          IDEMPOTENCY_CLEANUP_ENABLED: true,
          IDEMPOTENCY_CLEANUP_INTERVAL_MS: 2_000,
        },
        loggerSpy as unknown as IdempotencyCleanupLogger,
      );

      scheduler.onApplicationBootstrap();

      // Tick 1 starts and blocks on slowDelete
      await vi.advanceTimersByTimeAsync(2_000);
      expect(scheduler.getMetrics().isRunning).toBe(true);

      // Tick 2 fires while Tick 1 is still running -> skipped
      await vi.advanceTimersByTimeAsync(2_000);
      expect(scheduler.getMetrics().totalSkipped).toBe(1);
      expect(loggerSpy.event).toHaveBeenCalledWith(
        'warn',
        'idempotency_cleanup_skipped',
        'Trading',
        expect.objectContaining({ outcome: 'skipped' }),
      );

      // Begin shutdown while Tick 1 is still active
      let destroyed = false;
      const destroyPromise = scheduler.onModuleDestroy().then(() => {
        destroyed = true;
      });

      await Promise.resolve();
      expect(scheduler.isScheduled()).toBe(false);
      expect(destroyed).toBe(false);

      // Complete Tick 1 -> destroyPromise now resolves cleanly
      resolveSlowDelete(11);
      await destroyPromise;
      expect(destroyed).toBe(true);
      expect(scheduler.getMetrics().totalDeleted).toBe(11);
    });

    it('triggerCleanup propagates errors directly to manual callers after logging', async () => {
      const { txRunner } = createMockTxRunner();
      const { repo, deleteExpiredBeforeSpy } = createMockRepo();
      deleteExpiredBeforeSpy.mockRejectedValueOnce(new Error('DB unavailable'));

      const cleanupService = new IdempotencyCleanupService(repo, txRunner);
      const scheduler = new IdempotencyCleanupScheduler(
        cleanupService,
        {
          IDEMPOTENCY_CLEANUP_ENABLED: false,
          IDEMPOTENCY_CLEANUP_INTERVAL_MS: 60_000,
        },
        loggerSpy as unknown as IdempotencyCleanupLogger,
      );

      await expect(scheduler.triggerCleanup()).rejects.toThrow('DB unavailable');
      expect(loggerSpy.event).toHaveBeenCalledWith(
        'error',
        'idempotency_cleanup_failed',
        'Trading',
        expect.objectContaining({
          outcome: 'error',
          code: 'INTERNAL_SERVER_ERROR',
        }),
      );
    });
  });

  // ==========================================================================
  // Suite 4: NestJS DI & Module Boot Verification
  // ==========================================================================
  describe('4. TradingModule & AppModule NestJS DI Wiring', () => {
    it('resolves IdempotencyCleanupService and IdempotencyCleanupScheduler in TradingModule and defaults disabled in NODE_ENV=test', async () => {
      vi.spyOn(PrismaServiceClass.prototype, '$connect').mockResolvedValue(
        undefined,
      );
      vi.spyOn(PrismaServiceClass.prototype, '$disconnect').mockResolvedValue(
        undefined,
      );
      vi.spyOn(
        PrismaServiceClass.prototype,
        '$queryRaw' as never,
      ).mockResolvedValue([{ '?column?': 1 }] as never);

      const prevNodeEnv = process.env.NODE_ENV;
      const prevEnabled = process.env.IDEMPOTENCY_CLEANUP_ENABLED;
      process.env.NODE_ENV = 'test';
      delete process.env.IDEMPOTENCY_CLEANUP_ENABLED;

      const app = await NestFactory.createApplicationContext(TradingModule, {
        logger: false,
      });
      try {
        const service = app.get(IdempotencyCleanupService);
        const scheduler = app.get(IdempotencyCleanupScheduler);

        expect(service).toBeInstanceOf(IdempotencyCleanupService);
        expect(scheduler).toBeInstanceOf(IdempotencyCleanupScheduler);
        expect(scheduler.isScheduled()).toBe(false);
      } finally {
        await app.close();
        if (prevNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = prevNodeEnv;
        }
        if (prevEnabled === undefined) {
          delete process.env.IDEMPOTENCY_CLEANUP_ENABLED;
        } else {
          process.env.IDEMPOTENCY_CLEANUP_ENABLED = prevEnabled;
        }
      }
    });

    it('auto-starts and cleanly stops scheduler on AppModule lifecycle when IDEMPOTENCY_CLEANUP_ENABLED=true', async () => {
      vi.spyOn(PrismaServiceClass.prototype, '$connect').mockResolvedValue(
        undefined,
      );
      vi.spyOn(PrismaServiceClass.prototype, '$disconnect').mockResolvedValue(
        undefined,
      );
      vi.spyOn(
        PrismaServiceClass.prototype,
        '$queryRaw' as never,
      ).mockResolvedValue([{ '?column?': 1 }] as never);

      const prevEnabled = process.env.IDEMPOTENCY_CLEANUP_ENABLED;
      const prevInterval = process.env.IDEMPOTENCY_CLEANUP_INTERVAL_MS;
      process.env.IDEMPOTENCY_CLEANUP_ENABLED = 'true';
      process.env.IDEMPOTENCY_CLEANUP_INTERVAL_MS = '60000';

      let app: NestExpressApplication | undefined;
      try {
        app = await NestFactory.create<NestExpressApplication>(AppModule, {
          logger: false,
        });
        await app.init();

        const scheduler = app.get(IdempotencyCleanupScheduler);
        expect(scheduler.isScheduled()).toBe(true);

        await app.close();
        app = undefined;
        expect(scheduler.isScheduled()).toBe(false);
      } finally {
        await app?.close();
        if (prevEnabled === undefined) {
          delete process.env.IDEMPOTENCY_CLEANUP_ENABLED;
        } else {
          process.env.IDEMPOTENCY_CLEANUP_ENABLED = prevEnabled;
        }
        if (prevInterval === undefined) {
          delete process.env.IDEMPOTENCY_CLEANUP_INTERVAL_MS;
        } else {
          process.env.IDEMPOTENCY_CLEANUP_INTERVAL_MS = prevInterval;
        }
      }
    }, 30_000);
  });
});
