import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type { Id, TrustedActor } from '../../../../common/application/types/contract-types';
import type {
  AcceptanceCurrentStateDto,
  AcceptanceDto,
  AcceptanceOperationDto,
} from '../dtos/acceptance.dto';

export const TRADING_CONTRACT = Symbol('TRADING_CONTRACT');

export interface AcceptanceInput {
  requestId: Id;
  expectedRequestVersion: number;
  actor: TrustedActor;
  quoteId: Id;
  expectedQuoteVersion: number;
}

export interface AcceptanceExecutionOptions {
  readonly expectedWorkshopId?: Id;
  readonly now?: Date;
}

export interface ITradingContract {
  findAcceptanceReplay(input: AcceptanceInput & {
    idempotencyKey: string;
  }, tx: TransactionContext): Promise<{ data: AcceptanceDto; operation: AcceptanceOperationDto } | null>;
  prepareAcceptance(input: AcceptanceInput, tx: TransactionContext): Promise<{ workshopIds: Id[] }>;
  accept(
    input: AcceptanceInput & {
      idempotencyKey: string;
    },
    tx: TransactionContext,
    options?: AcceptanceExecutionOptions,
  ): Promise<{ data: AcceptanceDto; operation: AcceptanceOperationDto }>;
  executeAcceptance?(
    input: AcceptanceInput & AcceptanceExecutionOptions,
    tx: TransactionContext,
  ): Promise<{ data: AcceptanceDto; currentState: AcceptanceCurrentStateDto }>;
}
