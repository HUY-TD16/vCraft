import type { TransactionRunner } from '../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../common/application/types/contract-types';
import {
  releaseReservation, releaseUsedBytes,
} from '../../domain/entities/storage-quota.entity';
import {
  confirmReleased, markCleanupPending,
} from '../../domain/entities/upload-reservation.entity';
import type { ImageStorage } from '../ports/image-storage.port';
import type {
  IImageRepository, IStorageQuotaRepository, IUploadReservationRepository,
} from '../ports/repositories/media-repositories.port';
import { UPLOAD_LIMITS } from '../../domain/value-objects/image-limits';

/**
 * released: đã dọn sạch và trả ngân sách. pending: dọn chưa xong, giữ cleanup_pending để thử lại.
 * noop: không có gì để dọn (đã committed, đã released hoặc không tồn tại).
 */
export type AbandonOutcome = 'released' | 'pending' | 'noop';

export interface ReservationCleanupBatchResult {
  readonly scanned: number;
  readonly released: number;
  readonly failed: number;
}

export interface ImageCleanupBatchResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly failed: number;
}

export interface ReservationCleanupDependencies {
  readonly txRunner: TransactionRunner;
  readonly quotas: IStorageQuotaRepository;
  readonly reservations: IUploadReservationRepository;
  readonly images: IImageRepository;
  readonly storage: ImageStorage;
}

/**
 * Dọn một reservation bị bỏ dở (worker lỗi/timeout hoặc tác vụ định kỳ). Ba bước, mỗi bước idempotent:
 *   1. giao dịch: reserved → cleanup_pending (giữ nguyên ngân sách)
 *   2. NGOÀI giao dịch: xóa toàn bộ tệp theo storage_prefix
 *   3. giao dịch: chỉ khi bước 2 thành công mới released + trả ngân sách (data-design 2.27)
 * Không bao giờ đụng tới reservation đã committed. Ném lỗi nếu hạ tầng hỏng để người gọi quyết định.
 */
export class ReservationCleanupService {
  private runningBatch = false;
  private runningImageBatch = false;

  constructor(private readonly deps: ReservationCleanupDependencies) {}

  async cleanupExpiredBatch(limit = 100): Promise<ReservationCleanupBatchResult> {
    if (this.runningBatch) return { scanned: 0, released: 0, failed: 0 };
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid cleanup batch limit');
    this.runningBatch = true;
    try {
      const { txRunner, reservations } = this.deps;
      const candidates = await txRunner.run(async tx => {
        const now = await reservations.databaseNow(tx);
        return reservations.findCleanupCandidates(now, limit, tx);
      });
      let released = 0;
      let failed = 0;
      for (const id of candidates) {
        try {
          if (await this.abandon(id) === 'released') released += 1;
        } catch {
          failed += 1;
        }
      }
      return { scanned: candidates.length, released, failed };
    } finally {
      this.runningBatch = false;
    }
  }

  async abandon(reservationId: Id): Promise<AbandonOutcome> {
    const { txRunner, quotas, reservations, storage } = this.deps;

    const claimed = await txRunner.run(async (tx) => {
      const peek = await reservations.findById(reservationId, tx);
      if (peek === null) return null;
      await quotas.lockStorageBudget(tx);
      await quotas.lockById(peek.quotaId, tx);
      const locked = await reservations.lockById(reservationId, tx);
      if (locked === null || locked.state.status === 'committed' || locked.state.status === 'released') return null;
      if (locked.state.status === 'reserved') {
        await reservations.saveState(reservationId, markCleanupPending(locked.state), tx);
      }
      return locked.storagePrefix;
    });
    if (claimed === null) return 'noop';

    // Worker chậm có thể ghi tệp sau lần dọn trước, nên luôn xóa lại trước khi trả ngân sách.
    await storage.deletePrefix(claimed);

    return txRunner.run(async (tx) => {
      const peek = await reservations.findById(reservationId, tx);
      if (peek === null) return 'noop';
      await quotas.lockStorageBudget(tx);
      const quota = await quotas.lockById(peek.quotaId, tx);
      const locked = await reservations.lockById(reservationId, tx);
      if (quota === null || locked === null || locked.state.status !== 'cleanup_pending') return 'noop';
      await quotas.save({ id: quota.id, state: releaseReservation(quota.state, locked.state.budgetBytes) }, tx);
      await reservations.saveState(reservationId, confirmReleased(locked.state), tx);
      return 'released';
    });
  }

  async cleanupExpiredImagesBatch(limit = 100): Promise<ImageCleanupBatchResult> {
    if (this.runningImageBatch) return { scanned: 0, deleted: 0, failed: 0 };
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid image cleanup batch limit');
    this.runningImageBatch = true;
    try {
      const { txRunner, reservations, images, quotas, storage } = this.deps;
      const { candidates, cutoff } = await txRunner.run(async tx => {
        const now = await reservations.databaseNow(tx);
        const imageCutoff = new Date(now.getTime() - UPLOAD_LIMITS.unattachedTtlHours * 60 * 60 * 1000);
        return {
          cutoff: imageCutoff,
          candidates: await images.findImageCleanupCandidates(imageCutoff, limit, tx),
        };
      });

      let deleted = 0;
      let failed = 0;
      for (const candidate of candidates) {
        try {
          const claimed = await txRunner.run(async tx => {
            await quotas.lockStorageBudget(tx);
            const quota = await quotas.lockById(candidate.quotaId, tx);
            if (!quota) throw new Error('Image quota missing during cleanup');
            return images.claimImageForCleanup(candidate.id, cutoff, tx);
          });
          if (!claimed) continue;

          await storage.delete(claimed.thumbnailKey);
          await storage.delete(claimed.displayKey);

          const removed = await txRunner.run(async tx => {
            await quotas.lockStorageBudget(tx);
            const quota = await quotas.lockById(claimed.quotaId, tx);
            if (!quota) throw new Error('Image quota missing during cleanup finalization');
            const row = await images.deleteClaimedImage(claimed.id, cutoff, tx);
            if (!row) return false;
            await quotas.save({
              id: quota.id,
              state: releaseUsedBytes(quota.state, row.actualBytes),
            }, tx);
            return true;
          });
          if (removed) deleted += 1;
        } catch {
          failed += 1;
        }
      }
      return { scanned: candidates.length, deleted, failed };
    } finally {
      this.runningImageBatch = false;
    }
  }
}
