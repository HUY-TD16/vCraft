import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  Id,
  TrustedActor,
} from '../../../../../common/application/types/contract-types';
import type { ICatalogContract } from '../../../../catalog/public/contracts/catalog.contract';
import type { IWorkshopContract } from '../../../../workshops/public/contracts/workshop.contract';
import type {
  IQuoteRequestRepository,
  IRequestRecipientRepository,
} from '../../ports/repositories/trading-repositories.port';
import type { QuoteRequest } from '../../../domain';
import {
  SendRequestWorkflow,
  type SendQuoteRequestInput,
} from '../../../../../workflows/send-request/send-request.workflow';

export type { SendQuoteRequestInput };

export class SendQuoteRequestUseCase {
  private readonly workflow: SendRequestWorkflow;

  constructor(
    txRunner: TransactionRunner,
    quoteRequestRepo: IQuoteRequestRepository,
    recipientRepo: IRequestRecipientRepository,
    catalogContract?: ICatalogContract,
    workshopContract?: IWorkshopContract,
  ) {
    this.workflow = new SendRequestWorkflow(
      txRunner,
      quoteRequestRepo,
      recipientRepo,
      catalogContract,
      workshopContract,
    );
  }

  async execute(input: SendQuoteRequestInput): Promise<QuoteRequest> {
    return this.workflow.execute(input);
  }
}
