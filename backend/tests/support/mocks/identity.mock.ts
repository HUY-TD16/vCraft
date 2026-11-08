import type { IIdentityContract } from '../../../src/modules/identity/public/contracts/identity.contract';
import { unconfigured } from './unconfigured';

export class MockIdentityContract implements IIdentityContract {
  readonly resolveSession = unconfigured<IIdentityContract['resolveSession']>('IIdentityContract.resolveSession');
  readonly lockAndAssertAdmin = unconfigured<IIdentityContract['lockAndAssertAdmin']>('IIdentityContract.lockAndAssertAdmin');
  readonly createArtisan = unconfigured<IIdentityContract['createArtisan']>('IIdentityContract.createArtisan');
}
