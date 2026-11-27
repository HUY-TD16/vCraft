import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type { TrustedActor } from '../../../../common/application/types/contract-types';

/** Khớp chữ ký IIdentityContract.lockAndAssertAdmin (docs/contracts/backend.md): khóa Account Admin và kiểm tra lại phiên/quyền. */
export interface AdminAssertion {
  lockAndAssertAdmin(actor: TrustedActor, tx: TransactionContext): Promise<void>;
}
