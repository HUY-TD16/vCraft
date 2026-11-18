import {
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type Type,
} from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../common/application/ports/transaction-runner';
import {
  TRADING_CONTRACT,
  type ITradingContract,
} from './public/contracts/trading.contract';
import { BuyerQuoteRequestController } from './adapters/http/controllers/buyer-quote-request.controller';
import { ArtisanQuoteRequestController } from './adapters/http/controllers/artisan-quote-request.controller';
import { AdminQuoteRequestController } from './adapters/http/controllers/admin-quote-request.controller';
import { QuoteRequestController } from './adapters/http/controllers/quote-request.controller';
import { TradingMutationInterceptor } from './adapters/http/interceptors/trading-mutation.interceptor';
import {
  TRADING_CURRENT_STATE_RESOLVER,
  TradingCurrentStateResolver,
} from './adapters/http/interceptors/trading-current-state.resolver';
import { CreateDraftQuoteRequestUseCase } from './application/use-cases/requests/create-draft-quote-request.use-case';
import { UpdateDraftQuoteRequestUseCase } from './application/use-cases/requests/update-draft-quote-request.use-case';
import { DeleteDraftQuoteRequestUseCase } from './application/use-cases/requests/delete-draft-quote-request.use-case';
import { CopyQuoteRequestUseCase } from './application/use-cases/requests/copy-quote-request.use-case';
import { UpdateRecipientContactUseCase } from './application/use-cases/requests/update-recipient-contact.use-case';
import { CloseBiddingUseCase } from './application/use-cases/requests/close-bidding.use-case';
import { SendQuoteRequestUseCase } from './application/use-cases/requests/send-quote-request.use-case';
import { DeclineQuoteRequestUseCase } from './application/use-cases/quotations/decline-quote-request.use-case';
import { GetRecipientResponseHistoryUseCase } from './application/use-cases/quotations/get-recipient-response-history.use-case';
import { ListQuoteRequestQuotesUseCase } from './application/use-cases/quotations/list-quote-request-quotes.use-case';
import { SubmitQuoteUseCase } from './application/use-cases/quotations/submit-quote.use-case';
import { WithdrawQuoteUseCase } from './application/use-cases/quotations/withdraw-quote.use-case';
import { AcceptQuoteUseCase } from './application/use-cases/quotations/accept-quote.use-case';
import { TradingIdempotencyService } from './application/services/trading-idempotency.service';
import { TradingAcceptanceService } from './application/services/trading-acceptance.service';
import {
  CATALOG_CONTRACT,
  type ICatalogContract,
} from '../catalog/public/contracts/catalog.contract';
import {
  WORKSHOP_CONTRACT,
  type IWorkshopContract,
} from '../workshops/public/contracts/workshop.contract';
import { ListBuyerQuoteRequestsUseCase } from './application/use-cases/requests/list-buyer-quote-requests.use-case';
import { ListArtisanQuoteRequestsUseCase } from './application/use-cases/requests/list-artisan-quote-requests.use-case';
import { ListAdminQuoteRequestsUseCase } from './application/use-cases/requests/list-admin-quote-requests.use-case';
import { GetQuoteRequestByIdUseCase } from './application/use-cases/requests/get-quote-request-by-id.use-case';
import { ListQuoteRequestRecipientsUseCase } from './application/use-cases/requests/list-quote-request-recipients.use-case';
import { GetContactHistoryUseCase } from './application/use-cases/requests/get-contact-history.use-case';
import { GetStatusHistoryUseCase } from './application/use-cases/requests/get-status-history.use-case';
import {
  PrismaAllocationBatchRepository,
  PrismaAllocationLogRepository,
  PrismaAllocationRepository,
  PrismaContactEditHistoryRepository,
  PrismaIdempotencyRecordRepository,
  PrismaQuoteRepository,
  PrismaQuoteRequestRepository,
  PrismaRecipientResponseHistoryRepository,
  PrismaRequestRecipientRepository,
  PrismaStatusLogRepository,
  TRADING_PERSISTENCE_PROVIDERS,
} from './adapters/persistence/repositories';
import {
  ALLOCATION_BATCH_REPOSITORY,
  ALLOCATION_LOG_REPOSITORY,
  ALLOCATION_REPOSITORY,
  CONTACT_EDIT_HISTORY_REPOSITORY,
  IDEMPOTENCY_RECORD_REPOSITORY,
  QUOTE_REPOSITORY,
  QUOTE_REQUEST_REPOSITORY,
  RECIPIENT_RESPONSE_HISTORY_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
  STATUS_LOG_REPOSITORY,
  type IAllocationRepository,
  type IContactEditHistoryRepository,
  type IIdempotencyRecordRepository,
  type IQuoteRepository,
  type IQuoteRequestRepository,
  type IRecipientResponseHistoryRepository,
  type IRequestRecipientRepository,
  type IStatusLogRepository,
} from './application/ports/repositories/trading-repositories.port';

