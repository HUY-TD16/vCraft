import type { Provider } from '@nestjs/common';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../../common/application/ports/transaction-runner';
import {
  WORKSHOP_CONTRACT,
  type IWorkshopContract,
} from '../../workshops/public/contracts/workshop.contract';
import {
  ALLOCATION_REPOSITORY,
  IDEMPOTENCY_RECORD_REPOSITORY,
  QUOTE_REPOSITORY,
  QUOTE_REQUEST_REPOSITORY,
  RECIPIENT_RESPONSE_HISTORY_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
  type IAllocationRepository,
  type IIdempotencyRecordRepository,
  type IQuoteRepository,
  type IQuoteRequestRepository,
  type IRecipientResponseHistoryRepository,
  type IRequestRecipientRepository,
} from '../application/ports/repositories/trading-repositories.port';
import { TradingAcceptanceService } from '../application/services/trading-acceptance.service';
import { AcceptQuoteUseCase } from '../application/use-cases/quotations/accept-quote.use-case';
import { DeclineQuoteRequestUseCase } from '../application/use-cases/quotations/decline-quote-request.use-case';
import { GetRecipientResponseHistoryUseCase } from '../application/use-cases/quotations/get-recipient-response-history.use-case';
import { ListQuoteRequestQuotesUseCase } from '../application/use-cases/quotations/list-quote-request-quotes.use-case';
import { SubmitQuoteUseCase } from '../application/use-cases/quotations/submit-quote.use-case';
import { WithdrawQuoteUseCase } from '../application/use-cases/quotations/withdraw-quote.use-case';
import {
  TRADING_CONTRACT,
  type ITradingContract,
} from '../public/contracts/trading.contract';

export const TRADING_QUOTATION_PROVIDERS: Provider[] = [
  {
    provide: DeclineQuoteRequestUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      quoteRequestRepo: IQuoteRequestRepository,
      recipientRepo: IRequestRecipientRepository,
      quoteRepo: IQuoteRepository,
      workshopContract?: IWorkshopContract,
    ) => {
      return new DeclineQuoteRequestUseCase(
        txRunner,
        quoteRequestRepo,
        recipientRepo,
        quoteRepo,
        workshopContract,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      QUOTE_REQUEST_REPOSITORY,
      REQUEST_RECIPIENT_REPOSITORY,
      QUOTE_REPOSITORY,
      { token: WORKSHOP_CONTRACT, optional: true },
    ],
  },
  {
    provide: SubmitQuoteUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      quoteRequestRepo: IQuoteRequestRepository,
      recipientRepo: IRequestRecipientRepository,
      quoteRepo: IQuoteRepository,
      workshopContract?: IWorkshopContract,
    ) => {
      return new SubmitQuoteUseCase(
        txRunner,
        quoteRequestRepo,
        recipientRepo,
        quoteRepo,
        workshopContract,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      QUOTE_REQUEST_REPOSITORY,
      REQUEST_RECIPIENT_REPOSITORY,
      QUOTE_REPOSITORY,
      { token: WORKSHOP_CONTRACT, optional: true },
    ],
  },
  {
    provide: WithdrawQuoteUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      quoteRequestRepo: IQuoteRequestRepository,
      recipientRepo: IRequestRecipientRepository,
      quoteRepo: IQuoteRepository,
      workshopContract?: IWorkshopContract,
    ) => {
      return new WithdrawQuoteUseCase(
        txRunner,
        quoteRequestRepo,
        recipientRepo,
        quoteRepo,
        workshopContract,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      QUOTE_REQUEST_REPOSITORY,
      REQUEST_RECIPIENT_REPOSITORY,
      QUOTE_REPOSITORY,
      { token: WORKSHOP_CONTRACT, optional: true },
    ],
  },
  {
    provide: ListQuoteRequestQuotesUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      quoteRequestRepo: IQuoteRequestRepository,
      recipientRepo: IRequestRecipientRepository,
      quoteRepo: IQuoteRepository,
    ) => {
      return new ListQuoteRequestQuotesUseCase(
        txRunner,
        quoteRequestRepo,
        recipientRepo,
        quoteRepo,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      QUOTE_REQUEST_REPOSITORY,
      REQUEST_RECIPIENT_REPOSITORY,
      QUOTE_REPOSITORY,
    ],
  },
  {
    provide: GetRecipientResponseHistoryUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      quoteRequestRepo: IQuoteRequestRepository,
      recipientRepo: IRequestRecipientRepository,
      recipientResponseHistoryRepo: IRecipientResponseHistoryRepository,
    ) => {
      return new GetRecipientResponseHistoryUseCase(
        txRunner,
        quoteRequestRepo,
        recipientRepo,
        recipientResponseHistoryRepo,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      QUOTE_REQUEST_REPOSITORY,
      REQUEST_RECIPIENT_REPOSITORY,
      RECIPIENT_RESPONSE_HISTORY_REPOSITORY,
    ],
  },
  {
    provide: TradingAcceptanceService,
    useFactory: (
      quoteRequestRepo: IQuoteRequestRepository,
      recipientRepo: IRequestRecipientRepository,
      quoteRepo: IQuoteRepository,
      allocationRepo: IAllocationRepository,
      idempotencyRepo: IIdempotencyRecordRepository,
      workshopContract?: IWorkshopContract,
    ) => {
      return new TradingAcceptanceService(
        quoteRequestRepo,
        recipientRepo,
        quoteRepo,
        allocationRepo,
        idempotencyRepo,
        workshopContract,
      );
    },
    inject: [
      QUOTE_REQUEST_REPOSITORY,
      REQUEST_RECIPIENT_REPOSITORY,
      QUOTE_REPOSITORY,
      ALLOCATION_REPOSITORY,
      IDEMPOTENCY_RECORD_REPOSITORY,
      { token: WORKSHOP_CONTRACT, optional: true },
    ],
  },
  {
    provide: TRADING_CONTRACT,
    useExisting: TradingAcceptanceService,
  },
  {
    provide: AcceptQuoteUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      tradingContract: ITradingContract,
      workshopContract?: IWorkshopContract,
    ) => {
      return new AcceptQuoteUseCase(
        txRunner,
        tradingContract,
        workshopContract,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      TRADING_CONTRACT,
      { token: WORKSHOP_CONTRACT, optional: true },
    ],
  },
];

export const TRADING_QUOTATION_EXPORTS = [
  DeclineQuoteRequestUseCase,
  GetRecipientResponseHistoryUseCase,
  ListQuoteRequestQuotesUseCase,
  SubmitQuoteUseCase,
  WithdrawQuoteUseCase,
  AcceptQuoteUseCase,
  TradingAcceptanceService,
  TRADING_CONTRACT,
];
