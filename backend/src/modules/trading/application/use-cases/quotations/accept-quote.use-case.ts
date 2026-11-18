import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
  TrustedActor,
} from '../../../../../common/application/types/contract-types';
import type { IWorkshopContract } from '../../../../workshops/public/contracts/workshop.contract';
import type { ITradingContract } from '../../../public/contracts/trading.contract';
import type {
  AcceptanceDto,
  AcceptanceOperationDto,
} from '../../../public/dtos/acceptance.dto';
import type { TradingCurrentStateDto } from '../../dtos/trading-persistence.dtos';
import {
  AcceptQuotationWorkflow,
  type AcceptQuotationWorkflowInput,
} from '../../../../../workflows/accept-quotation/accept-quotation.workflow';

export interface AcceptQuoteInput {
  readonly actor: TrustedActor | AuthenticatedActor;
  readonly requestId?: Id;
  readonly id?: Id;
  readonly quoteId?: Id;
  readonly quote_id?: Id;
  readonly expectedRequestVersion?: number;
  readonly expected_request_version?: number;
  readonly expectedQuoteVersion?: number;
  readonly expected_quote_version?: number;
  readonly idempotencyKey?: string;
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export interface AcceptQuoteResult {
  readonly data: AcceptanceDto;
  readonly result: AcceptanceDto;
  readonly currentState: TradingCurrentStateDto;
  readonly operation?: AcceptanceOperationDto;
}

/**
 * Use Case UC-19 (`BR-16`, `BR-20`, `BR-27`, `SEC-06`, `SEC-13`):
 * Allows the Buyer owner of a QuoteRequest in `artisans_bidding` to directly accept
 * a single eligible quote covering 100% of the requested quantity in a single atomic transaction.
 */
export class AcceptQuoteUseCase {
  private readonly workflow: AcceptQuotationWorkflow;

  constructor(
    txRunner: TransactionRunner,
    tradingContract: ITradingContract,
    workshopContract?: IWorkshopContract,
  ) {
    this.workflow = new AcceptQuotationWorkflow(
      txRunner,
      tradingContract,
      workshopContract,
    );
  }

  async execute(input: AcceptQuoteInput): Promise<AcceptQuoteResult> {
    const workflowInput: AcceptQuotationWorkflowInput = {
      actor: input.actor,
      requestId: (input.requestId ?? input.id) as Id,
      quoteId: (input.quoteId ?? input.quote_id) as Id,
      expectedRequestVersion: (input.expectedRequestVersion ??
        input.expected_request_version) as number,
      expectedQuoteVersion: (input.expectedQuoteVersion ??
        input.expected_quote_version) as number,
      idempotencyKey: input.idempotencyKey,
      now: input.now,
      tx: input.tx,
    };

    const output = await this.workflow.execute(workflowInput);
    return {
      data: output.data,
      result: output.data,
      currentState: output.currentState,
      ...(output.operation ? { operation: output.operation } : {}),
    };
  }
}
