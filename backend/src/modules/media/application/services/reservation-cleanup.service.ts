import type { TransactionRunner } from '../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../common/application/types/contract-types';
import {
  releaseReservation,
} from '../../domain/entities/storage-quota.entity';
import {
  confirmReleased, markCleanupPending,
} from '../../domain/entities/upload-reservation.entity';
import type { ImageStorage } from '../ports/image-storage.port';
import type {
  IStorageQuotaRepository, IUploadReservationRepository,
} from '../ports/repositories/media-repositories.port';

/**
 * released: đã dọn sạch và trả ngân sách. pending: dọn chưa xong, giữ cleanup_pending để thử lại.
 * noop: không có gì để dọn (đã committed, đã released hoặc không tồn tại).
 */
export type AbandonOutcome = 'released' | 'pending' | 'noop';

export interface ReservationCleanupDependencies {
  readonly txRunner: TransactionRunner;
  readonly quotas: IStorageQuotaRepository;
  readonly reservations: IUploadReservationRepository;
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
  constructor(private readonly deps: ReservationCleanupDependencies) {}

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
}
