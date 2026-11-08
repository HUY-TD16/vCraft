import { workshopContractSuite } from './workshop.contract-suite';
import { MockWorkshopContract } from '../support/mocks/workshop.mock';
import { MockTransactionRunner } from '../support/mocks/transaction-runner.mock';

workshopContractSuite('Workshop mock contract', async () => ({
  contract: new MockWorkshopContract().givenActiveWorkshops('1').givenSuspended('2'),
  runner: new MockTransactionRunner(),
  activeId: '1',
  suspendedId: '2',
  missingId: '3',
  dispose: async () => {},
}));
