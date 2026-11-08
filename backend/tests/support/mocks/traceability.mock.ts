import type { ITraceabilityContract } from '../../../src/modules/traceability/public/contracts/traceability.contract';
import { unconfigured } from './unconfigured';

export class MockTraceabilityContract implements ITraceabilityContract {
  readonly assertBatch = unconfigured<ITraceabilityContract['assertBatch']>('ITraceabilityContract.assertBatch');
  readonly assertOwnedBatches = unconfigured<ITraceabilityContract['assertOwnedBatches']>('ITraceabilityContract.assertOwnedBatches');
  readonly getJournalImageAccess = unconfigured<ITraceabilityContract['getJournalImageAccess']>('ITraceabilityContract.getJournalImageAccess');
}
