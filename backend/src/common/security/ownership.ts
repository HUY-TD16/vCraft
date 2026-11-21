import type { AuthenticatedActor, TrustedActor } from '../application/types/contract-types';
import { BusinessRuleException, type BusinessRuleCode } from '../domain/errors/business-rule.exception';

export function assertOwnerOrAdmin(
  actor: AuthenticatedActor | TrustedActor,
  ownerAccountId: string | bigint,
  errorCode: BusinessRuleCode = 'PERMISSION_DENIED',
): void {
  if (actor.role === 'admin') return;
  if (String(actor.accountId) !== String(ownerAccountId)) {
    throw new BusinessRuleException(errorCode);
  }
}
