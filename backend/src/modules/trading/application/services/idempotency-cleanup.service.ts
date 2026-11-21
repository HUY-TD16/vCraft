import type { TransactionRunner } from '../../../../common/application/ports/transaction-runner';
import { InvalidTradingInputError } from '../../domain';
import type { IIdempotencyRecordRepository } from '../ports/repositories/trading-repositories.port';

export type IdempotencyCleanupRunStatus = 'completed' | 'skipped';

export interface IdempotencyCleanupRunResult {
  readonly status: IdempotencyCleanupRunStatus;
  readonly deletedCount: number;
  readonly cutoff: Date;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly durationMs: number;
}

export interface IdempotencyCleanupMetrics {
  readonly isRunning: boolean;
  readonly totalRuns: number;
  readonly totalDeleted: number;
  readonly totalErrors: number;
  readonly totalSkipped: number;
  readonly lastRunAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly lastErrorAt: Date | null;
  readonly lastDeletedCount: number;
}

/**
 * Pure application service responsible for deleting expired `IdempotencyRecord` rows
 * where `expires_at < NOW()` (past the 24-hour retention TTL) in an atomic transaction.
 *
 * Specifications:
 * - `BR-27`: Idempotency record retention TTL (24h) and background cleanup.
 * - `SEC-06`: Scope-bound idempotency hygiene without affecting active keys or business history.
 * - `data-design.md §2.20, §4.3, §5`: Delete only expired idempotency records; never touch
 *   audit/business logs (`StatusLog`, `AllocationLog`, `ContactEditHistory`, `RecipientResponseHistory`).
 * - `member-3-trading-tasks.md §2.8`: Cleanup task for expired `IdempotencyRecord` entries.
 */
export class IdempotencyCleanupService {
  private running = false;
  private totalRuns = 0;
  private totalDeleted = 0;
  private totalErrors = 0;
  private totalSkipped = 0;
  private lastRunAt: Date | null = null;
  private lastSuccessAt: Date | null = null;
  private lastErrorAt: Date | null = null;
  private lastDeletedCount = 0;

  constructor(
    private readonly idempotencyRepo: IIdempotencyRecordRepository,
    private readonly txRunner: TransactionRunner,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Executes a single cleanup sweep removing all `IdempotencyRecord` entries with
   * `expires_at < cutoff` (defaulting to current server UTC time).
   *
   * Overlapping concurrent invocations are safely skipped to prevent piling up
   * delete transactions on PostgreSQL.
   */
  async cleanupExpiredRecords(
    cutoff?: Date,
  ): Promise<IdempotencyCleanupRunResult> {
    const startedAt = this.resolveValidDate(this.clock(), 'startedAt');
    const targetCutoff =
      cutoff !== undefined
        ? this.resolveValidDate(cutoff, 'cutoff')
        : startedAt;

    if (this.running) {
      this.totalSkipped += 1;
      return Object.freeze({
        status: 'skipped' as const,
        deletedCount: 0,
        cutoff: new Date(targetCutoff.getTime()),
        startedAt: new Date(startedAt.getTime()),
        completedAt: new Date(startedAt.getTime()),
        durationMs: 0,
      });
    }

    this.running = true;
    try {
      const deletedCount = await this.txRunner.run((tx) =>
        this.idempotencyRepo.deleteExpiredBefore(targetCutoff, tx),
      );
      const completedAt = this.resolveValidDate(this.clock(), 'completedAt');
      const durationMs = Math.max(
        0,
        completedAt.getTime() - startedAt.getTime(),
      );

      this.totalRuns += 1;
      this.totalDeleted += deletedCount;
      this.lastRunAt = new Date(completedAt.getTime());
      this.lastSuccessAt = new Date(completedAt.getTime());
      this.lastDeletedCount = deletedCount;

      return Object.freeze({
        status: 'completed' as const,
        deletedCount,
        cutoff: new Date(targetCutoff.getTime()),
        startedAt: new Date(startedAt.getTime()),
        completedAt: new Date(completedAt.getTime()),
        durationMs,
      });
    } catch (error: unknown) {
      const failedAt = this.resolveValidDate(this.clock(), 'failedAt');
      this.totalRuns += 1;
      this.totalErrors += 1;
      this.lastRunAt = new Date(failedAt.getTime());
      this.lastErrorAt = new Date(failedAt.getTime());
      throw error;
    } finally {
      this.running = false;
    }
  }

  /**
   * Returns an immutable point-in-time snapshot of cleanup execution metrics.
   */
  getMetrics(): IdempotencyCleanupMetrics {
    return Object.freeze({
      isRunning: this.running,
      totalRuns: this.totalRuns,
      totalDeleted: this.totalDeleted,
      totalErrors: this.totalErrors,
      totalSkipped: this.totalSkipped,
      lastRunAt: this.lastRunAt ? new Date(this.lastRunAt.getTime()) : null,
      lastSuccessAt: this.lastSuccessAt
        ? new Date(this.lastSuccessAt.getTime())
        : null,
      lastErrorAt: this.lastErrorAt
        ? new Date(this.lastErrorAt.getTime())
        : null,
      lastDeletedCount: this.lastDeletedCount,
    });
  }

  private resolveValidDate(value: Date, field: string): Date {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new InvalidTradingInputError(
        `${field} must be a valid Date instance.`,
        { field },
      );
    }
    return value;
  }
}
