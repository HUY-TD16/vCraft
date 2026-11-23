import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../../common/config/app-config';
import {
  appLogger,
  type AppLogger,
} from '../../../../common/observability/app-logger';
import {
  IdempotencyCleanupService,
  type IdempotencyCleanupMetrics,
  type IdempotencyCleanupRunResult,
} from '../../application/services/idempotency-cleanup.service';

export const IDEMPOTENCY_CLEANUP_LOGGER = Symbol('IDEMPOTENCY_CLEANUP_LOGGER');

export type IdempotencyCleanupSchedulerConfig = Pick<
  AppConfig,
  'IDEMPOTENCY_CLEANUP_ENABLED' | 'IDEMPOTENCY_CLEANUP_INTERVAL_MS'
>;

export type IdempotencyCleanupLogger = Pick<AppLogger, 'event'>;

const MIN_INTERVAL_MS = 1000;

/**
 * NestJS lifecycle-managed scheduled task that periodically invokes
 * `IdempotencyCleanupService` to delete expired `IdempotencyRecord` rows
 * (`expires_at < NOW()`, past 24h TTL).
 *
 * Specifications:
 * - `BR-27` / `SEC-06`: Periodic cleanup of expired idempotency keys without affecting active records.
 * - `SEC-15` / `docs/backend-foundation.md`: Structured logging via `appLogger.event(...)` using
 *   only allowlisted fields (`duration_ms`, `outcome`, `code`) — never leaking SQL, stack traces,
 *   account IDs, or idempotency keys.
 * - `NC-05`: Uses Node.js standard timers (`setInterval`/`clearInterval`) with `.unref()` and
 *   graceful NestJS shutdown hooks (`OnApplicationBootstrap`, `OnModuleDestroy`) without extra packages.
 * - `NC-09`: Reads scheduling settings (`IDEMPOTENCY_CLEANUP_ENABLED`, `IDEMPOTENCY_CLEANUP_INTERVAL_MS`)
 *   from typed `APP_CONFIG`.
 */
@Injectable()
export class IdempotencyCleanupScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly activeTicks = new Set<Promise<void>>();

  constructor(
    @Inject(IdempotencyCleanupService)
    private readonly cleanupService: IdempotencyCleanupService,
    @Inject(APP_CONFIG)
    private readonly config: IdempotencyCleanupSchedulerConfig,
    @Optional()
    @Inject(IDEMPOTENCY_CLEANUP_LOGGER)
    private readonly logger: IdempotencyCleanupLogger = appLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stop();
    if (this.activeTicks.size > 0) {
      await Promise.allSettled(Array.from(this.activeTicks));
    }
  }

  /**
   * Starts the periodic cleanup interval if enabled in `APP_CONFIG`.
   * Idempotent: calling `start()` while already scheduled is a safe no-op.
   */
  start(): void {
    if (!this.config.IDEMPOTENCY_CLEANUP_ENABLED) {
      return;
    }
    if (this.timer !== null) {
      return;
    }

    const intervalMs = this.config.IDEMPOTENCY_CLEANUP_INTERVAL_MS;
    if (
      !Number.isInteger(intervalMs) ||
      intervalMs < MIN_INTERVAL_MS
    ) {
      throw new RangeError(
        `IDEMPOTENCY_CLEANUP_INTERVAL_MS must be an integer >= ${MIN_INTERVAL_MS}.`,
      );
    }

    this.timer = setInterval(() => {
      void this.runScheduledTick();
    }, intervalMs);

    // Allow graceful Node.js exit even if the interval handle is still active.
    this.timer.unref?.();

    this.logger.event(
      'info',
      'idempotency_cleanup_scheduler_started',
      'Trading',
      { outcome: 'ok' },
    );
  }

  /**
   * Stops the periodic cleanup timer if currently running.
   */
  stop(): void {
    if (this.timer === null) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;

    this.logger.event(
      'info',
      'idempotency_cleanup_scheduler_stopped',
      'Trading',
      { outcome: 'ok' },
    );
  }

  /**
   * Triggers a single cleanup execution directly (e.g., manual/operational invocation or tests).
   * Logs structured outcome and propagates errors explicitly to the caller.
   */
  async triggerCleanup(cutoff?: Date): Promise<IdempotencyCleanupRunResult> {
    const startedMs = Date.now();
    try {
      const result = await this.cleanupService.cleanupExpiredRecords(cutoff);
      if (result.status === 'skipped') {
        this.logger.event('warn', 'idempotency_cleanup_skipped', 'Trading', {
          duration_ms: result.durationMs,
          outcome: 'skipped',
        });
      } else {
        this.logger.event('info', 'idempotency_cleanup_completed', 'Trading', {
          duration_ms: result.durationMs,
          outcome: 'ok',
        });
      }
      return result;
    } catch (error: unknown) {
      const durationMs = Math.max(0, Date.now() - startedMs);
      this.logger.event('error', 'idempotency_cleanup_failed', 'Trading', {
        duration_ms: durationMs,
        outcome: 'error',
        code: 'INTERNAL_SERVER_ERROR',
      });
      throw error;
    }
  }

  isScheduled(): boolean {
    return this.timer !== null;
  }

  getMetrics(): IdempotencyCleanupMetrics {
    return this.cleanupService.getMetrics();
  }

  private runScheduledTick(): Promise<void> {
    const tickPromise = (async () => {
      try {
        await this.triggerCleanup();
      } catch {
        // Error was explicitly logged via `appLogger` in `triggerCleanup` (SEC-15, NC-08).
        // Swallow only at the timer boundary so transient DB outages do not terminate the process
        // or stop subsequent scheduled cleanup cycles.
      }
    })();

    const tracked = tickPromise.finally(() => {
      this.activeTicks.delete(tracked);
    });
    this.activeTicks.add(tracked);
    return tracked;
  }
}
