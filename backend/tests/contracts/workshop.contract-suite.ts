import { describe, expect, it } from 'vitest';
import type { IWorkshopContract } from '../../src/modules/workshops/public/contracts/workshop.contract';
import type { TransactionRunner } from '../../src/common/application/ports/transaction-runner';
import type { Id } from '../../src/common/application/types/contract-types';
import { BusinessRuleException } from '../../src/common/domain/errors/business-rule.exception';

export interface WorkshopContractFixture {
  contract: IWorkshopContract;
  runner: TransactionRunner;
  activeId: Id;
  suspendedId: Id;
  missingId: Id;
  dispose(): Promise<void>;
}

export function workshopContractSuite(name: string, setup: () => Promise<WorkshopContractFixture>): void {
  describe(name, () => {
    it('accepts active workshops and preserves missing/suspended error codes', async () => {
      const fixture = await setup();
      try {
        await fixture.runner.run(tx => fixture.contract.lockAndAssertActive([fixture.activeId], tx));
        await expect(fixture.runner.run(tx => fixture.contract.lockAndAssertActive([fixture.missingId], tx)))
          .rejects.toEqual(new BusinessRuleException('RESOURCE_NOT_FOUND'));
        await expect(fixture.runner.run(tx => fixture.contract.lockAndAssertActive([fixture.suspendedId], tx)))
          .rejects.toEqual(new BusinessRuleException('WORKSHOP_SUSPENDED'));
      } finally {
        await fixture.dispose();
      }
    });
  });
}
