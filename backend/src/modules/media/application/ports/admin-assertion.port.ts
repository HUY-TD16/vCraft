import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type { TrustedActor } from '../../../../common/application/types/contract-types';

export const ADMIN_ASSERTION = Symbol('ADMIN_ASSERTION');

/** Khớp chữ ký IIdentityContract.lockAndAssertAdmin (docs/contracts/backend.md): khóa Account Admin và kiểm tra lại phiên/quyền. */
export interface AdminAssertion {
  lockAndAssertAdmin(actor: TrustedActor, tx: TransactionContext): Promise<void>;
}
