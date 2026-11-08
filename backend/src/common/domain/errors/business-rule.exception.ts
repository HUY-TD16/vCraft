export type BusinessRuleCode =
  | 'INVALID_INPUT' | 'INVALID_IMAGE_FORMAT'
  | 'AUTHENTICATION_REQUIRED' | 'SESSION_EXPIRED' | 'INVALID_CREDENTIALS'
  | 'PERMISSION_DENIED' | 'TEMP_PASSWORD_RESTRICTED' | 'CSRF_INVALID'
  | 'RESOURCE_NOT_FOUND'
  | 'CONCURRENCY_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'USERNAME_TAKEN' | 'NAME_TAKEN'
  | 'STORAGE_QUOTA_EXCEEDED' | 'UPLOAD_SCOPE_LIMIT_EXCEEDED' | 'UPLOAD_SCOPE_BUSY'
  | 'QUOTE_EXPIRED' | 'WORKSHOP_SUSPENDED' | 'DEADLINE_VIOLATION' | 'INVALID_STATE'
  | 'BIDDING_CLOSED' | 'NO_ELIGIBLE_WORKSHOP' | 'INSUFFICIENT_CAPACITY'
  | 'RESOURCE_IN_USE' | 'IMAGE_CONTEXT_MISMATCH' | 'UPLOAD_SCOPE_UNAVAILABLE';

export type BusinessRuleDetail = string | number | boolean | null;
export type BusinessRuleDetails = Readonly<Record<string, BusinessRuleDetail | readonly BusinessRuleDetail[]>>;

export class BusinessRuleException extends Error {
  readonly details: BusinessRuleDetails;

  constructor(
    readonly code: BusinessRuleCode,
    message: string = code,
    details: BusinessRuleDetails = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.details = Object.freeze(Object.fromEntries(
      Object.entries(details).map(([key, value]) => [key, Array.isArray(value) ? Object.freeze([...value]) : value]),
    ));
  }
}
