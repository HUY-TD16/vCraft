import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type { Id, Instant, TrustedActor } from '../../../../common/application/types/contract-types';

export const IDENTITY_CONTRACT = Symbol('IDENTITY_CONTRACT');

export interface IIdentityContract {
  resolveSession(sessionToken: string): Promise<(TrustedActor & {
    sessionLevel: 'normal' | 'temp_password';
  }) | null>;
  lockAndAssertAdmin(actor: TrustedActor, tx: TransactionContext): Promise<void>;
  createArtisan(input: {
    username: string;
    passwordHash: string;
    tempPasswordExpiresAt: Instant;
    actor: TrustedActor;
  }, tx: TransactionContext): Promise<{ accountId: Id; username: string }>;
}
