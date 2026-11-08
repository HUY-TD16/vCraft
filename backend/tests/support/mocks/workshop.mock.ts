import type { IWorkshopContract } from '../../../src/modules/workshops/public/contracts/workshop.contract';
import { unconfigured } from './unconfigured';
import type { Id } from '../../../src/common/application/types/contract-types';
import { BusinessRuleException } from '../../../src/common/domain/errors/business-rule.exception';

export class MockWorkshopContract implements IWorkshopContract {
  private readonly statuses = new Map<Id, 'active' | 'suspended'>();

  givenActiveWorkshops(...ids: Id[]): this {
    return this.givenStatus('active', ids);
  }

  givenSuspended(...ids: Id[]): this {
    return this.givenStatus('suspended', ids);
  }

  private givenStatus(status: 'active' | 'suspended', ids: Id[]): this {
    for (const id of ids) this.statuses.set(id, status);
    this.lockAndAssertActive.mockImplementation(async workshopIds => {
      for (const id of workshopIds) {
        if (!this.statuses.has(id)) throw new BusinessRuleException('RESOURCE_NOT_FOUND');
      }
      if (workshopIds.some(id => this.statuses.get(id) === 'suspended')) {
        throw new BusinessRuleException('WORKSHOP_SUSPENDED');
      }
    });
    return this;
  }

  readonly lockAndAssertActive = unconfigured<IWorkshopContract['lockAndAssertActive']>('IWorkshopContract.lockAndAssertActive');
  readonly getWorkshopSummary = unconfigured<IWorkshopContract['getWorkshopSummary']>('IWorkshopContract.getWorkshopSummary');
  readonly createWorkshop = unconfigured<IWorkshopContract['createWorkshop']>('IWorkshopContract.createWorkshop');
  readonly changeStatus = unconfigured<IWorkshopContract['changeStatus']>('IWorkshopContract.changeStatus');
  readonly getProfileImageAccess = unconfigured<IWorkshopContract['getProfileImageAccess']>('IWorkshopContract.getProfileImageAccess');
}
