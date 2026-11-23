import type { Provider } from '@nestjs/common';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../../common/application/ports/transaction-runner';
import {
  CATALOG_CONTRACT,
  type ICatalogContract,
} from '../../catalog/public/contracts/catalog.contract';
import {
  WORKSHOP_CONTRACT,
  type IWorkshopContract,
} from '../../workshops/public/contracts/workshop.contract';
import {
  ALLOCATION_REPOSITORY,
  CONTACT_EDIT_HISTORY_REPOSITORY,
  QUOTE_REQUEST_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
  STATUS_LOG_REPOSITORY,
  type IAllocationRepository,
  type IContactEditHistoryRepository,
  type IQuoteRequestRepository,
  type IRequestRecipientRepository,
  type IStatusLogRepository,
} from '../application/ports/repositories/trading-repositories.port';
import { CancelQuoteRequestByAdminUseCase } from '../application/use-cases/requests/cancel-quote-request-by-admin.use-case';
import { CancelQuoteRequestByBuyerUseCase } from '../application/use-cases/requests/cancel-quote-request-by-buyer.use-case';
import { CloseBiddingUseCase } from '../application/use-cases/requests/close-bidding.use-case';
import { CopyQuoteRequestUseCase } from '../application/use-cases/requests/copy-quote-request.use-case';
import { CreateDraftQuoteRequestUseCase } from '../application/use-cases/requests/create-draft-quote-request.use-case';
import { DeleteDraftQuoteRequestUseCase } from '../application/use-cases/requests/delete-draft-quote-request.use-case';
import { GetContactHistoryUseCase } from '../application/use-cases/requests/get-contact-history.use-case';
import { GetQuoteRequestByIdUseCase } from '../application/use-cases/requests/get-quote-request-by-id.use-case';
import { GetStatusHistoryUseCase } from '../application/use-cases/requests/get-status-history.use-case';
import { ListAdminQuoteRequestsUseCase } from '../application/use-cases/requests/list-admin-quote-requests.use-case';
import { ListArtisanQuoteRequestsUseCase } from '../application/use-cases/requests/list-artisan-quote-requests.use-case';
import { ListBuyerQuoteRequestsUseCase } from '../application/use-cases/requests/list-buyer-quote-requests.use-case';
import { ListQuoteRequestRecipientsUseCase } from '../application/use-cases/requests/list-quote-request-recipients.use-case';
import { SendQuoteRequestUseCase } from '../application/use-cases/requests/send-quote-request.use-case';
import { UpdateDraftQuoteRequestUseCase } from '../application/use-cases/requests/update-draft-quote-request.use-case';
import { UpdateRecipientContactUseCase } from '../application/use-cases/requests/update-recipient-contact.use-case';

