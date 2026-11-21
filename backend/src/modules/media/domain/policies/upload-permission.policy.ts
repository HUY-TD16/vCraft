import type { Role } from '../../../../common/application/types/contract-types';
import { BusinessRuleException } from '../../../../common/domain/errors/business-rule.exception';
import type { ImageContextType } from '../value-objects/image-context';

export interface Uploader {
  readonly role: Role;
  readonly workshopId: string | null;
}

/** Đích upload: nội dung của một hộ, hoặc phạm vi ảnh khởi tạo hộ (Admin, UC-03). */
export type UploadTarget =
  | { readonly kind: 'workshop'; readonly workshopId: string }
  | { readonly kind: 'initial_scope'; readonly initialWorkshopKey: string };

/**
 * API 8.1: Buyer không upload; Artisan chỉ tải cho hộ MÌNH; Admin chỉ tải ảnh hồ sơ
 * trong luồng cấp hộ. Hộ suspended VẪN được upload (vẫn tạo lô, ghi nhật ký).
 */
export function assertCanUpload(uploader: Uploader, contextType: ImageContextType, target: UploadTarget): void {
  switch (uploader.role) {
    case 'buyer':
      throw new BusinessRuleException('PERMISSION_DENIED');
    case 'artisan':
      if (target.kind !== 'workshop' || uploader.workshopId === null || target.workshopId !== uploader.workshopId) {
        throw new BusinessRuleException('PERMISSION_DENIED');
      }
      return;
    case 'admin':
      if (target.kind !== 'initial_scope') throw new BusinessRuleException('PERMISSION_DENIED');
      if (contextType !== 'workshop_profile') {
        throw new BusinessRuleException('INVALID_INPUT', 'INVALID_INPUT', { field: 'context_type' });
      }
      return;
  }
}
