import { HttpException } from '@nestjs/common';
import type { BusinessRuleCode } from '../../domain/errors/business-rule.exception';

export const statusByCode = {
  INVALID_INPUT: 400, INVALID_IMAGE_FORMAT: 400,
  AUTHENTICATION_REQUIRED: 401, SESSION_EXPIRED: 401, INVALID_CREDENTIALS: 401,
  PERMISSION_DENIED: 403, TEMP_PASSWORD_RESTRICTED: 403, CSRF_INVALID: 403,
  RESOURCE_NOT_FOUND: 404,
  CONCURRENCY_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, USERNAME_TAKEN: 409, NAME_TAKEN: 409,
  STORAGE_QUOTA_EXCEEDED: 409, UPLOAD_SCOPE_LIMIT_EXCEEDED: 409, UPLOAD_SCOPE_BUSY: 409,
  PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415,
  QUOTE_EXPIRED: 422, WORKSHOP_SUSPENDED: 422, DEADLINE_VIOLATION: 422, INVALID_STATE: 422,
  BIDDING_CLOSED: 422, NO_ELIGIBLE_WORKSHOP: 422, INSUFFICIENT_CAPACITY: 422,
  RESOURCE_IN_USE: 422, IMAGE_CONTEXT_MISMATCH: 422, UPLOAD_SCOPE_UNAVAILABLE: 422,
  RATE_LIMIT_EXCEEDED: 429, INTERNAL_SERVER_ERROR: 500,
  SECURITY_SERVICE_UNAVAILABLE: 503, STORAGE_CAPACITY_LOW: 503, IMAGE_PROCESSING_UNAVAILABLE: 503,
} as const satisfies Record<BusinessRuleCode, number> & Record<string, number>;

type Code = keyof typeof statusByCode;

export class ApiProblem extends HttpException {
  readonly code: Code;
  readonly retryAfter?: number;

  constructor(...args: [Exclude<Code, 'RATE_LIMIT_EXCEEDED'>] | ['RATE_LIMIT_EXCEEDED', number]) {
    const [code, retryAfter] = args;
    super(code, statusByCode[code]);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
