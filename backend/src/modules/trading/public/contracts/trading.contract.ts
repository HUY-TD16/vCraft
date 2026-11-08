import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type { Id, TrustedActor } from '../../../../common/application/types/contract-types';
import type { AcceptanceDto, AcceptanceOperationDto } from '../dtos/acceptance.dto';

export const TRADING_CONTRACT = Symbol('TRADING_CONTRACT');

export type AcceptanceInput = {
  requestId: Id;
  expectedRequestVersion: number;
  actor: TrustedActor;
} & (
  | { quoteId: Id; expectedQuoteVersion: number; proposalId?: never; expectedProposalVersion?: never }
  | { proposalId: Id; expectedProposalVersion: number; quoteId?: never; expectedQuoteVersion?: never }
);

export interface ITradingContract {
  findAcceptanceReplay(input: AcceptanceInput & {
    idempotencyKey: string;
  }, tx: TransactionContext): Promise<{ data: AcceptanceDto; operation: AcceptanceOperationDto } | null>;
  expireProposalsForWorkshop(input: {
    workshopId: Id;
    actor: TrustedActor;
  }, tx: TransactionContext): Promise<void>;
  prepareAcceptance(input: AcceptanceInput, tx: TransactionContext): Promise<{ workshopIds: Id[] }>;
  accept(input: AcceptanceInput & {
    idempotencyKey: string;
  }, tx: TransactionContext): Promise<{ data: AcceptanceDto; operation: AcceptanceOperationDto }>;
}
