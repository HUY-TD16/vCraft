import {
  BusinessRuleException,
  type BusinessRuleCode,
  type BusinessRuleDetails,
} from '../../../../common/domain/errors/business-rule.exception';

/** Business codes owned by Media; the shared exception keeps HTTP error mapping consistent across modules. */
export type MediaDomainErrorCode = Extract<BusinessRuleCode,
  | 'INVALID_IMAGE_FORMAT'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'UPLOAD_SCOPE_LIMIT_EXCEEDED'
  | 'UPLOAD_SCOPE_BUSY'
  | 'IMAGE_CONTEXT_MISMATCH'
  | 'UPLOAD_SCOPE_UNAVAILABLE'
  | 'INVALID_STATE'
>;

export class MediaDomainError extends BusinessRuleException {
  constructor(code: MediaDomainErrorCode, details: BusinessRuleDetails = {}) {
    super(code, code, details);
  }
}