export const TRADING_REQUEST_PROVIDERS: Provider[] = [
  {
    provide: CreateDraftQuoteRequestUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      repo: IQuoteRequestRepository,
    ) => {
      return new CreateDraftQuoteRequestUseCase(txRunner, repo);
    },
    inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
  },
  {
    provide: UpdateDraftQuoteRequestUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      repo: IQuoteRequestRepository,
    ) => {
      return new UpdateDraftQuoteRequestUseCase(txRunner, repo);
    },
    inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
  },
  {
    provide: DeleteDraftQuoteRequestUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      repo: IQuoteRequestRepository,
    ) => {
      return new DeleteDraftQuoteRequestUseCase(txRunner, repo);
    },
    inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
  },
  {
    provide: CopyQuoteRequestUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      repo: IQuoteRequestRepository,
    ) => {
      return new CopyQuoteRequestUseCase(txRunner, repo);
    },
    inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
  },
  {
    provide: UpdateRecipientContactUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      repo: IQuoteRequestRepository,
    ) => {
      return new UpdateRecipientContactUseCase(txRunner, repo);
    },
    inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
  },
  {
    provide: CloseBiddingUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      repo: IQuoteRequestRepository,
    ) => {
      return new CloseBiddingUseCase(txRunner, repo);
    },
    inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
  },
  {
    provide: SendQuoteRequestUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      quoteRequestRepo: IQuoteRequestRepository,
      recipientRepo: IRequestRecipientRepository,
      catalogContract?: ICatalogContract,
      workshopContract?: IWorkshopContract,
    ) => {
      return new SendQuoteRequestUseCase(
        txRunner,
        quoteRequestRepo,
        recipientRepo,
        catalogContract,
        workshopContract,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      QUOTE_REQUEST_REPOSITORY,
      REQUEST_RECIPIENT_REPOSITORY,
      { token: CATALOG_CONTRACT, optional: true },
      { token: WORKSHOP_CONTRACT, optional: true },
    ],
  },
  {
    provide: ListBuyerQuoteRequestsUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      repo: IQuoteRequestRepository,
    ) => {
      return new ListBuyerQuoteRequestsUseCase(txRunner, repo);
    },
    inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
  },
  {
    provide: ListArtisanQuoteRequestsUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      repo: IQuoteRequestRepository,
    ) => {
      return new ListArtisanQuoteRequestsUseCase(txRunner, repo);
    },
    inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
  },
  {
    provide: ListAdminQuoteRequestsUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      repo: IQuoteRequestRepository,
    ) => {
      return new ListAdminQuoteRequestsUseCase(txRunner, repo);
    },
    inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
  },
  {
    provide: GetQuoteRequestByIdUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      repo: IQuoteRequestRepository,
    ) => {
      return new GetQuoteRequestByIdUseCase(txRunner, repo);
    },
    inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
  },
  {
    provide: ListQuoteRequestRecipientsUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      quoteRequestRepo: IQuoteRequestRepository,
      recipientRepo: IRequestRecipientRepository,
    ) => {
      return new ListQuoteRequestRecipientsUseCase(
        txRunner,
        quoteRequestRepo,
        recipientRepo,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      QUOTE_REQUEST_REPOSITORY,
      REQUEST_RECIPIENT_REPOSITORY,
    ],
  },
  {
    provide: GetContactHistoryUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      quoteRequestRepo: IQuoteRequestRepository,
      contactEditHistoryRepo: IContactEditHistoryRepository,
      allocationRepo: IAllocationRepository,
    ) => {
      return new GetContactHistoryUseCase(
        txRunner,
        quoteRequestRepo,
        contactEditHistoryRepo,
        allocationRepo,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      QUOTE_REQUEST_REPOSITORY,
      CONTACT_EDIT_HISTORY_REPOSITORY,
      ALLOCATION_REPOSITORY,
    ],
  },
  {
    provide: GetStatusHistoryUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      quoteRequestRepo: IQuoteRequestRepository,
      statusLogRepo: IStatusLogRepository,
    ) => {
      return new GetStatusHistoryUseCase(
        txRunner,
        quoteRequestRepo,
        statusLogRepo,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      QUOTE_REQUEST_REPOSITORY,
      STATUS_LOG_REPOSITORY,
    ],
  },
  {
    provide: CancelQuoteRequestByBuyerUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      quoteRequestRepo: IQuoteRequestRepository,
    ) => {
      return new CancelQuoteRequestByBuyerUseCase(txRunner, quoteRequestRepo);
    },
    inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
  },
  {
    provide: CancelQuoteRequestByAdminUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      quoteRequestRepo: IQuoteRequestRepository,
    ) => {
      return new CancelQuoteRequestByAdminUseCase(txRunner, quoteRequestRepo);
    },
    inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
  },
];

export const TRADING_REQUEST_EXPORTS = [
  CreateDraftQuoteRequestUseCase,
  UpdateDraftQuoteRequestUseCase,
  DeleteDraftQuoteRequestUseCase,
  CopyQuoteRequestUseCase,
  UpdateRecipientContactUseCase,
  CloseBiddingUseCase,
  SendQuoteRequestUseCase,
  CancelQuoteRequestByBuyerUseCase,
  CancelQuoteRequestByAdminUseCase,
  ListBuyerQuoteRequestsUseCase,
  ListArtisanQuoteRequestsUseCase,
  ListAdminQuoteRequestsUseCase,
  GetQuoteRequestByIdUseCase,
  ListQuoteRequestRecipientsUseCase,
  GetContactHistoryUseCase,
  GetStatusHistoryUseCase,
];
