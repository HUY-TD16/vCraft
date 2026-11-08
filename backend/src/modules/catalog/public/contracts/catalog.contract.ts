import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type { Id, TrustedActor } from '../../../../common/application/types/contract-types';

export const CATALOG_CONTRACT = Symbol('CATALOG_CONTRACT');

export interface ICatalogContract {
  findEligibleWorkshopIds(input: { categoryId: Id }, tx: TransactionContext): Promise<Id[]>;
  assertEligibleWorkshops(input: {
    categoryId: Id;
    workshopIds: readonly Id[];
  }, tx: TransactionContext): Promise<void>;
  getProductImageAccess(input: {
    productId: Id;
    imageId: Id;
    actorOrNull: TrustedActor | null;
  }, tx: TransactionContext): Promise<{ canRead: boolean }>;
}
