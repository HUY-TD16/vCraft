import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../../common/config/app-config';
import { appLogger, type AppLogger } from '../../../../common/observability/app-logger';
import { ReservationCleanupService } from '../../application/services/reservation-cleanup.service';

export const MEDIA_CLEANUP_LOGGER = Symbol('MEDIA_CLEANUP_LOGGER');
type SchedulerConfig = Pick<AppConfig, 'MEDIA_CLEANUP_ENABLED' | 'MEDIA_CLEANUP_INTERVAL_MS'>;

@Injectable()
export class ReservationCleanupScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeTick: Promise<void> | null = null;

  constructor(
    @Inject(ReservationCleanupService) private readonly cleanup: ReservationCleanupService,
    @Inject(APP_CONFIG) private readonly config: SchedulerConfig,
    @Optional() @Inject(MEDIA_CLEANUP_LOGGER) private readonly logger: Pick<AppLogger, 'event'> = appLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.MEDIA_CLEANUP_ENABLED || this.timer !== null) return;
    this.timer = setInterval(() => { void this.tick(); }, this.config.MEDIA_CLEANUP_INTERVAL_MS);
    this.timer.unref?.();
    this.logger.event('info', 'media_cleanup_scheduler_started', 'Media', { outcome: 'ok' });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.activeTick) await this.activeTick;
  }

  private tick(): Promise<void> {
    if (this.activeTick) return this.activeTick;
    const startedAt = Date.now();
    const run = (async () => {
      const reservations = await this.cleanup.cleanupExpiredBatch();
      const images = await this.cleanup.cleanupExpiredImagesBatch();
      const failed = reservations.failed + images.failed;
      this.logger.event(failed > 0 ? 'warn' : 'info', 'media_cleanup_completed', 'Media', {
        outcome: failed > 0 ? 'partial' : 'ok',
        duration_ms: Date.now() - startedAt,
      });
    })().catch(() => {
      this.logger.event('error', 'media_cleanup_failed', 'Media', {
        outcome: 'error',
        code: 'INTERNAL_SERVER_ERROR',
        duration_ms: Date.now() - startedAt,
      });
    }).finally(() => { this.activeTick = null; });
    this.activeTick = run;
    return run;
  }
}
