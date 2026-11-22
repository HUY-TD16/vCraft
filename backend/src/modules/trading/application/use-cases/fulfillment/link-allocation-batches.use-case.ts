import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
  TrustedActor,
} from '../../../../../common/application/types/contract-types';
import type { ITraceabilityContract } from '../../../../traceability/public/contracts/traceability.contract';
import type { IWorkshopContract } from '../../../../workshops/public/contracts/workshop.contract';
import type {
  AllocationDto,
  TradingCurrentStateDto,
} from '../../dtos/trading-persistence.dtos';
import type {
  IAllocationBatchRepository,
  IAllocationRepository,
  IQuoteRequestRepository,
} from '../../ports/repositories/trading-repositories.port';
import {
  LinkBatchesWorkflow,
  type LinkBatchItemInput,
  type LinkBatchesWorkflowInput,
  type LinkBatchesWorkflowResult,
} from '../../../../../workflows/link-batches/link-batches.workflow';

export type {
  LinkBatchItemInput,
  LinkBatchesWorkflowInput,
  LinkBatchesWorkflowResult,
};

export interface LinkAllocationBatchesInput {
  readonly actor: AuthenticatedActor | TrustedActor;
  readonly allocationId?: Id;
  readonly id?: Id;
  readonly expectedAllocationVersion?: number;
  readonly expected_allocation_version?: number;
  readonly links: readonly LinkBatchItemInput[];
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export interface LinkAllocationBatchesResult {
  readonly allocation: AllocationDto;
  readonly currentState: TradingCurrentStateDto;
}

/**
 * Use Case UC-23 (`BR-05`, `BR-09`, `BR-20`, `BR-24`, `BR-26`, `BR-27`, `SEC-06`):
 * Replaces the list of production batches (`AllocationBatch`) linked to an Artisan's
 * Allocation (`PUT /api/v1/artisan/allocations/:id/batches`) via `LinkBatchesWorkflow`.
 */
export class LinkAllocationBatchesUseCase {
  private readonly workflow: LinkBatchesWorkflow;

  constructor(
    txRunner: TransactionRunner,
    allocationRepo: IAllocationRepository,
    quoteRequestRepo: IQuoteRequestRepository,
    traceabilityContract?: ITraceabilityContract,
    allocationBatchRepo?: IAllocationBatchRepository,
    workshopContract?: IWorkshopContract,
  ) {
    this.workflow = new LinkBatchesWorkflow(
      txRunner,
      allocationRepo,
      quoteRequestRepo,
      traceabilityContract,
      allocationBatchRepo,
      workshopContract,
    );
  }

  async execute(
    input: LinkAllocationBatchesInput,
  ): Promise<LinkAllocationBatchesResult> {
    return this.workflow.execute(input);
  }
}

export { LinkAllocationBatchesUseCase as LinkBatchesUseCase };
