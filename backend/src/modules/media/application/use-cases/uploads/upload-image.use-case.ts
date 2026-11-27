import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '../../../../../common/application/errors/service-unavailable.exception';
import type { TransactionContext, TransactionRunner } from '../../../../../common/application/ports/transaction-runner';
import type { TrustedActor } from '../../../../../common/application/types/contract-types';
import { BusinessRuleException } from '../../../../../common/domain/errors/business-rule.exception';
import { MediaDomainError } from '../../../domain/errors/media-domain.error';
import {
  assertFitsWithin, reserveBytes, settleReservation, type StorageQuotaState,
} from '../../../domain/entities/storage-quota.entity';
import { commitReservation } from '../../../domain/entities/upload-reservation.entity';
import { assertAcceptableImage } from '../../../domain/policies/image-validation.policy';
import { hasEnoughFreeSpace } from '../../../domain/policies/storage-capacity.policy';
import { assertCanUpload, type UploadTarget } from '../../../domain/policies/upload-permission.policy';
import { assertScopeUsable } from '../../../domain/policies/upload-scope.policy';
import { QUOTA_LIMIT_BYTES, UPLOAD_LIMITS } from '../../../domain/value-objects/image-limits';
import {
  ImageProcessingUnavailableError, type ImageProcessor,
} from '../../ports/image-processor.port';
import type { AdminAssertion } from '../../ports/admin-assertion.port';
import type { ImageAccessResolver } from '../../ports/queries/image-access-resolver.port';
import type { ImageStorage } from '../../ports/image-storage.port';
import type { IStorageCapacity } from '../../ports/storage-capacity.port';
import type {
  IImageRepository, IStorageQuotaRepository, IUploadReservationRepository, IUploadScopeRepository,
  StorageQuotaRecord, UploadReservationRecord,
} from '../../ports/repositories/media-repositories.port';
import type { ReservationCleanupService } from '../../services/reservation-cleanup.service';
import type { UploadImageCommand, UploadImageResult } from '../../dtos/media-use-case.dtos';

export type { AdminAssertion };
export type { UploadImageCommand, UploadImageResult } from '../../dtos/media-use-case.dtos';

export interface UploadImageDependencies {
  readonly txRunner: TransactionRunner;
  readonly quotas: IStorageQuotaRepository;
  readonly scopes: IUploadScopeRepository;
  readonly reservations: IUploadReservationRepository;
  readonly images: IImageRepository;
  readonly processor: ImageProcessor;
  readonly storage: ImageStorage;
  readonly capacity: IStorageCapacity;
  readonly cleanup: ReservationCleanupService;
  readonly admins: AdminAssertion;
  /** Optional in unit harnesses; production DI always supplies the owner-module resolver. */
  readonly access?: ImageAccessResolver;
  /** Sinh phần ngẫu nhiên của storage_prefix; mặc định UUID v4. */
  readonly newPrefixId?: () => string;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * UC upload ảnh (API 8.1). Trình tự và lý do:
 *  1. quyền + kiểm tra ảnh bằng giải mã thật (không DB, rẻ)        → từ chối sớm ảnh rác
 *  2. giao dịch 1: giữ chỗ dung lượng nguyên tử                    → trước khi tốn CPU xử lý
 *  3. NGOÀI giao dịch: Sharp + ghi tệp                              → không giữ khóa DB lúc xử lý ảnh
 *  4. giao dịch 2: quyết toán + tạo Image                           → chỉ có image_id khi mọi thứ đã xong
 *  Lỗi sau bước 2 luôn đi qua dọn dẹp; byte chỉ được trả sau khi tệp đã xóa.
 */
export class UploadImageUseCase {
  constructor(private readonly deps: UploadImageDependencies) {}

  async execute(command: UploadImageCommand): Promise<UploadImageResult> {
    const { actor, target, contextType } = command;
    assertCanUpload({ role: actor.role, workshopId: actor.workshopId }, contextType, target);
    if (target.kind === 'initial_scope' && command.contextId !== null) {
      throw new BusinessRuleException('INVALID_INPUT', 'INVALID_INPUT', { field: 'context_id' });
    }

    assertAcceptableImage(command.file.byteLength, await this.deps.processor.inspect(command.file));

    const reservation = await this.reserve(command);
    try {
      const processed = await this.deps.processor.process(command.file);
      const thumbnailKey = `${reservation.storagePrefix}thumbnail.webp`;
      const displayKey = `${reservation.storagePrefix}display.webp`;
      await this.deps.storage.write(thumbnailKey, processed.thumbnail.data);
      await this.deps.storage.write(displayKey, processed.display.data);
      return await this.commit(command, reservation, {
        thumbnailKey, displayKey,
        thumbnailBytes: BigInt(processed.thumbnail.bytes),
        displayBytes: BigInt(processed.display.bytes),
        width: processed.width, height: processed.height,
      });
    } catch (error) {
      try {
        await this.deps.cleanup.abandon(reservation.id);
      } catch {
        // Dọn chưa xong: reservation giữ cleanup_pending, tác vụ định kỳ sẽ thử lại. Không che lỗi gốc.
      }
      throw error instanceof ImageProcessingUnavailableError
        ? new ServiceUnavailableException('IMAGE_PROCESSING_UNAVAILABLE')
        : error;
    }
  }

