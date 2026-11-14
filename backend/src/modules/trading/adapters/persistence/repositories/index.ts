import type { Provider } from '@nestjs/common';
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
} from '../../../application/ports/repositories/trading-repositories.port';
import { PrismaAllocationBatchRepository } from './allocation-batch.repository';
import { PrismaAllocationLogRepository } from './allocation-log.repository';
import { PrismaAllocationRepository } from './allocation.repository';
import { PrismaContactEditHistoryRepository } from './contact-edit-history.repository';
import { PrismaIdempotencyRecordRepository } from './idempotency-record.repository';
import { PrismaQuoteRequestRepository } from './quote-request.repository';
import { PrismaQuoteRepository } from './quote.repository';
import { PrismaRecipientResponseHistoryRepository } from './recipient-response-history.repository';
import { PrismaRequestRecipientRepository } from './request-recipient.repository';
import { PrismaStatusLogRepository } from './status-log.repository';

export * from './quote-request.repository';
export * from './contact-edit-history.repository';
export * from './request-recipient.repository';
export * from './recipient-response-history.repository';
export * from './quote.repository';
export * from './allocation.repository';
export * from './allocation-batch.repository';
export * from './allocation-log.repository';
export * from './status-log.repository';
export * from './idempotency-record.repository';

export const TRADING_PERSISTENCE_PROVIDERS: readonly Provider[] = [
  PrismaQuoteRequestRepository,
  {
    provide: QUOTE_REQUEST_REPOSITORY,
    useExisting: PrismaQuoteRequestRepository,
  },
  PrismaContactEditHistoryRepository,
  {
    provide: CONTACT_EDIT_HISTORY_REPOSITORY,
    useExisting: PrismaContactEditHistoryRepository,
  },
  PrismaRequestRecipientRepository,
  {
    provide: REQUEST_RECIPIENT_REPOSITORY,
    useExisting: PrismaRequestRecipientRepository,
  },
  PrismaRecipientResponseHistoryRepository,
  {
    provide: RECIPIENT_RESPONSE_HISTORY_REPOSITORY,
    useExisting: PrismaRecipientResponseHistoryRepository,
  },
  PrismaQuoteRepository,
  {
    provide: QUOTE_REPOSITORY,
    useExisting: PrismaQuoteRepository,
  },
  PrismaAllocationRepository,
  {
    provide: ALLOCATION_REPOSITORY,
    useExisting: PrismaAllocationRepository,
  },
  PrismaAllocationBatchRepository,
  {
    provide: ALLOCATION_BATCH_REPOSITORY,
    useExisting: PrismaAllocationBatchRepository,
  },
  PrismaAllocationLogRepository,
  {
    provide: ALLOCATION_LOG_REPOSITORY,
    useExisting: PrismaAllocationLogRepository,
  },
  PrismaStatusLogRepository,
  {
    provide: STATUS_LOG_REPOSITORY,
    useExisting: PrismaStatusLogRepository,
  },
  PrismaIdempotencyRecordRepository,
  {
    provide: IDEMPOTENCY_RECORD_REPOSITORY,
    useExisting: PrismaIdempotencyRecordRepository,
  },
];
