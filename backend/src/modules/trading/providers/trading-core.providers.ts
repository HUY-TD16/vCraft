import type { Provider } from '@nestjs/common';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../../common/application/ports/transaction-runner';
import { TradingMutationInterceptor } from '../adapters/http/interceptors/trading-mutation.interceptor';
import {
  TRADING_CURRENT_STATE_RESOLVER,
  TradingCurrentStateResolver,
} from '../adapters/http/interceptors/trading-current-state.resolver';
import { IdempotencyCleanupScheduler } from '../adapters/jobs/idempotency-cleanup.scheduler';
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
} from '../adapters/persistence/repositories';
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
  type IIdempotencyRecordRepository,
} from '../application/ports/repositories/trading-repositories.port';
import { IdempotencyCleanupService } from '../application/services/idempotency-cleanup.service';
import { TradingIdempotencyService } from '../application/services/trading-idempotency.service';

export const TRADING_CORE_PROVIDERS: Provider[] = [
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
    provide: IdempotencyCleanupService,
    useFactory: (
      idempotencyRepo: IIdempotencyRecordRepository,
      txRunner: TransactionRunner,
    ) => {
      return new IdempotencyCleanupService(idempotencyRepo, txRunner);
    },
    inject: [IDEMPOTENCY_RECORD_REPOSITORY, TRANSACTION_RUNNER],
  },
  IdempotencyCleanupScheduler,
];

export const TRADING_CORE_EXPORTS = [
  TradingIdempotencyService,
  TradingCurrentStateResolver,
  TRADING_CURRENT_STATE_RESOLVER,
  TradingMutationInterceptor,
  IdempotencyCleanupService,
  IdempotencyCleanupScheduler,
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