  /** Giao dịch 1. */
  private reserve(command: UploadImageCommand): Promise<UploadReservationRecord> {
    const { txRunner, quotas, reservations, capacity, access } = this.deps;
    const budget = UPLOAD_LIMITS.reservationBudgetBytes;

    return txRunner.run(async (tx) => {
      if (command.contextId !== null && command.target.kind === 'workshop' && access
        && !(await access.canManageTarget({
          contextType: command.contextType,
          contextId: command.contextId,
          workshopId: command.target.workshopId,
        }, tx))) {
        throw new BusinessRuleException('RESOURCE_NOT_FOUND');
      }
      await quotas.lockStorageBudget(tx);
      const now = await reservations.databaseNow(tx);
      const quota = await this.lockQuota(command, now, tx);

      if (command.target.kind === 'initial_scope') {
        const groupTotal = await quotas.sumInitialScopeBytes(command.actor.accountId, tx);
        assertFitsWithin(groupTotal, budget, QUOTA_LIMIT_BYTES.initialScope);
      }
      const reservedElsewhere = await quotas.sumReservedBytes(tx);
      if (!hasEnoughFreeSpace(await capacity.measure(), reservedElsewhere, budget)) {
        throw new ServiceUnavailableException('STORAGE_CAPACITY_LOW');
      }

      const reserved: StorageQuotaState = reserveBytes(quota.state, budget);
      await quotas.save({ id: quota.id, state: reserved }, tx);
      return reservations.create({
        quotaId: quota.id,
        uploadedBy: command.actor.accountId,
        contextType: command.contextType,
        contextId: command.contextId,
        budgetBytes: budget,
        storagePrefix: this.prefixFor(command.target),
        expiresAt: new Date(now.getTime() + UPLOAD_LIMITS.reservationLeaseMs),
      }, tx);
    });
  }

  /** Giao dịch 2. */
  private commit(
    command: UploadImageCommand,
    reservation: UploadReservationRecord,
    result: {
      thumbnailKey: string; displayKey: string; thumbnailBytes: bigint; displayBytes: bigint;
      width: number; height: number;
    },
  ): Promise<UploadImageResult> {
    const { txRunner, quotas, reservations, images } = this.deps;

    return txRunner.run(async (tx) => {
      await quotas.lockStorageBudget(tx);
      const now = await reservations.databaseNow(tx);
      const quota = await this.lockQuota(command, now, tx);
      if (quota.id !== reservation.quotaId) throw new MediaDomainError('INVALID_STATE');
      const locked = await reservations.lockById(reservation.id, tx);
      if (locked === null) throw new MediaDomainError('INVALID_STATE');

      // Ném INVALID_STATE nếu hết lease hoặc tác vụ dọn đã nhận quyền: worker cũ không được commit.
      const actualBytes = result.thumbnailBytes + result.displayBytes;
      const committed = commitReservation(locked.state, actualBytes, now);

      await quotas.save({ id: quota.id, state: settleReservation(quota.state, locked.state.budgetBytes, actualBytes) }, tx);
      await reservations.saveState(reservation.id, committed, tx);
      const image = await images.create({
        uploadedBy: command.actor.accountId,
        contextType: command.contextType,
        contextId: command.contextId,
        thumbnailKey: result.thumbnailKey,
        displayKey: result.displayKey,
        thumbnailSizeBytes: result.thumbnailBytes,
        displaySizeBytes: result.displayBytes,
        quotaId: quota.id,
        reservationId: reservation.id,
        width: result.width,
        height: result.height,
        unreferencedAt: now,
      }, tx);
      return {
        imageId: image.id,
        contextType: image.contextType,
        contextId: image.contextId,
        unattachedExpiresAt: new Date(now.getTime() + UPLOAD_LIMITS.unattachedTtlHours * HOUR_MS),
      };
    });
  }

  /**
   * Khóa đúng thứ tự: (Account Admin → scope →) quota. Kiểm tra lại scope mỗi lần khóa
   * vì phạm vi có thể hết hạn giữa hai giao dịch.
   */
  private async lockQuota(command: UploadImageCommand, now: Date, tx: TransactionContext): Promise<StorageQuotaRecord> {
    const { quotas, scopes, admins } = this.deps;
    const { target, actor } = command;

    if (target.kind === 'workshop') {
      return quotas.lockOrCreateWorkshopQuota(target.workshopId, QUOTA_LIMIT_BYTES.workshop, tx);
    }
    await admins.lockAndAssertAdmin(actor, tx);
    const scope = await scopes.lockByKey(target.initialWorkshopKey, tx);
    assertScopeUsable(scope, actor.accountId, now);
    const quota = await quotas.lockScopeQuota(target.initialWorkshopKey, tx);
    if (quota === null) throw new MediaDomainError('UPLOAD_SCOPE_UNAVAILABLE');
    return quota;
  }

  private prefixFor(target: UploadTarget): string {
    const id = (this.deps.newPrefixId ?? randomUUID)();
    return target.kind === 'workshop' ? `w${target.workshopId}/${id}/` : `s${target.initialWorkshopKey}/${id}/`;
  }
}
