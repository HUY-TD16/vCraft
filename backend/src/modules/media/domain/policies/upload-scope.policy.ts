import { BusinessRuleException } from '../../../../common/domain/errors/business-rule.exception';

export type UploadScopeStatus = 'open' | 'attached' | 'expired';

export interface UploadScopeState {
  readonly createdBy: string;
  readonly status: UploadScopeStatus;
  readonly expiresAt: Date;
}

/**
 * API 8.1: khóa không tồn tại hoặc thuộc Admin khác → 404; hết hạn hoặc đã dùng → 422.
 * Hạn được kiểm tra theo giờ DB (`now`) dù tác vụ đổi open → expired chưa chạy.
 */
export function assertScopeUsable(scope: UploadScopeState | null, adminId: string, now: Date): void {
  if (scope === null || scope.createdBy !== adminId) throw new BusinessRuleException('RESOURCE_NOT_FOUND');
  if (scope.status !== 'open' || now.getTime() >= scope.expiresAt.getTime()) {
    throw new BusinessRuleException('UPLOAD_SCOPE_UNAVAILABLE');
  }
}
