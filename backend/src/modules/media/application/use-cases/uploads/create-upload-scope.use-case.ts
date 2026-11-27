import type { TransactionRunner } from '../../../../../common/application/ports/transaction-runner';
import { BusinessRuleException } from '../../../../../common/domain/errors/business-rule.exception';
import { MediaDomainError } from '../../../domain/errors/media-domain.error';
import { QUOTA_LIMIT_BYTES, UPLOAD_LIMITS } from '../../../domain/value-objects/image-limits';
import type { AdminAssertion } from '../../ports/admin-assertion.port';
import type { IUploadReservationRepository, IUploadScopeRepository } from '../../ports/repositories/media-repositories.port';
import type { CreateUploadScopeCommand, UploadScopeResult } from '../../dtos/media-use-case.dtos';

export type { CreateUploadScopeCommand, UploadScopeResult } from '../../dtos/media-use-case.dtos';

export interface CreateUploadScopeDependencies {
  readonly txRunner: TransactionRunner;
  readonly scopes: IUploadScopeRepository;
  readonly reservations: IUploadReservationRepository;
  readonly admins: AdminAssertion;
}

/**
 * Admin xin một phạm vi upload để tải ảnh hồ sơ trước khi cấp hộ (UC-03, API 8.1).
 * Khóa Account Admin trước khi đếm để hai yêu cầu đồng thời không cùng vượt giới hạn 3 phạm vi.
 */
export class CreateUploadScopeUseCase {
  constructor(private readonly deps: CreateUploadScopeDependencies) {}

  async execute(command: CreateUploadScopeCommand): Promise<UploadScopeResult> {
    const { txRunner, scopes, reservations, admins } = this.deps;
    const { actor } = command;
    if (actor.role !== 'admin') throw new BusinessRuleException('PERMISSION_DENIED');

    return txRunner.run(async (tx) => {
      await admins.lockAndAssertAdmin(actor, tx);
      const now = await reservations.databaseNow(tx);
      const open = await scopes.countOpenUnexpired(actor.accountId, now, tx);
      if (open >= UPLOAD_LIMITS.maxOpenInitialScopesPerAdmin) {
        throw new MediaDomainError('UPLOAD_SCOPE_LIMIT_EXCEEDED');
      }
      const created = await scopes.create({
        adminId: actor.accountId,
        expiresAt: new Date(now.getTime() + UPLOAD_LIMITS.initialScopeTtlHours * 60 * 60 * 1000),
        quotaLimitBytes: QUOTA_LIMIT_BYTES.initialScope,
      }, tx);
      return { initialWorkshopKey: created.initialWorkshopKey, expiresAt: created.expiresAt };
    });
  }
}
