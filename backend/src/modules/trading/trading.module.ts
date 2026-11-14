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
import { CreateDraftQuoteRequestUseCase } from './application/use-cases/requests/create-draft-quote-request.use-case';
import { UpdateDraftQuoteRequestUseCase } from './application/use-cases/requests/update-draft-quote-request.use-case';
import { DeleteDraftQuoteRequestUseCase } from './application/use-cases/requests/delete-draft-quote-request.use-case';
import { CopyQuoteRequestUseCase } from './application/use-cases/requests/copy-quote-request.use-case';
import { UpdateRecipientContactUseCase } from './application/use-cases/requests/update-recipient-contact.use-case';
import { CloseBiddingUseCase } from './application/use-cases/requests/close-bidding.use-case';
import { ListBuyerQuoteRequestsUseCase } from './application/use-cases/requests/list-buyer-quote-requests.use-case';
import { ListArtisanQuoteRequestsUseCase } from './application/use-cases/requests/list-artisan-quote-requests.use-case';
import { ListAdminQuoteRequestsUseCase } from './application/use-cases/requests/list-admin-quote-requests.use-case';
import { GetQuoteRequestByIdUseCase } from './application/use-cases/requests/get-quote-request-by-id.use-case';
import { ListQuoteRequestRecipientsUseCase } from './application/use-cases/requests/list-quote-request-recipients.use-case';
import { GetContactHistoryUseCase } from './application/use-cases/requests/get-contact-history.use-case';
import { PrismaQuoteRequestRepository } from './adapters/persistence/repositories/quote-request.repository';
import { PrismaRequestRecipientRepository } from './adapters/persistence/repositories/request-recipient.repository';
import { PrismaContactEditHistoryRepository } from './adapters/persistence/repositories/contact-edit-history.repository';
import { PrismaAllocationRepository } from './adapters/persistence/repositories/allocation.repository';
import {
  QUOTE_REQUEST_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
  CONTACT_EDIT_HISTORY_REPOSITORY,
  ALLOCATION_REPOSITORY,
  type IQuoteRequestRepository,
  type IRequestRecipientRepository,
  type IContactEditHistoryRepository,
  type IAllocationRepository,
} from './application/ports/repositories/trading-repositories.port';

const defaultControllers = [
  BuyerQuoteRequestController,
  ArtisanQuoteRequestController,
  AdminQuoteRequestController,
  QuoteRequestController,
];
const defaultProviders = [
  PrismaQuoteRequestRepository,
  {
    provide: QUOTE_REQUEST_REPOSITORY,
    useExisting: PrismaQuoteRequestRepository,
  },
  PrismaRequestRecipientRepository,
  {
    provide: REQUEST_RECIPIENT_REPOSITORY,
    useExisting: PrismaRequestRecipientRepository,
  },
  PrismaContactEditHistoryRepository,
  {
    provide: CONTACT_EDIT_HISTORY_REPOSITORY,
    useExisting: PrismaContactEditHistoryRepository,
  },
  PrismaAllocationRepository,
  {
    provide: ALLOCATION_REPOSITORY,
    useExisting: PrismaAllocationRepository,
  },
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
];
const defaultExports = [
  CreateDraftQuoteRequestUseCase,
  UpdateDraftQuoteRequestUseCase,
  DeleteDraftQuoteRequestUseCase,
  CopyQuoteRequestUseCase,
  UpdateRecipientContactUseCase,
  CloseBiddingUseCase,
  ListBuyerQuoteRequestsUseCase,
  ListArtisanQuoteRequestsUseCase,
  ListAdminQuoteRequestsUseCase,
  GetQuoteRequestByIdUseCase,
  ListQuoteRequestRecipientsUseCase,
  GetContactHistoryUseCase,
  QuoteRequestController,
  QUOTE_REQUEST_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
  CONTACT_EDIT_HISTORY_REPOSITORY,
  ALLOCATION_REPOSITORY,
  PrismaQuoteRequestRepository,
  PrismaRequestRecipientRepository,
  PrismaContactEditHistoryRepository,
  PrismaAllocationRepository,
];

@Module({
  imports: [DatabaseModule],
  controllers: defaultControllers,
  providers: defaultProviders,
  exports: defaultExports,
})
export class TradingModule {
  static register(
    implementation: Type<ITradingContract>,
    dependencies: Pick<
      ModuleMetadata,
      'imports' | 'providers' | 'controllers'
    > = {},
  ): DynamicModule {
    return {
      module: TradingModule,
      imports: [DatabaseModule, ...(dependencies.imports ?? [])],
      controllers: [
        ...defaultControllers,
        ...(dependencies.controllers ?? []),
      ],
      providers: [
        ...defaultProviders,
        ...(dependencies.providers ?? []),
        implementation,
        { provide: TRADING_CONTRACT, useExisting: implementation },
      ],
      exports: [TRADING_CONTRACT, ...defaultExports],
    };
  }
}
