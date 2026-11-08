import type { ICatalogContract } from '../../../src/modules/catalog/public/contracts/catalog.contract';
import { unconfigured } from './unconfigured';
import type { Id } from '../../../src/common/application/types/contract-types';
import { BusinessRuleException } from '../../../src/common/domain/errors/business-rule.exception';

export class MockCatalogContract implements ICatalogContract {
  private readonly eligible = new Map<Id, Id[]>();

  givenEligibleWorkshops(categoryId: Id, ...workshopIds: Id[]): this {
    const ids = [...new Set(workshopIds)].sort((left, right) => {
      const a = BigInt(left);
      const b = BigInt(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    this.eligible.set(categoryId, ids);
    this.findEligibleWorkshopIds.mockImplementation(async input => {
      const eligible = this.eligible.get(input.categoryId);
      if (!eligible) throw new Error('Configure category eligibility before calling');
      return [...eligible];
    });
    this.assertEligibleWorkshops.mockImplementation(async input => {
      const eligible = this.eligible.get(input.categoryId);
      if (!eligible) throw new Error('Configure category eligibility before calling');
      if (input.workshopIds.some(id => !eligible.includes(id))) {
        throw new BusinessRuleException('NO_ELIGIBLE_WORKSHOP');
      }
    });
    return this;
  }

  readonly findEligibleWorkshopIds = unconfigured<ICatalogContract['findEligibleWorkshopIds']>('ICatalogContract.findEligibleWorkshopIds');
  readonly assertEligibleWorkshops = unconfigured<ICatalogContract['assertEligibleWorkshops']>('ICatalogContract.assertEligibleWorkshops');
  readonly getProductImageAccess = unconfigured<ICatalogContract['getProductImageAccess']>('ICatalogContract.getProductImageAccess');
}
