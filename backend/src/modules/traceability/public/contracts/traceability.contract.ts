import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type { Id, TrustedActor } from '../../../../common/application/types/contract-types';

export const TRACEABILITY_CONTRACT = Symbol('TRACEABILITY_CONTRACT');

export interface ITraceabilityContract {
  assertBatch(input: {
    batchId: Id;
    workshopId: Id;
    requirePublished: boolean;
  }, tx: TransactionContext): Promise<{ id: Id; workshopId: Id; status: 'draft' | 'published' }>;
  assertOwnedBatches(input: {
    batchIds: readonly Id[];
    workshopId: Id;
  }, tx: TransactionContext): Promise<Array<{
    id: Id;
    name: string;
    status: 'draft' | 'published';
    traceUrl: string | null;
  }>>;
  getJournalImageAccess(input: {
    entryId: Id;
    imageId: Id;
    historyId: Id | null;
    actorOrNull: TrustedActor | null;
  }, tx: TransactionContext): Promise<{ canRead: boolean }>;
}