const defaultControllers = [
  BuyerQuoteRequestController,
  ArtisanQuoteRequestController,
  AdminQuoteRequestController,
  QuoteRequestController,
];
const defaultProviders = [
  ...TRADING_PERSISTENCE_PROVIDERS,
  {
    provide: TradingIdempotencyService,
    useFactory: (
      idempotencyRepo: IIdempotencyRecordRepository,
      txRunner: TransactionRunner,
    ) => {
      return new TradingIdempotencyService(idempotencyRepo, txRunner);
    },
    inject: [IDEMPOTENCY_RECORD_REPOSITORY, TRANSACTION_RUNNER],
  },
  TradingCurrentStateResolver,
  {
    provide: TRADING_CURRENT_STATE_RESOLVER,
    useExisting: TradingCurrentStateResolver,
  },
  TradingMutationInterceptor,
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
const defaultExports = [
  CreateDraftQuoteRequestUseCase,
  UpdateDraftQuoteRequestUseCase,
  DeleteDraftQuoteRequestUseCase,
  CopyQuoteRequestUseCase,
  UpdateRecipientContactUseCase,
  CloseBiddingUseCase,
  SendQuoteRequestUseCase,
  DeclineQuoteRequestUseCase,
  GetRecipientResponseHistoryUseCase,
  ListQuoteRequestQuotesUseCase,
  SubmitQuoteUseCase,
  WithdrawQuoteUseCase,
  AcceptQuoteUseCase,
  TradingAcceptanceService,
  TRADING_CONTRACT,
  ListBuyerQuoteRequestsUseCase,
  ListArtisanQuoteRequestsUseCase,
  ListAdminQuoteRequestsUseCase,
  GetQuoteRequestByIdUseCase,
  ListQuoteRequestRecipientsUseCase,
  GetContactHistoryUseCase,
  GetStatusHistoryUseCase,
  TradingIdempotencyService,
  TradingCurrentStateResolver,
  TRADING_CURRENT_STATE_RESOLVER,
  TradingMutationInterceptor,
  QUOTE_REQUEST_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
  RECIPIENT_RESPONSE_HISTORY_REPOSITORY,
  QUOTE_REPOSITORY,
  CONTACT_EDIT_HISTORY_REPOSITORY,
  ALLOCATION_REPOSITORY,
  ALLOCATION_BATCH_REPOSITORY,
  ALLOCATION_LOG_REPOSITORY,
  STATUS_LOG_REPOSITORY,
  IDEMPOTENCY_RECORD_REPOSITORY,
  PrismaQuoteRequestRepository,
  PrismaRequestRecipientRepository,
  PrismaRecipientResponseHistoryRepository,
  PrismaQuoteRepository,
  PrismaContactEditHistoryRepository,
  PrismaAllocationRepository,
  PrismaAllocationBatchRepository,
  PrismaAllocationLogRepository,
  PrismaStatusLogRepository,
  PrismaIdempotencyRecordRepository,
];

@Module({
  imports: [DatabaseModule],
  controllers: defaultControllers,
  providers: defaultProviders,
  exports: defaultExports,
})
export class TradingModule {
  /**
   * Note (`docs/contracts/backend.md`): `WorkshopsModule` is not `@Global()`, so when
   * `WorkshopsModule` is implemented, pass `WorkshopsModule.register(...)` into
   * `dependencies.imports` (e.g. `TradingModule.register(TradingAcceptanceService, { imports: [workshopsModule] })`)
   * so `WORKSHOP_CONTRACT` resolves inside `TradingModule`.
   */
  static register(
    implementation: Type<ITradingContract>,
    dependencies: Pick<
      ModuleMetadata,
      'imports' | 'providers' | 'controllers'
    > = {},
  ): DynamicModule {
    const callerProviders = dependencies.providers ?? [];
    const hasImplementationProvider = [
      ...defaultProviders,
      ...callerProviders,
    ].some(
      (provider) =>
        provider === implementation ||
        (typeof provider === 'object' &&
          provider !== null &&
          'provide' in provider &&
          provider.provide === implementation),
    );

    return {
      module: TradingModule,
      imports: [DatabaseModule, ...(dependencies.imports ?? [])],
      controllers: [
        ...defaultControllers,
        ...(dependencies.controllers ?? []),
      ],
      providers: [
        ...defaultProviders,
        ...callerProviders,
        ...(hasImplementationProvider ? [] : [implementation]),
        { provide: TRADING_CONTRACT, useExisting: implementation },
      ],
      exports: Array.from(
        new Set([TRADING_CONTRACT, implementation, ...defaultExports]),
      ),
    };
  }
}

export { TradingAcceptanceService } from './application/services/trading-acceptance.service';
export {
  TRADING_CONTRACT,
  type ITradingContract,
  type AcceptanceInput,
  type AcceptanceExecutionOptions,
} from './public/contracts/trading.contract';

