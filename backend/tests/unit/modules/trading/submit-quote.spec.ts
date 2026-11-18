import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '../../../../src/generated/prisma/client';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { configureHttp } from '../../../../src/bootstrap/configure-http';
import { AppLogger } from '../../../../src/common/observability/app-logger';
import { AppConfigModule } from '../../../../src/common/config/app-config';
import { SecurityModule } from '../../../../src/common/security/security.module';
import { createApiDocument } from '../../../../src/common/http/swagger/configure-swagger';
import { IDENTITY_CONTRACT } from '../../../../src/modules/identity/public/contracts/identity.contract';
import { WORKSHOP_CONTRACT } from '../../../../src/modules/workshops/public/contracts/workshop.contract';
import { WorkshopSuspended } from '../../../../src/modules/workshops/domain/errors/workshop-suspended';
import {
  TRANSACTION_RUNNER,
  type TransactionContext,
  type TransactionRunner,
} from '../../../../src/common/application/ports/transaction-runner';
import type { AuthenticatedActor } from '../../../../src/common/application/types/contract-types';
import type { OperationMetadata } from '../../../../src/common/application/types/operation-metadata';
import type { IWorkshopContract } from '../../../../src/modules/workshops/public/contracts/workshop.contract';
import { PrismaService } from '../../../../src/infrastructure/database/prisma/prisma.service';
import { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import { TradingModule } from '../../../../src/modules/trading/trading.module';
import {
  ALLOCATION_REPOSITORY,
  IDEMPOTENCY_RECORD_REPOSITORY,
  QUOTE_REPOSITORY,
  QUOTE_REQUEST_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
  type IAllocationRepository,
  type IIdempotencyRecordRepository,
  type IQuoteRepository,
  type IQuoteRequestRepository,
  type IRequestRecipientRepository,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { DeclineQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/quotations/decline-quote-request.use-case';
import { SubmitQuoteUseCase } from '../../../../src/modules/trading/application/use-cases/quotations/submit-quote.use-case';
import { TradingIdempotencyService } from '../../../../src/modules/trading/application/services/trading-idempotency.service';
import { ArtisanQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/artisan-quote-request.controller';
import {
  quoteMutationDtoResponseSchema,
  submitQuoteOperationResponseSchema,
} from '../../../../src/modules/trading/adapters/http/dtos/submit-quote.dto';
import {
  TRADING_CURRENT_STATE_RESOLVER,
  TradingCurrentStateResolver,
} from '../../../../src/modules/trading/adapters/http/interceptors/trading-current-state.resolver';
import { TradingMutationInterceptor } from '../../../../src/modules/trading/adapters/http/interceptors/trading-mutation.interceptor';
import { ListArtisanQuoteRequestsUseCase } from '../../../../src/modules/trading/application/use-cases/requests/list-artisan-quote-requests.use-case';
import { PrismaQuoteRequestRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository';
import { PrismaRequestRecipientRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository';
import { PrismaQuoteRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/quote.repository';
import {
  BiddingClosedError,
  ConcurrencyConflictError,
  DeadlineViolationError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  Quote,
  QuoteDeadlines,
  QuoteRequest,
  QuoteRequestNotFoundError,
  RequestRecipient,
  TWENTY_FOUR_HOURS_MS,
  TradingDomainError,
  TradingPermissionDeniedError,
  type RecipientResponseRecord,
  type StatusLogRecord,
} from '../../../../src/modules/trading/domain';
import type {
  CreateIdempotencyRecordInput,
  IdempotencyScopeKey,
  PersistedIdempotencyRecord,
  QuoteMutationDto,
  TradingCurrentStateDto,
} from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import { MockWorkshopContract } from '../../../support/mocks/workshop.mock';

const SENT_AT = new Date('2026-11-10T08:00:00.000Z');
const BIDDING_DEADLINE = new Date('2026-12-01T10:00:00.000Z');
const DELIVERY_DEADLINE = new Date('2026-12-15T10:00:00.000Z');
const NOW = new Date('2026-11-12T09:00:00.000Z');
const VALID_ACCEPT_DEADLINE = new Date(
  BIDDING_DEADLINE.getTime() + TWENTY_FOUR_HOURS_MS + 3_600_000,
);
const VALID_COMMITTED_DELIVERY = new Date(
  DELIVERY_DEADLINE.getTime() - 3_600_000,
);

const VALID_IDEMPOTENCY_KEY_1 = 'a12ebf30-2f70-47bb-8d08-46ccf22d3414';
const VALID_IDEMPOTENCY_KEY_2 = 'b23cbf41-3a81-48cc-9e19-57ddf33e4525';
const VALID_IDEMPOTENCY_KEY_3 = 'c34dcf52-4b92-49dd-af2a-68eef44f5636';
const VALID_IDEMPOTENCY_KEY_4 = 'd45edf63-5c03-4aee-bf3b-79ff055a6747';

const artisanActor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '301',
  authVersion: 1,
  sessionId: 'session-artisan-301',
  sessionLevel: 'normal',
});

const otherArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '22',
  role: 'artisan',
  workshopId: '302',
  authVersion: 1,
  sessionId: 'session-artisan-302',
  sessionLevel: 'normal',
});

const artisanWithoutWorkshopActor: AuthenticatedActor = Object.freeze({
  accountId: '21',
  role: 'artisan',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-artisan-no-workshop',
  sessionLevel: 'normal',
});

const tempPasswordArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '301',
  authVersion: 1,
  sessionId: 'session-temp-artisan',
  sessionLevel: 'temp_password',
});

const buyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-10',
  sessionLevel: 'normal',
});

const adminActor: AuthenticatedActor = Object.freeze({
  accountId: '99',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-admin-99',
  sessionLevel: 'normal',
});

function asQuoteRequestRepo(
  partial: Partial<IQuoteRequestRepository>,
): IQuoteRequestRepository {
  return partial as unknown as IQuoteRequestRepository;
}

function asRecipientRepo(
  partial: Partial<IRequestRecipientRepository>,
): IRequestRecipientRepository {
  return partial as unknown as IRequestRecipientRepository;
}

function asQuoteRepo(partial: Partial<IQuoteRepository>): IQuoteRepository {
  return partial as unknown as IQuoteRepository;
}

function asAllocationRepo(
  partial: Partial<IAllocationRepository>,
): IAllocationRepository {
  return partial as unknown as IAllocationRepository;
}

function asIdempotencyRepo(
  partial: Partial<IIdempotencyRecordRepository>,
): IIdempotencyRecordRepository {
  return partial as unknown as IIdempotencyRecordRepository;
}

interface SubmitQuoteSuccessBody {
  success: boolean;
  data: QuoteMutationDto;
  operation: OperationMetadata<TradingCurrentStateDto>;
}

interface ProblemDetailsBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  tracking_id: string;
  errors?: Array<{ field: string; message: string }>;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function createSampleQuoteRequest(
  overrides: Partial<{
    id: string;
    quantity: number | null;
    status:
      | 'draft_request'
      | 'sent_to_artisans'
      | 'artisans_bidding'
      | 'buyer_accepted'
      | 'in_production'
      | 'delivered';
    version: number;
    bidding_deadline: Date | null;
    delivery_deadline: Date | null;
    bidding_closed_at: Date | null;
    cancelled_at: Date | null;
    cancelled_by: string | null;
    cancel_reason: string | null;
  }> = {},
): QuoteRequest {
  const status = overrides.status ?? 'sent_to_artisans';
  const isDraft = status === 'draft_request';
  return QuoteRequest.reconstitute({
    id: overrides.id ?? '10001',
    buyer_id: '10',
    category_id: isDraft ? null : '3',
    spec: isDraft ? null : 'Bộ ấm chén tử sa men rạn cao cấp',
    quantity: overrides.quantity !== undefined ? overrides.quantity : isDraft ? null : 500,
    unit: isDraft ? null : 'set',
    unit_set_description: isDraft ? null : '1 ấm, 6 chén, 7 đĩa kê',
    status,
    delivery_mode: isDraft ? null : 'at_buyer_address',
    delivery_region: isDraft ? null : 'Hà Nội, Gia Lâm',
    delivery_address: isDraft ? null : 'Số 12 Phố Gốm, Bát Tràng',
    recipient_name: isDraft ? null : 'Nguyễn Văn Mua',
    recipient_phone: isDraft ? null : '0901234567',
    bidding_deadline:
      overrides.bidding_deadline !== undefined
        ? overrides.bidding_deadline
        : isDraft
          ? null
          : BIDDING_DEADLINE,
    delivery_deadline:
      overrides.delivery_deadline !== undefined
        ? overrides.delivery_deadline
        : isDraft
          ? null
          : DELIVERY_DEADLINE,
    bidding_closed_at: overrides.bidding_closed_at ?? null,
    version: overrides.version ?? 2,
    cancelled_at: overrides.cancelled_at ?? null,
    cancelled_by: overrides.cancelled_by ?? null,
    cancel_reason: overrides.cancel_reason ?? null,
    created_at: SENT_AT,
    updated_at: SENT_AT,
  });
}

function createSampleRecipient(
  overrides: Partial<{
    id: string;
    request_id: string;
    workshop_id: string;
    response_status: 'pending' | 'declined' | 'quoted' | 'withdrawn';
    decline_reason: string | null;
    responded_by: string | null;
    responded_at: Date | null;
    version: number;
  }> = {},
): RequestRecipient {
  return RequestRecipient.reconstitute({
    id: overrides.id ?? '11001',
    request_id: overrides.request_id ?? '10001',
    workshop_id: overrides.workshop_id ?? '301',
    response_status: overrides.response_status ?? 'pending',
    decline_reason: overrides.decline_reason ?? null,
    responded_by: overrides.responded_by ?? null,
    responded_at: overrides.responded_at ?? null,
    sent_at: SENT_AT,
    version: overrides.version ?? 1,
  });
}

function createSampleQuote(
  overrides: Partial<{
    id: string;
    request_id: string;
    workshop_id: string;
    unit_price: number;
    max_quantity: number;
    bid_accept_deadline: Date;
    committed_delivery_at: Date;
    status: 'active' | 'withdrawn' | 'accepted';
    version: number;
    withdraw_reason: string | null;
    withdrawn_by: string | null;
    withdrawn_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }> = {},
): Quote {
  return Quote.reconstitute({
    id: overrides.id ?? '401',
    request_id: overrides.request_id ?? '10001',
    workshop_id: overrides.workshop_id ?? '301',
    unit_price: overrides.unit_price ?? 45000,
    max_quantity: overrides.max_quantity ?? 400,
    bid_accept_deadline:
      overrides.bid_accept_deadline ?? VALID_ACCEPT_DEADLINE,
    committed_delivery_at:
      overrides.committed_delivery_at ?? VALID_COMMITTED_DELIVERY,
    status: overrides.status ?? 'active',
    version: overrides.version ?? 1,
    withdraw_reason: overrides.withdraw_reason ?? null,
    withdrawn_by: overrides.withdrawn_by ?? null,
    withdrawn_at: overrides.withdrawn_at ?? null,
    created_at: overrides.created_at ?? NOW,
    updated_at: overrides.updated_at ?? NOW,
  });
}

describe('Task 19: Submit / Edit / Resubmit Quote (UC-16, BR-14, BR-15)', () => {
  describe('SubmitQuoteUseCase (Pure Application & Domain Rules)', () => {
    it('SQ-01: submits initial quote on sent_to_artisans request, creates Quote v1, transitions request to artisans_bidding + StatusLog(first_quote)', async () => {
      const txRunner = new MockTransactionRunner();
      const request = createSampleQuoteRequest({
        status: 'sent_to_artisans',
        version: 2,
      });
      const recipient = createSampleRecipient({
        response_status: 'pending',
        version: 1,
      });

      let capturedHistory: RecipientResponseRecord | undefined;
      let capturedStatusLogs: readonly StatusLogRecord[] | undefined;

      const quoteRequestRepo = {
        lockById: vi.fn().mockResolvedValue(request),
        update: vi.fn().mockImplementation(async ({ request: updated, statusLogs }) => {
          capturedStatusLogs = statusLogs;
          return updated;
        }),
      };

      const recipientRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
      };

      const quoteRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ quote, recipientHistory }) => {
          capturedHistory = recipientHistory;
          return Quote.reconstitute({
            ...quote,
            id: '401',
          });
        }),
        update: vi.fn(),
      };

      const workshopContract = new MockWorkshopContract().givenActiveWorkshops('301');
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Minh Long',
        status: 'active',
        isProfilePublic: true,
      });

      const useCase = new SubmitQuoteUseCase(
        txRunner,
        asQuoteRequestRepo(quoteRequestRepo),
        asRecipientRepo(recipientRepo),
        asQuoteRepo(quoteRepo),
        workshopContract,
      );

      const output = await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 1,
        expectedQuoteVersion: null,
        unitPrice: 45000,
        maxQuantity: 300,
        bidAcceptDeadline: VALID_ACCEPT_DEADLINE.toISOString(),
        committedDeliveryAt: VALID_COMMITTED_DELIVERY.toISOString(),
        now: NOW,
      });

      expect(output.created).toBe(true);
      expect(quoteRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ useEntityId: false }),
        expect.anything(),
      );
      expect(quoteRepo.update).not.toHaveBeenCalled();

      expect(output.result).toEqual({
        quote: {
          id: '401',
          request_id: '10001',
          workshop: { id: '301', name: 'Xưởng Gốm Minh Long' },
          unit_price: 45000,
          max_quantity: 300,
          bid_accept_deadline: VALID_ACCEPT_DEADLINE.toISOString(),
          committed_delivery_at: VALID_COMMITTED_DELIVERY.toISOString(),
          status: 'active',
          version: 1,
          withdraw_reason: null,
          withdrawn_at: null,
          is_eligible: true,
          ineligible_reasons: [],
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        },
        recipient: {
          id: '11001',
          request_id: '10001',
          workshop: { id: '301', name: 'Xưởng Gốm Minh Long' },
          response_status: 'quoted',
          version: 2,
          sent_at: SENT_AT.toISOString(),
          responded_at: NOW.toISOString(),
          decline_reason: null,
          eligibility_labels: [],
        },
      });

      expect(output.currentState).toEqual({
        request: {
          id: '10001',
          status: 'artisans_bidding',
          version: 3,
          cancelled_at: null,
        },
        recipient: {
          id: '11001',
          status: 'quoted',
          version: 2,
        },
        quote: {
          id: '401',
          status: 'active',
          version: 1,
        },
      });

      expect(capturedHistory).toEqual({
        recipient_id: '11001',
        quote_id: '1',
        event_type: 'quote_submitted',
        prev_status: 'pending',
        new_status: 'quoted',
        reason: null,
        quote_snapshot: {
          unit_price: 45000,
          max_quantity: 300,
          bid_accept_deadline: VALID_ACCEPT_DEADLINE,
          committed_delivery_at: VALID_COMMITTED_DELIVERY,
          status: 'active',
          version: 1,
        },
        performed_by: '20',
        created_at: NOW,
      });

      expect(capturedStatusLogs).toEqual([
        {
          request_id: '10001',
          event_type: 'first_quote',
          prev_status: 'sent_to_artisans',
          new_status: 'artisans_bidding',
          performed_by: '20',
          is_admin_action: false,
          note: null,
          evidence: null,
          created_at: NOW,
        },
      ]);
    });

    it('SQ-02: second workshop quoting an artisans_bidding request does not bump QuoteRequest version or emit duplicate first_quote StatusLog', async () => {
      const txRunner = new MockTransactionRunner();
      const request = createSampleQuoteRequest({
        status: 'artisans_bidding',
        version: 3,
      });
      const recipient2 = createSampleRecipient({
        id: '11002',
        workshop_id: '302',
        response_status: 'pending',
        version: 1,
      });

      const quoteRequestRepo = {
        lockById: vi.fn().mockResolvedValue(request),
        update: vi.fn(),
      };
      const recipientRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient2),
      };
      const quoteRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ quote }) =>
          Quote.reconstitute({ ...quote, id: '402' }),
        ),
      };

      const workshopContract = new MockWorkshopContract().givenActiveWorkshops('302');
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '302',
        name: 'Xưởng Gốm Bát Tràng 2',
        status: 'active',
        isProfilePublic: true,
      });

      const useCase = new SubmitQuoteUseCase(
        txRunner,
        asQuoteRequestRepo(quoteRequestRepo),
        asRecipientRepo(recipientRepo),
        asQuoteRepo(quoteRepo),
        workshopContract,
      );

      const output = await useCase.execute({
        actor: otherArtisanActor,
        requestId: '10001',
        expectedRecipientVersion: 1,
        expectedQuoteVersion: null,
        unitPrice: 48000,
        maxQuantity: 500,
        bidAcceptDeadline: VALID_ACCEPT_DEADLINE,
        committedDeliveryAt: DELIVERY_DEADLINE, // exact boundary === delivery_deadline
        now: NOW,
      });

      expect(output.created).toBe(true);
      expect(quoteRequestRepo.update).not.toHaveBeenCalled();
      expect(output.currentState.request).toEqual({
        id: '10001',
        status: 'artisans_bidding',
        version: 3,
        cancelled_at: null,
      });
      expect(output.result.quote.max_quantity).toBe(500);
    });

    it('SQ-03: edits an existing active quote, increments Quote.version & RequestRecipient.version, logs quote_updated', async () => {
      const txRunner = new MockTransactionRunner();
      const request = createSampleQuoteRequest({
        status: 'artisans_bidding',
        version: 3,
      });
      const recipient = createSampleRecipient({
        response_status: 'quoted',
        version: 2,
      });
      const existingQuote = createSampleQuote({
        id: '401',
        unit_price: 45000,
        max_quantity: 300,
        status: 'active',
        version: 1,
        created_at: SENT_AT,
        updated_at: SENT_AT,
      });

      let capturedHistory: RecipientResponseRecord | undefined;
      const quoteRequestRepo = {
        lockById: vi.fn().mockResolvedValue(request),
        update: vi.fn(),
      };
      const recipientRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
      };
      const quoteRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(existingQuote),
        update: vi.fn().mockImplementation(async ({ quote, recipientHistory }) => {
          capturedHistory = recipientHistory;
          return quote;
        }),
        create: vi.fn(),
      };

      const useCase = new SubmitQuoteUseCase(
        txRunner,
        asQuoteRequestRepo(quoteRequestRepo),
        asRecipientRepo(recipientRepo),
        asQuoteRepo(quoteRepo),
      );

      const editTime = new Date(NOW.getTime() + 60_000);
      const output = await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 2,
        expectedQuoteVersion: 1,
        unitPrice: 42000,
        maxQuantity: 450,
        bidAcceptDeadline: VALID_ACCEPT_DEADLINE,
        committedDeliveryAt: VALID_COMMITTED_DELIVERY,
        now: editTime,
      });

      expect(output.created).toBe(false);
      expect(quoteRepo.create).not.toHaveBeenCalled();
      expect(quoteRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ expectedVersion: 1 }),
        expect.anything(),
      );
      expect(quoteRequestRepo.update).not.toHaveBeenCalled();
      expect(output.result.quote.version).toBe(2);
      expect(output.result.quote.unit_price).toBe(42000);
      expect(output.result.quote.max_quantity).toBe(450);
      expect(output.result.quote.created_at).toBe(SENT_AT.toISOString());
      expect(output.result.quote.updated_at).toBe(editTime.toISOString());
      expect(output.result.recipient.version).toBe(3);
      expect(capturedHistory?.event_type).toBe('quote_updated');
      expect(capturedHistory?.prev_status).toBe('quoted');
      expect(capturedHistory?.new_status).toBe('quoted');
      expect(capturedHistory?.quote_snapshot?.version).toBe(2);
    });

    it('SQ-04: resubmits a withdrawn quote on the same row, clears withdraw fields, increments version, logs quote_resubmitted', async () => {
      const txRunner = new MockTransactionRunner();
      const request = createSampleQuoteRequest({
        status: 'artisans_bidding',
        version: 3,
      });
      const recipient = createSampleRecipient({
        response_status: 'withdrawn',
        version: 3,
      });
      const withdrawnQuote = createSampleQuote({
        id: '401',
        status: 'withdrawn',
        version: 2,
        withdraw_reason: 'Hỏng lò nung tạm thời',
        withdrawn_by: '20',
        withdrawn_at: NOW,
      });

      let capturedHistory: RecipientResponseRecord | undefined;
      const quoteRequestRepo = {
        lockById: vi.fn().mockResolvedValue(request),
        update: vi.fn(),
      };
      const recipientRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
      };
      const quoteRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(withdrawnQuote),
        update: vi.fn().mockImplementation(async ({ quote, recipientHistory }) => {
          capturedHistory = recipientHistory;
          return quote;
        }),
      };

      const resubmitTime = new Date(NOW.getTime() + 120_000);
      const useCase = new SubmitQuoteUseCase(
        txRunner,
        asQuoteRequestRepo(quoteRequestRepo),
        asRecipientRepo(recipientRepo),
        asQuoteRepo(quoteRepo),
      );

      const output = await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 3,
        expectedQuoteVersion: 2,
        unitPrice: 46000,
        maxQuantity: 350,
        bidAcceptDeadline: VALID_ACCEPT_DEADLINE,
        committedDeliveryAt: VALID_COMMITTED_DELIVERY,
        now: resubmitTime,
      });

      expect(output.created).toBe(false);
      expect(output.result.quote.id).toBe('401');
      expect(output.result.quote.status).toBe('active');
      expect(output.result.quote.version).toBe(3);
      expect(output.result.quote.withdraw_reason).toBeNull();
      expect(output.result.quote.withdrawn_at).toBeNull();
      expect(output.result.recipient.response_status).toBe('quoted');
      expect(output.result.recipient.version).toBe(4);
      expect(capturedHistory?.event_type).toBe('quote_resubmitted');
      expect(capturedHistory?.prev_status).toBe('withdrawn');
      expect(capturedHistory?.new_status).toBe('quoted');
    });

    it('SQ-05: allows a declined recipient to change mind and submit a quote while bidding is open and workshop is active (BR-15)', async () => {
      const txRunner = new MockTransactionRunner();
      const request = createSampleQuoteRequest({
        status: 'sent_to_artisans',
        version: 2,
      });
      const declinedRecipient = createSampleRecipient({
        response_status: 'declined',
        decline_reason: 'Trước đó bận lịch nung',
        responded_by: '20',
        responded_at: SENT_AT,
        version: 2,
      });

      let capturedHistory: RecipientResponseRecord | undefined;
      const quoteRequestRepo = {
        lockById: vi.fn().mockResolvedValue(request),
        update: vi.fn().mockImplementation(async ({ request: updated }) => updated),
      };
      const recipientRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(declinedRecipient),
      };
      const quoteRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ quote, recipientHistory }) => {
          capturedHistory = recipientHistory;
          return Quote.reconstitute({ ...quote, id: '405' });
        }),
      };

      const useCase = new SubmitQuoteUseCase(
        txRunner,
        asQuoteRequestRepo(quoteRequestRepo),
        asRecipientRepo(recipientRepo),
        asQuoteRepo(quoteRepo),
      );

      const output = await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 2,
        expectedQuoteVersion: null,
        unitPrice: 44000,
        maxQuantity: 250,
        bidAcceptDeadline: VALID_ACCEPT_DEADLINE,
        committedDeliveryAt: VALID_COMMITTED_DELIVERY,
        now: NOW,
      });

      expect(output.created).toBe(true);
      expect(output.result.recipient.response_status).toBe('quoted');
      expect(output.result.recipient.decline_reason).toBeNull();
      expect(output.result.recipient.version).toBe(3);
      expect(capturedHistory?.event_type).toBe('quote_submitted');
      expect(capturedHistory?.prev_status).toBe('declined');
      expect(capturedHistory?.new_status).toBe('quoted');
    });

    it('SQ-06: enforces exact time-invariant boundaries (now < bid_accept_deadline < committed_delivery_at <= delivery_deadline & >= bidding_deadline + 24h) with zero state mutation', async () => {
      const txRunner = new MockTransactionRunner();
      const request = createSampleQuoteRequest({
        status: 'sent_to_artisans',
        version: 2,
      });
      const recipient = createSampleRecipient({ version: 1 });
      const exact24h = new Date(BIDDING_DEADLINE.getTime() + TWENTY_FOUR_HOURS_MS);

      const buildUseCase = () => {
        const quoteRequestRepo = {
          lockById: vi.fn().mockResolvedValue(request),
          update: vi.fn(async ({ request: updated }) => updated),
        };
        const recipientRepo = {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
        };
        const quoteRepo = {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(async ({ quote }) =>
            Quote.reconstitute({ ...quote, id: '401' }),
          ),
          update: vi.fn(),
        };
        return {
          useCase: new SubmitQuoteUseCase(
            txRunner,
            asQuoteRequestRepo(quoteRequestRepo),
            asRecipientRepo(recipientRepo),
            asQuoteRepo(quoteRepo),
          ),
          quoteRequestRepo,
          quoteRepo,
        };
      };

      // Exact boundary pass: bid_accept_deadline === bidding_deadline + 24h & committed_delivery_at === delivery_deadline
      const passEnv = buildUseCase();
      const passRes = await passEnv.useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 1,
        expectedQuoteVersion: null,
        unitPrice: 45000,
        maxQuantity: 300,
        bidAcceptDeadline: exact24h,
        committedDeliveryAt: DELIVERY_DEADLINE,
        now: NOW,
      });
      expect(passRes.result.quote.bid_accept_deadline).toBe(exact24h.toISOString());
      expect(passRes.result.quote.committed_delivery_at).toBe(DELIVERY_DEADLINE.toISOString());

      // Exact boundary pass: committed_delivery_at === bid_accept_deadline + 1ms
      const plus1msEnv = buildUseCase();
      const plus1msCommitted = new Date(exact24h.getTime() + 1);
      const plus1msRes = await plus1msEnv.useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 1,
        expectedQuoteVersion: null,
        unitPrice: 45000,
        maxQuantity: 300,
        bidAcceptDeadline: exact24h,
        committedDeliveryAt: plus1msCommitted,
        now: NOW,
      });
      expect(plus1msRes.created).toBe(true);
      expect(plus1msRes.result.quote.committed_delivery_at).toBe(
        plus1msCommitted.toISOString(),
      );

      // Exact boundary pass: now === bidding_deadline - 1ms
      const beforeCloseEnv = buildUseCase();
      const beforeCloseRes = await beforeCloseEnv.useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 1,
        expectedQuoteVersion: null,
        unitPrice: 45000,
        maxQuantity: 300,
        bidAcceptDeadline: exact24h,
        committedDeliveryAt: DELIVERY_DEADLINE,
        now: new Date(BIDDING_DEADLINE.getTime() - 1),
      });
      expect(beforeCloseRes.created).toBe(true);

      // Direct domain QuoteDeadlines boundary: bid_accept_deadline === now + 1ms
      const lateNow = new Date(BIDDING_DEADLINE.getTime() + 48 * 3_600_000);
      const directDeadlines = QuoteDeadlines.validateForSubmission({
        bidAcceptDeadline: new Date(lateNow.getTime() + 1),
        committedDeliveryAt: new Date(lateNow.getTime() + 2),
        requestBiddingDeadline: BIDDING_DEADLINE,
        requestDeliveryDeadline: DELIVERY_DEADLINE,
        now: lateNow,
      });
      expect(directDeadlines.bidAcceptDeadline.getTime()).toBe(
        lateNow.getTime() + 1,
      );

      // Invalid boundary cases
      const invalidCases: Array<{
        label: string;
        accept: Date;
        committed: Date;
      }> = [
        {
          label: 'bid_accept_deadline === now',
          accept: NOW,
          committed: DELIVERY_DEADLINE,
        },
        {
          label: 'bid_accept_deadline < now',
          accept: new Date(NOW.getTime() - 1),
          committed: DELIVERY_DEADLINE,
        },
        {
          label: 'bid_accept_deadline === bidding_deadline + 24h - 1ms',
          accept: new Date(exact24h.getTime() - 1),
          committed: DELIVERY_DEADLINE,
        },
        {
          label: 'committed_delivery_at === bid_accept_deadline',
          accept: VALID_ACCEPT_DEADLINE,
          committed: VALID_ACCEPT_DEADLINE,
        },
        {
          label: 'committed_delivery_at < bid_accept_deadline',
          accept: VALID_ACCEPT_DEADLINE,
          committed: new Date(VALID_ACCEPT_DEADLINE.getTime() - 1),
        },
        {
          label: 'committed_delivery_at === delivery_deadline + 1ms',
          accept: VALID_ACCEPT_DEADLINE,
          committed: new Date(DELIVERY_DEADLINE.getTime() + 1),
        },
      ];

      for (const c of invalidCases) {
        const env = buildUseCase();
        await expect(
          env.useCase.execute({
            actor: artisanActor,
            requestId: '10001',
            expectedRecipientVersion: 1,
            expectedQuoteVersion: null,
            unitPrice: 45000,
            maxQuantity: 300,
            bidAcceptDeadline: c.accept,
            committedDeliveryAt: c.committed,
            now: NOW,
          }),
          c.label,
        ).rejects.toThrow(DeadlineViolationError);
        expect(env.quoteRepo.create).not.toHaveBeenCalled();
        expect(env.quoteRepo.update).not.toHaveBeenCalled();
        expect(env.quoteRequestRepo.update).not.toHaveBeenCalled();
      }
    });

    it('SQ-07: rejects invalid unit_price, max_quantity > request.quantity, and malformed dates with InvalidTradingInputError', async () => {
      const txRunner = new MockTransactionRunner();
      const request = createSampleQuoteRequest({ quantity: 500 });
      const recipient = createSampleRecipient({ version: 1 });
      const quoteRequestRepo = {
        lockById: vi.fn().mockResolvedValue(request),
        update: vi.fn(),
      };
      const recipientRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
      };
      const quoteRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      };

      const useCase = new SubmitQuoteUseCase(
        txRunner,
        asQuoteRequestRepo(quoteRequestRepo),
        asRecipientRepo(recipientRepo),
        asQuoteRepo(quoteRepo),
      );

      // max_quantity > request.quantity (501 > 500)
      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 1,
          expectedQuoteVersion: null,
          unitPrice: 45000,
          maxQuantity: 501,
          bidAcceptDeadline: VALID_ACCEPT_DEADLINE,
          committedDeliveryAt: VALID_COMMITTED_DELIVERY,
          now: NOW,
        }),
      ).rejects.toThrow(InvalidTradingInputError);
      expect(quoteRepo.create).not.toHaveBeenCalled();

      // unit_price <= 0, float, > max
      for (const badPrice of [0, -100, 12.5, 1_000_000_000_000_000]) {
        await expect(
          useCase.execute({
            actor: artisanActor,
            requestId: '10001',
            expectedRecipientVersion: 1,
            expectedQuoteVersion: null,
            unitPrice: badPrice,
            maxQuantity: 100,
            bidAcceptDeadline: VALID_ACCEPT_DEADLINE,
            committedDeliveryAt: VALID_COMMITTED_DELIVERY,
            now: NOW,
          }),
        ).rejects.toThrow(InvalidTradingInputError);
      }

      // bad date string
      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 1,
          expectedQuoteVersion: null,
          unitPrice: 45000,
          maxQuantity: 100,
          bidAcceptDeadline: 'not-a-date',
          committedDeliveryAt: VALID_COMMITTED_DELIVERY,
          now: NOW,
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      // invalid max_quantity extremes (0, -1, float, > 2147483647)
      for (const badQty of [0, -1, 1.5, 2_147_483_648]) {
        await expect(
          useCase.execute({
            actor: artisanActor,
            requestId: '10001',
            expectedRecipientVersion: 1,
            expectedQuoteVersion: null,
            unitPrice: 45000,
            maxQuantity: badQty,
            bidAcceptDeadline: VALID_ACCEPT_DEADLINE,
            committedDeliveryAt: VALID_COMMITTED_DELIVERY,
            now: NOW,
          }),
        ).rejects.toThrow(InvalidTradingInputError);
      }

      // Valid extremes: unit_price = 1 / 999_999_999_999_999, max_quantity = 1 / 2_147_483_647
      const runValidExtreme = async (
        unitPrice: number,
        maxQuantity: number,
        reqQty: number,
      ) => {
        const extremeReq = createSampleQuoteRequest({
          quantity: reqQty,
          status: 'sent_to_artisans',
          version: 2,
        });
        const extremeUseCase = new SubmitQuoteUseCase(
          txRunner,
          asQuoteRequestRepo({
            lockById: vi.fn().mockResolvedValue(extremeReq),
            update: vi.fn(async ({ request: updated }) => updated),
          }),
          asRecipientRepo({
            lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
          }),
          asQuoteRepo({
            lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
            create: vi.fn(async ({ quote }) =>
              Quote.reconstitute({ ...quote, id: '409' }),
            ),
          }),
        );
        return extremeUseCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 1,
          expectedQuoteVersion: null,
          unitPrice,
          maxQuantity,
          bidAcceptDeadline: VALID_ACCEPT_DEADLINE,
          committedDeliveryAt: VALID_COMMITTED_DELIVERY,
          now: NOW,
        });
      };

      const minExtreme = await runValidExtreme(1, 1, 500);
      expect(minExtreme.result.quote.unit_price).toBe(1);
      expect(minExtreme.result.quote.max_quantity).toBe(1);

      const maxExtreme = await runValidExtreme(
        999_999_999_999_999,
        2_147_483_647,
        2_147_483_647,
      );
      expect(maxExtreme.result.quote.unit_price).toBe(999_999_999_999_999);
      expect(maxExtreme.result.quote.max_quantity).toBe(2_147_483_647);
    });

    it('SQ-08: enforces actor permissions, suspended workshop rejection, and SEC-06 anti-IDOR 404', async () => {
      const txRunner = new MockTransactionRunner();
      const useCase = new SubmitQuoteUseCase(
        txRunner,
        asQuoteRequestRepo({ lockById: vi.fn().mockResolvedValue(null) }),
        asRecipientRepo({
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
        }),
        asQuoteRepo({
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
        }),
      );

      const baseInput = {
        requestId: '10001',
        expectedRecipientVersion: 1,
        expectedQuoteVersion: null,
        unitPrice: 45000,
        maxQuantity: 100,
        bidAcceptDeadline: VALID_ACCEPT_DEADLINE,
        committedDeliveryAt: VALID_COMMITTED_DELIVERY,
        now: NOW,
      };

      await expect(
        useCase.execute({ ...baseInput, actor: tempPasswordArtisanActor }),
      ).rejects.toThrow(TradingDomainError);
      await expect(
        useCase.execute({ ...baseInput, actor: buyerActor }),
      ).rejects.toThrow(TradingPermissionDeniedError);
      await expect(
        useCase.execute({ ...baseInput, actor: adminActor }),
      ).rejects.toThrow(TradingPermissionDeniedError);
      await expect(
        useCase.execute({ ...baseInput, actor: artisanWithoutWorkshopActor }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      // Missing request -> 404
      await expect(
        useCase.execute({ ...baseInput, actor: artisanActor }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      // Existing request but uninvited workshop -> 404 anti-IDOR
      const uninvitedUseCase = new SubmitQuoteUseCase(
        txRunner,
        asQuoteRequestRepo({
          lockById: vi.fn().mockResolvedValue(createSampleQuoteRequest()),
        }),
        asRecipientRepo({
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
        }),
        asQuoteRepo({
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
        }),
      );
      await expect(
        uninvitedUseCase.execute({ ...baseInput, actor: artisanActor }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      // Suspended workshop -> 422 WORKSHOP_SUSPENDED before locking request
      const suspendedWorkshop = new MockWorkshopContract().givenSuspended('301');
      const lockByIdSpy = vi.fn();
      const suspendedUseCase = new SubmitQuoteUseCase(
        txRunner,
        asQuoteRequestRepo({ lockById: lockByIdSpy }),
        asRecipientRepo({ lockByRequestAndWorkshop: vi.fn() }),
        asQuoteRepo({ lockByRequestAndWorkshop: vi.fn() }),
        suspendedWorkshop,
      );
      await expect(
        suspendedUseCase.execute({ ...baseInput, actor: artisanActor }),
      ).rejects.toThrow(WorkshopSuspended);
      expect(lockByIdSpy).not.toHaveBeenCalled();
    });

    it('SQ-09: enforces BIDDING_CLOSED, INVALID_STATE (draft/cancelled/accepted/in_production/delivered/accepted quote), and CONCURRENCY_CONFLICT', async () => {
      const txRunner = new MockTransactionRunner();

      const runWith = async (
        request: QuoteRequest,
        recipient: RequestRecipient,
        existingQuote: Quote | null,
        expectedRecipientVersion: number,
        expectedQuoteVersion: number | null,
        now: Date = NOW,
      ) => {
        const uc = new SubmitQuoteUseCase(
          txRunner,
          asQuoteRequestRepo({ lockById: vi.fn().mockResolvedValue(request) }),
          asRecipientRepo({
            lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
          }),
          asQuoteRepo({
            lockByRequestAndWorkshop: vi.fn().mockResolvedValue(existingQuote),
          }),
        );
        return uc.execute({
          actor: artisanActor,
          requestId: request.id,
          expectedRecipientVersion,
          expectedQuoteVersion,
          unitPrice: 45000,
          maxQuantity: 100,
          bidAcceptDeadline: VALID_ACCEPT_DEADLINE,
          committedDeliveryAt: VALID_COMMITTED_DELIVERY,
          now,
        });
      };

      const recV1 = createSampleRecipient({ version: 1 });
      const recV2 = createSampleRecipient({ version: 2, response_status: 'quoted' });

      // Closed early
      await expect(
        runWith(
          createSampleQuoteRequest({ bidding_closed_at: NOW }),
          recV1,
          null,
          1,
          null,
        ),
      ).rejects.toThrow(BiddingClosedError);

      // Expired at exact bidding_deadline
      await expect(
        runWith(createSampleQuoteRequest(), recV1, null, 1, null, BIDDING_DEADLINE),
      ).rejects.toThrow(BiddingClosedError);

      // Cancelled request
      await expect(
        runWith(
          createSampleQuoteRequest({ cancelled_at: NOW, cancelled_by: '10' }),
          recV1,
          null,
          1,
          null,
        ),
      ).rejects.toThrow(InvalidStateTransitionError);

      // Disallowed statuses
      for (const status of [
        'draft_request',
        'buyer_accepted',
        'in_production',
        'delivered',
      ] as const) {
        await expect(
          runWith(createSampleQuoteRequest({ status }), recV1, null, 1, null),
        ).rejects.toThrow(InvalidStateTransitionError);
      }

      // Accepted quote cannot be edited
      await expect(
        runWith(
          createSampleQuoteRequest({ status: 'artisans_bidding' }),
          recV2,
          createSampleQuote({ status: 'accepted', version: 1 }),
          2,
          1,
        ),
      ).rejects.toThrow(InvalidStateTransitionError);

      // Concurrency conflicts
      await expect(
        runWith(createSampleQuoteRequest(), recV2, null, 1, null),
      ).rejects.toThrow(ConcurrencyConflictError);

      await expect(
        runWith(createSampleQuoteRequest(), recV1, null, 1, 1),
      ).rejects.toThrow(ConcurrencyConflictError);

      await expect(
        runWith(
          createSampleQuoteRequest({ status: 'artisans_bidding' }),
          recV2,
          createSampleQuote({ version: 1 }),
          2,
          null,
        ),
      ).rejects.toThrow(ConcurrencyConflictError);

      await expect(
        runWith(
          createSampleQuoteRequest({ status: 'artisans_bidding' }),
          recV2,
          createSampleQuote({ version: 2 }),
          2,
          1,
        ),
      ).rejects.toThrow(ConcurrencyConflictError);
    });

    it('SQ-10: acquires locks in strict order (Workshop -> QuoteRequest -> RequestRecipient -> Quote) and reuses external input.tx', async () => {
      const callOrder: string[] = [];
      const txRunner = new MockTransactionRunner();
      const externalTx = { txId: 'external-tx-1' } as unknown as TransactionContext;

      const workshopContract = new MockWorkshopContract().givenActiveWorkshops('301');
      const origLockWs = workshopContract.lockAndAssertActive.getMockImplementation();
      if (!origLockWs) {
        throw new Error('Expected mock lockAndAssertActive implementation');
      }
      workshopContract.lockAndAssertActive.mockImplementation(async (ids, tx) => {
        callOrder.push('workshop');
        return origLockWs(ids, tx);
      });
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Minh Long',
        status: 'active',
        isProfilePublic: true,
      });

      const quoteRequestRepo = {
        lockById: vi.fn(async () => {
          callOrder.push('request');
          return createSampleQuoteRequest({ status: 'sent_to_artisans', version: 2 });
        }),
        update: vi.fn(async ({ request }) => request),
      };
      const recipientRepo = {
        lockByRequestAndWorkshop: vi.fn(async () => {
          callOrder.push('recipient');
          return createSampleRecipient({ version: 1 });
        }),
      };
      const quoteRepo = {
        lockByRequestAndWorkshop: vi.fn(async () => {
          callOrder.push('quote');
          return null;
        }),
        create: vi.fn(async ({ quote }) => Quote.reconstitute({ ...quote, id: '401' })),
      };

      const useCase = new SubmitQuoteUseCase(
        txRunner,
        asQuoteRequestRepo(quoteRequestRepo),
        asRecipientRepo(recipientRepo),
        asQuoteRepo(quoteRepo),
        workshopContract,
      );

      await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 1,
        expectedQuoteVersion: null,
        unitPrice: 45000,
        maxQuantity: 300,
        bidAcceptDeadline: VALID_ACCEPT_DEADLINE,
        committedDeliveryAt: VALID_COMMITTED_DELIVERY,
        now: NOW,
        tx: externalTx,
      });

      expect(callOrder).toEqual(['workshop', 'request', 'recipient', 'quote']);
      expect(txRunner.contexts).toHaveLength(0);
      expect(workshopContract.lockAndAssertActive).toHaveBeenCalledWith(['301'], externalTx);
      expect(quoteRequestRepo.lockById).toHaveBeenCalledWith('10001', externalTx);
      expect(recipientRepo.lockByRequestAndWorkshop).toHaveBeenCalledWith(
        '10001',
        '301',
        externalTx,
      );
      expect(quoteRepo.lockByRequestAndWorkshop).toHaveBeenCalledWith(
        '10001',
        '301',
        externalTx,
      );
    });
  });

  describe('Mock-Prisma Repository & Locking Integration', () => {
    it('PR-01: executes FOR UPDATE locks, creates Quote without hardcoded id (BIGSERIAL), updates RequestRecipient, writes RecipientResponseHistory & first_quote StatusLog', async () => {
      const requestRow = {
        id: 10001n,
        buyer_id: 10n,
        category_id: 3n,
        spec: 'Bộ ấm chén tử sa',
        quantity: 500,
        unit: 'set',
        unit_set_description: '1 ấm, 6 chén',
        status: 'sent_to_artisans',
        delivery_mode: 'at_buyer_address',
        delivery_region: 'Hà Nội, Gia Lâm',
        delivery_address: 'Số 12 Phố Gốm',
        recipient_name: 'Nguyễn Văn Mua',
        recipient_phone: '0901234567',
        bidding_deadline: BIDDING_DEADLINE,
        delivery_deadline: DELIVERY_DEADLINE,
        bidding_closed_at: null,
        split_requested_at: null,
        version: 2,
        cancelled_at: null,
        cancelled_by: null,
        cancel_reason: null,
        created_at: SENT_AT,
        updated_at: SENT_AT,
      };
      const recipientRow = {
        id: 11001n,
        request_id: 10001n,
        workshop_id: 301n,
        response_status: 'pending',
        decline_reason: null,
        responded_by: null,
        responded_at: null,
        sent_at: SENT_AT,
        version: 1,
      };
      const createdQuoteRow = {
        id: 888n,
        request_id: 10001n,
        workshop_id: 301n,
        unit_price: new Prisma.Decimal('45000'),
        max_quantity: 300,
        bid_accept_deadline: VALID_ACCEPT_DEADLINE,
        committed_delivery_at: VALID_COMMITTED_DELIVERY,
        status: 'active',
        version: 1,
        withdraw_reason: null,
        withdrawn_by: null,
        withdrawn_at: null,
        created_at: NOW,
        updated_at: NOW,
      };

      const mockClient = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: 10001n }])
          .mockResolvedValueOnce([{ id: 11001n }])
          .mockResolvedValueOnce([]),
        quoteRequest: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(requestRow)
            .mockResolvedValueOnce({
              ...requestRow,
              status: 'artisans_bidding',
              version: 3,
              updated_at: NOW,
            }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        requestRecipient: {
          findUnique: vi.fn().mockResolvedValue(recipientRow),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        quote: {
          create: vi.fn().mockResolvedValue(createdQuoteRow),
        },
        recipientResponseHistory: {
          create: vi.fn().mockResolvedValue({ id: 7001n }),
        },
        statusLog: {
          create: vi.fn().mockResolvedValue({ id: 9001n }),
        },
      };

      const mockPrismaService = {
        $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn(mockClient),
        ),
      } as unknown as PrismaService;

      const txRunner = new PrismaTransactionRunner(mockPrismaService);
      const useCase = new SubmitQuoteUseCase(
        txRunner,
        new PrismaQuoteRequestRepository(txRunner),
        new PrismaRequestRecipientRepository(txRunner),
        new PrismaQuoteRepository(txRunner),
      );

      const output = await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 1,
        expectedQuoteVersion: null,
        unitPrice: 45000,
        maxQuantity: 300,
        bidAcceptDeadline: VALID_ACCEPT_DEADLINE,
        committedDeliveryAt: VALID_COMMITTED_DELIVERY,
        now: NOW,
      });

      expect(output.result.quote.id).toBe('888');
      expect(mockClient.$queryRaw).toHaveBeenCalledTimes(3);

      // Verify BIGSERIAL id is NOT included in quote.create data
      const quoteCreateArg = mockClient.quote.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(quoteCreateArg.data.id).toBeUndefined();
      expect(quoteCreateArg.data.request_id).toBe(10001n);
      expect(quoteCreateArg.data.workshop_id).toBe(301n);

      // Verify RecipientResponseHistory receives the DB-assigned quote_id
      const historyCreateArg =
        mockClient.recipientResponseHistory.create.mock.calls[0][0] as {
          data: Record<string, unknown>;
        };
      expect(historyCreateArg.data.quote_id).toBe(888n);
      expect(historyCreateArg.data.event_type).toBe('quote_submitted');

      // Verify StatusLog first_quote written
      expect(mockClient.statusLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          request_id: 10001n,
          event_type: 'first_quote',
          prev_status: 'sent_to_artisans',
          new_status: 'artisans_bidding',
          performed_by: 20n,
        }),
      });
    });

    it('PR-02: updateMany enforces optimistic Quote.version check and throws ConcurrencyConflictError on count 0', async () => {
      const requestRow = {
        id: 10001n,
        buyer_id: 10n,
        category_id: 3n,
        spec: 'Bộ ấm chén tử sa',
        quantity: 500,
        unit: 'set',
        unit_set_description: '1 ấm, 6 chén',
        status: 'artisans_bidding',
        delivery_mode: 'at_buyer_address',
        delivery_region: 'Hà Nội, Gia Lâm',
        delivery_address: 'Số 12 Phố Gốm',
        recipient_name: 'Nguyễn Văn Mua',
        recipient_phone: '0901234567',
        bidding_deadline: BIDDING_DEADLINE,
        delivery_deadline: DELIVERY_DEADLINE,
        bidding_closed_at: null,
        split_requested_at: null,
        version: 3,
        cancelled_at: null,
        cancelled_by: null,
        cancel_reason: null,
        created_at: SENT_AT,
        updated_at: SENT_AT,
      };
      const recipientRow = {
        id: 11001n,
        request_id: 10001n,
        workshop_id: 301n,
        response_status: 'quoted',
        decline_reason: null,
        responded_by: 20n,
        responded_at: SENT_AT,
        sent_at: SENT_AT,
        version: 2,
      };
      const quoteRow = {
        id: 888n,
        request_id: 10001n,
        workshop_id: 301n,
        unit_price: new Prisma.Decimal('45000'),
        max_quantity: 300,
        bid_accept_deadline: VALID_ACCEPT_DEADLINE,
        committed_delivery_at: VALID_COMMITTED_DELIVERY,
        status: 'active',
        version: 1,
        withdraw_reason: null,
        withdrawn_by: null,
        withdrawn_at: null,
        created_at: SENT_AT,
        updated_at: SENT_AT,
      };

      const mockClient = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: 10001n }])
          .mockResolvedValueOnce([{ id: 11001n }])
          .mockResolvedValueOnce([{ id: 888n }]),
        quoteRequest: {
          findUnique: vi.fn().mockResolvedValue(requestRow),
        },
        requestRecipient: {
          findUnique: vi.fn().mockResolvedValue(recipientRow),
        },
        quote: {
          findUnique: vi.fn().mockResolvedValue(quoteRow),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      };

      const mockPrismaService = {
        $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn(mockClient),
        ),
      } as unknown as PrismaService;

      const txRunner = new PrismaTransactionRunner(mockPrismaService);
      const useCase = new SubmitQuoteUseCase(
        txRunner,
        new PrismaQuoteRequestRepository(txRunner),
        new PrismaRequestRecipientRepository(txRunner),
        new PrismaQuoteRepository(txRunner),
      );

      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 2,
          expectedQuoteVersion: 1,
          unitPrice: 43000,
          maxQuantity: 350,
          bidAcceptDeadline: VALID_ACCEPT_DEADLINE,
          committedDeliveryAt: VALID_COMMITTED_DELIVERY,
          now: NOW,
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      expect(mockClient.quote.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 888n, version: 1 },
        }),
      );
    });
  });

  describe('HTTP Controller, ValidationPipe, Guards, Idempotency & CurrentStateResolver (POST /api/v1/artisan/quote-requests/:id/quote)', () => {
    let app: NestExpressApplication;
    let base: string;
    let identityMock: MockIdentityContract;
    let workshopMock: MockWorkshopContract;

    const requestsStore = new Map<string, QuoteRequest>();
    const recipientsStore = new Map<string, RequestRecipient>();
    const quotesStore = new Map<string, Quote>();
    const idempotencyStore = new Map<string, PersistedIdempotencyRecord<unknown>>();
    const historyLog: RecipientResponseRecord[] = [];
    const statusLogs: StatusLogRecord[] = [];
    let nextIdempotencySeq = 19001;
    let nextQuoteSeq = 5001;

    function compositeKey(requestId: string, workshopId: string): string {
      return `${requestId}:${workshopId}`;
    }

    function scopeKey(scope: IdempotencyScopeKey): string {
      return [
        scope.account_id,
        scope.action,
        scope.object_type,
        scope.object_id,
        scope.idempotency_key,
      ].join('|');
    }

    const inMemoryQuoteRequestRepo = {
      findById: vi.fn(async (id: string) => requestsStore.get(id) ?? null),
      lockById: vi.fn(async (id: string) => requestsStore.get(id) ?? null),
      update: vi.fn(
        async ({
          request,
          expectedVersion,
          statusLogs: logs,
        }: {
          request: QuoteRequest;
          expectedVersion?: number;
          statusLogs?: readonly StatusLogRecord[];
        }) => {
          const current = requestsStore.get(request.id);
          if (!current || (expectedVersion && current.version !== expectedVersion)) {
            throw new ConcurrencyConflictError('QuoteRequest version conflict');
          }
          requestsStore.set(request.id, request);
          if (logs) {
            statusLogs.push(...logs);
          }
          return request;
        },
      ),
      findArtisanQuoteRequests: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    };

    const inMemoryRecipientRepo = {
      findById: vi.fn(async (id: string) => {
        for (const r of recipientsStore.values()) {
          if (r.id === id) return r;
        }
        return null;
      }),
      findByRequestAndWorkshop: vi.fn(
        async (requestId: string, workshopId: string) =>
          recipientsStore.get(compositeKey(requestId, workshopId)) ?? null,
      ),
      lockByRequestAndWorkshop: vi.fn(
        async (requestId: string, workshopId: string) =>
          recipientsStore.get(compositeKey(requestId, workshopId)) ?? null,
      ),
      update: vi.fn(
        async ({
          recipient,
          expectedVersion,
          history,
        }: {
          recipient: RequestRecipient;
          expectedVersion?: number;
          history?: RecipientResponseRecord;
        }) => {
          const key = compositeKey(recipient.request_id, recipient.workshop_id);
          const current = recipientsStore.get(key);
          if (!current || (expectedVersion && current.version !== expectedVersion)) {
            throw new ConcurrencyConflictError('Recipient version mismatch');
          }
          recipientsStore.set(key, recipient);
          if (history) historyLog.push(history);
          return recipient;
        },
      ),
    };

    const inMemoryQuoteRepo = {
      findById: vi.fn(async (id: string) => {
        for (const q of quotesStore.values()) {
          if (q.id === id) return q;
        }
        return null;
      }),
      findByRequestAndWorkshop: vi.fn(
        async (requestId: string, workshopId: string) =>
          quotesStore.get(compositeKey(requestId, workshopId)) ?? null,
      ),
      lockByRequestAndWorkshop: vi.fn(
        async (requestId: string, workshopId: string) =>
          quotesStore.get(compositeKey(requestId, workshopId)) ?? null,
      ),
      create: vi.fn(
        async ({
          quote,
          recipient,
          recipientHistory,
        }: {
          quote: Quote;
          recipient?: RequestRecipient;
          recipientHistory?: RecipientResponseRecord;
        }) => {
          const key = compositeKey(quote.request_id, quote.workshop_id);
          if (quotesStore.has(key)) {
            throw new ConcurrencyConflictError('Quote already exists');
          }
          const assignedId = String(nextQuoteSeq++);
          const persistedQuote = Quote.reconstitute({
            ...quote,
            id: assignedId,
          });
          quotesStore.set(key, persistedQuote);
          if (recipient) {
            recipientsStore.set(key, recipient);
          }
          if (recipientHistory) {
            historyLog.push({ ...recipientHistory, quote_id: assignedId });
          }
          return persistedQuote;
        },
      ),
      update: vi.fn(
        async ({
          quote,
          expectedVersion,
          recipient,
          recipientHistory,
        }: {
          quote: Quote;
          expectedVersion?: number;
          recipient?: RequestRecipient;
          recipientHistory?: RecipientResponseRecord;
        }) => {
          const key = compositeKey(quote.request_id, quote.workshop_id);
          const current = quotesStore.get(key);
          if (!current || (expectedVersion && current.version !== expectedVersion)) {
            throw new ConcurrencyConflictError('Quote version mismatch');
          }
          quotesStore.set(key, quote);
          if (recipient) {
            recipientsStore.set(key, recipient);
          }
          if (recipientHistory) {
            historyLog.push(recipientHistory);
          }
          return quote;
        },
      ),
    };

    const inMemoryAllocationRepo = {
      findById: vi.fn().mockResolvedValue(null),
    };

    const inMemoryIdempotencyRepo: IIdempotencyRecordRepository = {
      findByScope: vi.fn(async (scope: IdempotencyScopeKey) => {
        return idempotencyStore.get(scopeKey(scope)) ?? null;
      }) as unknown as IIdempotencyRecordRepository['findByScope'],
      save: vi.fn(async (input: CreateIdempotencyRecordInput<unknown>) => {
        const key = scopeKey(input);
        if (idempotencyStore.has(key)) {
          const err = new Error('Unique constraint failed (P2002)') as Error & {
            code?: string;
          };
          err.code = 'P2002';
          throw err;
        }
        const saved: PersistedIdempotencyRecord<unknown> = {
          id: String(nextIdempotencySeq++),
          idempotency_key: input.idempotency_key,
          request_fingerprint: input.request_fingerprint,
          account_id: input.account_id,
          action: input.action,
          object_type: input.object_type,
          object_id: input.object_id,
          result_snapshot: input.result_snapshot,
          created_at: input.created_at,
          expires_at: input.expires_at,
        };
        idempotencyStore.set(key, saved);
        return saved;
      }) as unknown as IIdempotencyRecordRepository['save'],
      findAndVerifyReplay: vi.fn(
        async () => null,
      ) as unknown as IIdempotencyRecordRepository['findAndVerifyReplay'],
      deleteExpiredBefore: vi.fn(async () => 0),
    };

    beforeAll(async () => {
      vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/test');
      vi.stubEnv(
        'SESSION_SECRET',
        'test_secret_32_chars_for_development_purposes',
      );
      vi.stubEnv('NODE_ENV', 'development');

      identityMock = new MockIdentityContract();
      workshopMock = new MockWorkshopContract();

      class TestIdentityModule {}
      Module({
        providers: [{ provide: IDENTITY_CONTRACT, useValue: identityMock }],
        exports: [IDENTITY_CONTRACT],
      })(TestIdentityModule);

      class TestHttpTradingModule {}
      Module({
        imports: [AppConfigModule, SecurityModule.register([TestIdentityModule])],
        controllers: [ArtisanQuoteRequestController],
        providers: [
          { provide: TRANSACTION_RUNNER, useClass: MockTransactionRunner },
          {
            provide: QUOTE_REQUEST_REPOSITORY,
            useValue: asQuoteRequestRepo(inMemoryQuoteRequestRepo),
          },
          {
            provide: REQUEST_RECIPIENT_REPOSITORY,
            useValue: asRecipientRepo(inMemoryRecipientRepo),
          },
          {
            provide: QUOTE_REPOSITORY,
            useValue: asQuoteRepo(inMemoryQuoteRepo),
          },
          {
            provide: ALLOCATION_REPOSITORY,
            useValue: asAllocationRepo(inMemoryAllocationRepo),
          },
          {
            provide: IDEMPOTENCY_RECORD_REPOSITORY,
            useValue: asIdempotencyRepo(inMemoryIdempotencyRepo),
          },
          { provide: WORKSHOP_CONTRACT, useValue: workshopMock },
          {
            provide: TradingIdempotencyService,
            useFactory: (
              repo: IIdempotencyRecordRepository,
              txRunner: TransactionRunner,
            ) => new TradingIdempotencyService(repo, txRunner),
            inject: [IDEMPOTENCY_RECORD_REPOSITORY, TRANSACTION_RUNNER],
          },
          {
            provide: TRADING_CURRENT_STATE_RESOLVER,
            useFactory: (
              qrRepo: IQuoteRequestRepository,
              allocRepo: IAllocationRepository,
              qRepo: IQuoteRepository,
              recRepo: IRequestRecipientRepository,
            ) =>
              new TradingCurrentStateResolver(qrRepo, allocRepo, qRepo, recRepo),
            inject: [
              QUOTE_REQUEST_REPOSITORY,
              ALLOCATION_REPOSITORY,
              QUOTE_REPOSITORY,
              REQUEST_RECIPIENT_REPOSITORY,
            ],
          },
          TradingMutationInterceptor,
          {
            provide: ListArtisanQuoteRequestsUseCase,
            useFactory: (
              txRunner: TransactionRunner,
              qrRepo: IQuoteRequestRepository,
            ) => new ListArtisanQuoteRequestsUseCase(txRunner, qrRepo),
            inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
          },
          {
            provide: DeclineQuoteRequestUseCase,
            useFactory: (
              txRunner: TransactionRunner,
              qrRepo: IQuoteRequestRepository,
              recRepo: IRequestRecipientRepository,
              qRepo: IQuoteRepository,
              wsContract: IWorkshopContract,
            ) =>
              new DeclineQuoteRequestUseCase(
                txRunner,
                qrRepo,
                recRepo,
                qRepo,
                wsContract,
              ),
            inject: [
              TRANSACTION_RUNNER,
              QUOTE_REQUEST_REPOSITORY,
              REQUEST_RECIPIENT_REPOSITORY,
              QUOTE_REPOSITORY,
              WORKSHOP_CONTRACT,
            ],
          },
          {
            provide: SubmitQuoteUseCase,
            useFactory: (
              txRunner: TransactionRunner,
              qrRepo: IQuoteRequestRepository,
              recRepo: IRequestRecipientRepository,
              qRepo: IQuoteRepository,
              wsContract: IWorkshopContract,
            ) =>
              new SubmitQuoteUseCase(
                txRunner,
                qrRepo,
                recRepo,
                qRepo,
                wsContract,
              ),
            inject: [
              TRANSACTION_RUNNER,
              QUOTE_REQUEST_REPOSITORY,
              REQUEST_RECIPIENT_REPOSITORY,
              QUOTE_REPOSITORY,
              WORKSHOP_CONTRACT,
            ],
          },
        ],
      })(TestHttpTradingModule);

      app = await NestFactory.create<NestExpressApplication>(
        TestHttpTradingModule,
        {
          bodyParser: false,
          logger: false,
          abortOnError: false,
        },
      );
      configureHttp(
        app,
        new AppLogger('error', (_line, done) => done()),
      );
      await app.listen(0, '127.0.0.1');
      base = await app.getUrl();
    });

    afterAll(async () => {
      await app.close();
      vi.unstubAllEnvs();
    });

    let futureBiddingDeadline: Date;
    let futureDeliveryDeadline: Date;
    let validAcceptDeadlineIso: string;
    let validCommittedDeliveryIso: string;

    beforeEach(() => {
      requestsStore.clear();
      recipientsStore.clear();
      quotesStore.clear();
      idempotencyStore.clear();
      historyLog.length = 0;
      statusLogs.length = 0;
      nextIdempotencySeq = 19001;
      nextQuoteSeq = 5001;
      vi.clearAllMocks();

      const nowMs = Date.now();
      futureBiddingDeadline = new Date(nowMs + 2 * 86_400_000);
      futureDeliveryDeadline = new Date(nowMs + 14 * 86_400_000);
      validAcceptDeadlineIso = new Date(
        futureBiddingDeadline.getTime() + TWENTY_FOUR_HOURS_MS + 3_600_000,
      ).toISOString();
      validCommittedDeliveryIso = new Date(
        futureDeliveryDeadline.getTime() - 3_600_000,
      ).toISOString();

      requestsStore.set(
        '10001',
        createSampleQuoteRequest({
          id: '10001',
          status: 'sent_to_artisans',
          version: 2,
          bidding_deadline: futureBiddingDeadline,
          delivery_deadline: futureDeliveryDeadline,
        }),
      );
      recipientsStore.set(
        compositeKey('10001', '301'),
        createSampleRecipient({
          id: '11001',
          request_id: '10001',
          workshop_id: '301',
          response_status: 'pending',
          version: 1,
        }),
      );

      workshopMock.givenActiveWorkshops('301', '302');
      workshopMock.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Minh Long',
        status: 'active',
        isProfilePublic: true,
      });

      identityMock.resolveSession.mockImplementation(async (token: string) => {
        if (token === 'artisan-token') return artisanActor;
        if (token === 'other-artisan-token') return otherArtisanActor;
        if (token === 'no-workshop-token') return artisanWithoutWorkshopActor;
        if (token === 'temp-artisan-token') return tempPasswordArtisanActor;
        if (token === 'buyer-token') return buyerActor;
        if (token === 'admin-token') return adminActor;
        return null;
      });
    });

    it('HT-01: initial quote submission returns 201 Created, transitions request to artisans_bidding, and includes request+recipient+quote in operation.current_state', async () => {
      const res = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            expected_quote_version: null,
            unit_price: 45000,
            max_quantity: 300,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );

      expect(res.status).toBe(201);
      expect(res.headers.get('cache-control')).toContain('no-store');
      const body = await readJson<SubmitQuoteSuccessBody>(res);
      quoteMutationDtoResponseSchema.parse(body.data);
      submitQuoteOperationResponseSchema.parse(body.operation);
      expect(body).toMatchObject({
        success: true,
        data: {
          quote: {
            id: '5001',
            request_id: '10001',
            workshop: { id: '301', name: 'Xưởng Gốm Minh Long' },
            unit_price: 45000,
            max_quantity: 300,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
            status: 'active',
            version: 1,
            withdraw_reason: null,
            withdrawn_at: null,
            is_eligible: true,
            ineligible_reasons: [],
          },
          recipient: {
            id: '11001',
            request_id: '10001',
            workshop: { id: '301', name: 'Xưởng Gốm Minh Long' },
            response_status: 'quoted',
            version: 2,
            decline_reason: null,
            eligibility_labels: [],
          },
        },
        operation: {
          id: '19001',
          replayed: false,
          current_state: {
            request: {
              id: '10001',
              status: 'artisans_bidding',
              version: 3,
              cancelled_at: null,
            },
            recipient: {
              id: '11001',
              status: 'quoted',
              version: 2,
            },
            quote: {
              id: '5001',
              status: 'active',
              version: 1,
            },
          },
        },
      });
      expect(statusLogs).toHaveLength(1);
      expect(statusLogs[0].event_type).toBe('first_quote');
    });

    it('HT-02 & HT-03: editing active quote and resubmitting withdrawn quote both return 200 OK with incremented version and cleared withdraw fields', async () => {
      // 1. Initial submit (201)
      const createRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            expected_quote_version: null,
            unit_price: 45000,
            max_quantity: 300,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(createRes.status).toBe(201);

      // 2. Edit active quote (200)
      const editRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_2,
          },
          body: JSON.stringify({
            expected_recipient_version: 2,
            expected_quote_version: 1,
            unit_price: 42000,
            max_quantity: 400,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(editRes.status).toBe(200);
      expect(editRes.headers.get('cache-control')).toContain('no-store');
      const editBody = await readJson<SubmitQuoteSuccessBody>(editRes);
      quoteMutationDtoResponseSchema.parse(editBody.data);
      submitQuoteOperationResponseSchema.parse(editBody.operation);
      expect(editBody.data.quote.version).toBe(2);
      expect(editBody.data.quote.unit_price).toBe(42000);
      expect(editBody.data.recipient.version).toBe(3);
      expect(editBody.operation.current_state.quote).toEqual({
        id: '5001',
        status: 'active',
        version: 2,
      });

      // 3. Simulate withdrawal in store, then resubmit (200)
      const currentQuote = quotesStore.get(compositeKey('10001', '301'));
      if (!currentQuote) {
        throw new Error('Expected quote 10001:301 in store');
      }
      quotesStore.set(
        compositeKey('10001', '301'),
        Quote.reconstitute({
          ...currentQuote,
          status: 'withdrawn',
          version: 3,
          withdraw_reason: 'Tạm bảo trì lò nung',
          withdrawn_by: '20',
          withdrawn_at: new Date(),
        }),
      );
      const currentRec = recipientsStore.get(compositeKey('10001', '301'));
      if (!currentRec) {
        throw new Error('Expected recipient 10001:301 in store');
      }
      recipientsStore.set(
        compositeKey('10001', '301'),
        RequestRecipient.reconstitute({
          ...currentRec,
          response_status: 'withdrawn',
          version: 4,
        }),
      );

      const resubmitRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_3,
          },
          body: JSON.stringify({
            expected_recipient_version: 4,
            expected_quote_version: 3,
            unit_price: 44000,
            max_quantity: 350,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(resubmitRes.status).toBe(200);
      expect(resubmitRes.headers.get('cache-control')).toContain('no-store');
      const resubmitBody = await readJson<SubmitQuoteSuccessBody>(resubmitRes);
      quoteMutationDtoResponseSchema.parse(resubmitBody.data);
      submitQuoteOperationResponseSchema.parse(resubmitBody.operation);
      expect(resubmitBody.data.quote.status).toBe('active');
      expect(resubmitBody.data.quote.version).toBe(4);
      expect(resubmitBody.data.quote.withdraw_reason).toBeNull();
      expect(resubmitBody.data.quote.withdrawn_at).toBeNull();
      expect(resubmitBody.data.recipient.response_status).toBe('quoted');
      expect(resubmitBody.data.recipient.version).toBe(5);
    });

    it('HT-04: idempotency replay preserves 201/200 status, cached data, and fresh current_state; changed payload returns 409 IDEMPOTENCY_CONFLICT', async () => {
      const initialPayload = {
        expected_recipient_version: 1,
        expected_quote_version: null,
        unit_price: 45000,
        max_quantity: 300,
        bid_accept_deadline: validAcceptDeadlineIso,
        committed_delivery_at: validCommittedDeliveryIso,
      };

      const firstCreate = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify(initialPayload),
        },
      );
      expect(firstCreate.status).toBe(201);

      // Subsequent edit bumps quote to v2 and recipient to v3
      const editPayload = {
        expected_recipient_version: 2,
        expected_quote_version: 1,
        unit_price: 41000,
        max_quantity: 350,
        bid_accept_deadline: validAcceptDeadlineIso,
        committed_delivery_at: validCommittedDeliveryIso,
      };
      const firstEdit = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_2,
          },
          body: JSON.stringify(editPayload),
        },
      );
      expect(firstEdit.status).toBe(200);

      // Replay initial creation -> still 201, cached v1 quote, but fresh current_state (v2 quote / v3 recipient)!
      const replayCreate = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify(initialPayload),
        },
      );
      expect(replayCreate.status).toBe(201);
      const replayCreateBody =
        await readJson<SubmitQuoteSuccessBody>(replayCreate);
      quoteMutationDtoResponseSchema.parse(replayCreateBody.data);
      submitQuoteOperationResponseSchema.parse(replayCreateBody.operation);
      expect(replayCreateBody.data.quote.version).toBe(1);
      expect(replayCreateBody.data.quote.unit_price).toBe(45000);
      expect(replayCreateBody.operation.replayed).toBe(true);
      expect(replayCreateBody.operation.current_state).toEqual({
        request: {
          id: '10001',
          status: 'artisans_bidding',
          version: 3,
          cancelled_at: null,
        },
        recipient: {
          id: '11001',
          status: 'quoted',
          version: 3,
        },
        quote: {
          id: '5001',
          status: 'active',
          version: 2,
        },
      });

      // Replay edit -> 200 OK with replayed: true
      const replayEdit = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_2,
          },
          body: JSON.stringify(editPayload),
        },
      );
      expect(replayEdit.status).toBe(200);
      const replayEditBody = await readJson<SubmitQuoteSuccessBody>(replayEdit);
      quoteMutationDtoResponseSchema.parse(replayEditBody.data);
      submitQuoteOperationResponseSchema.parse(replayEditBody.operation);
      expect(replayEditBody.operation.replayed).toBe(true);
      expect(replayEditBody.data.quote.version).toBe(2);

      // Same key with different payload -> 409 IDEMPOTENCY_CONFLICT
      const conflictRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_2,
          },
          body: JSON.stringify({
            ...editPayload,
            unit_price: 99999,
          }),
        },
      );
      expect(conflictRes.status).toBe(409);
      expect(conflictRes.headers.get('content-type')).toContain(
        'application/problem+json',
      );
      const conflictBody = await readJson<ProblemDetailsBody>(conflictRes);
      expect(conflictBody.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('HT-05: enforces auth, roles, temp_password restriction, and anti-IDOR 404', async () => {
      const validBody = JSON.stringify({
        expected_recipient_version: 1,
        expected_quote_version: null,
        unit_price: 45000,
        max_quantity: 300,
        bid_accept_deadline: validAcceptDeadlineIso,
        committed_delivery_at: validCommittedDeliveryIso,
      });

      // Unauthenticated -> 401
      const unauthRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: validBody,
        },
      );
      expect(unauthRes.status).toBe(401);

      // Buyer -> 403 PERMISSION_DENIED
      const buyerRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=buyer-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: validBody,
        },
      );
      expect(buyerRes.status).toBe(403);
      expect((await readJson<ProblemDetailsBody>(buyerRes)).code).toBe(
        'PERMISSION_DENIED',
      );

      // temp_password -> 403 TEMP_PASSWORD_RESTRICTED
      const tempRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=temp-artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: validBody,
        },
      );
      expect(tempRes.status).toBe(403);
      expect((await readJson<ProblemDetailsBody>(tempRes)).code).toBe(
        'TEMP_PASSWORD_RESTRICTED',
      );

      // Uninvited workshop -> 404 RESOURCE_NOT_FOUND
      const uninvitedRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=other-artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: validBody,
        },
      );
      expect(uninvitedRes.status).toBe(404);
      expect((await readJson<ProblemDetailsBody>(uninvitedRes)).code).toBe(
        'RESOURCE_NOT_FOUND',
      );
    });

    it('HT-06: rejects invalid X-Idempotency-Key, bad :id, strict extra keys, string coercion, bad dates, and max_quantity > request.quantity with 400 INVALID_INPUT', async () => {
      // Missing X-Idempotency-Key
      const noKeyRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            expected_quote_version: null,
            unit_price: 45000,
            max_quantity: 300,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(noKeyRes.status).toBe(400);
      expect((await readJson<ProblemDetailsBody>(noKeyRes)).code).toBe(
        'INVALID_INPUT',
      );

      // Invalid :id
      const badIdRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/abc/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            expected_quote_version: null,
            unit_price: 45000,
            max_quantity: 300,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(badIdRes.status).toBe(400);
      expect((await readJson<ProblemDetailsBody>(badIdRes)).code).toBe(
        'INVALID_INPUT',
      );

      // Extra unknown key + string price + non-offset datetime -> 400 with JSON Pointer errors
      const zodFailRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            expected_quote_version: null,
            unit_price: '45000',
            max_quantity: 300,
            bid_accept_deadline: '2026-12-03T10:00:00',
            committed_delivery_at: validCommittedDeliveryIso,
            workshop_id: '999',
          }),
        },
      );
      expect(zodFailRes.status).toBe(400);
      const zodFailBody = await readJson<ProblemDetailsBody>(zodFailRes);
      expect(zodFailBody.code).toBe('INVALID_INPUT');
      expect(zodFailBody.tracking_id).toBe(
        zodFailRes.headers.get('x-request-id'),
      );
      expect(zodFailBody.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: '/unit_price' }),
          expect.objectContaining({ field: '/bid_accept_deadline' }),
          expect.objectContaining({ field: '/workshop_id' }),
        ]),
      );

      // max_quantity > request.quantity -> 400 INVALID_INPUT
      const overQtyRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_2,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            expected_quote_version: null,
            unit_price: 45000,
            max_quantity: 501,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(overQtyRes.status).toBe(400);
      expect((await readJson<ProblemDetailsBody>(overQtyRes)).code).toBe(
        'INVALID_INPUT',
      );

      // Version field rejections (omitted, 0, string coercion) & numeric boundary rejections
      const invalidPayloads: Array<Record<string, unknown>> = [
        {
          expected_recipient_version: 1,
          unit_price: 45000,
          max_quantity: 300,
          bid_accept_deadline: validAcceptDeadlineIso,
          committed_delivery_at: validCommittedDeliveryIso,
        },
        {
          expected_recipient_version: 1,
          expected_quote_version: 0,
          unit_price: 45000,
          max_quantity: 300,
          bid_accept_deadline: validAcceptDeadlineIso,
          committed_delivery_at: validCommittedDeliveryIso,
        },
        {
          expected_recipient_version: 1,
          expected_quote_version: '1',
          unit_price: 45000,
          max_quantity: 300,
          bid_accept_deadline: validAcceptDeadlineIso,
          committed_delivery_at: validCommittedDeliveryIso,
        },
        {
          expected_recipient_version: '1',
          expected_quote_version: null,
          unit_price: 45000,
          max_quantity: 300,
          bid_accept_deadline: validAcceptDeadlineIso,
          committed_delivery_at: validCommittedDeliveryIso,
        },
        {
          expected_recipient_version: 1,
          expected_quote_version: null,
          unit_price: 0,
          max_quantity: 300,
          bid_accept_deadline: validAcceptDeadlineIso,
          committed_delivery_at: validCommittedDeliveryIso,
        },
        {
          expected_recipient_version: 1,
          expected_quote_version: null,
          unit_price: -1,
          max_quantity: 300,
          bid_accept_deadline: validAcceptDeadlineIso,
          committed_delivery_at: validCommittedDeliveryIso,
        },
        {
          expected_recipient_version: 1,
          expected_quote_version: null,
          unit_price: 1_000_000_000_000_000,
          max_quantity: 300,
          bid_accept_deadline: validAcceptDeadlineIso,
          committed_delivery_at: validCommittedDeliveryIso,
        },
        {
          expected_recipient_version: 1,
          expected_quote_version: null,
          unit_price: 45000,
          max_quantity: 0,
          bid_accept_deadline: validAcceptDeadlineIso,
          committed_delivery_at: validCommittedDeliveryIso,
        },
        {
          expected_recipient_version: 1,
          expected_quote_version: null,
          unit_price: 45000,
          max_quantity: -1,
          bid_accept_deadline: validAcceptDeadlineIso,
          committed_delivery_at: validCommittedDeliveryIso,
        },
        {
          expected_recipient_version: 1,
          expected_quote_version: null,
          unit_price: 45000,
          max_quantity: 2_147_483_648,
          bid_accept_deadline: validAcceptDeadlineIso,
          committed_delivery_at: validCommittedDeliveryIso,
        },
      ];

      for (const badPayload of invalidPayloads) {
        const badRes = await fetch(
          `${base}/api/v1/artisan/quote-requests/10001/quote`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: 'vcraft-session=artisan-token',
              'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
            },
            body: JSON.stringify(badPayload),
          },
        );
        expect(badRes.status).toBe(400);
        expect((await readJson<ProblemDetailsBody>(badRes)).code).toBe(
          'INVALID_INPUT',
        );
      }

      expect(quotesStore.size).toBe(0);
    });

    it('HT-07: rejects 422 DEADLINE_VIOLATION, BIDDING_CLOSED, WORKSHOP_SUSPENDED, INVALID_STATE, and 409 CONCURRENCY_CONFLICT with RFC 9457 Problem Details and zero state mutation', async () => {
      // 1. DEADLINE_VIOLATION (committed_delivery_at > delivery_deadline)
      const deadlineRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            expected_quote_version: null,
            unit_price: 45000,
            max_quantity: 300,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: new Date(
              futureDeliveryDeadline.getTime() + 1_000,
            ).toISOString(),
          }),
        },
      );
      expect(deadlineRes.status).toBe(422);
      const deadlineBody = await readJson<ProblemDetailsBody>(deadlineRes);
      expect(deadlineBody.code).toBe('DEADLINE_VIOLATION');
      expect(deadlineBody.tracking_id).toBe(
        deadlineRes.headers.get('x-request-id'),
      );
      expect(quotesStore.size).toBe(0);

      // 2. WORKSHOP_SUSPENDED
      workshopMock.givenSuspended('301');
      const suspendedRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_2,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            expected_quote_version: null,
            unit_price: 45000,
            max_quantity: 300,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(suspendedRes.status).toBe(422);
      expect((await readJson<ProblemDetailsBody>(suspendedRes)).code).toBe(
        'WORKSHOP_SUSPENDED',
      );
      workshopMock.givenActiveWorkshops('301', '302');

      // 3a. BIDDING_CLOSED (via bidding_closed_at)
      const origReq = requestsStore.get('10001');
      if (!origReq) {
        throw new Error('Expected request 10001 in store');
      }
      requestsStore.set(
        '10001',
        createSampleQuoteRequest({
          id: '10001',
          status: 'sent_to_artisans',
          version: 2,
          bidding_deadline: futureBiddingDeadline,
          delivery_deadline: futureDeliveryDeadline,
          bidding_closed_at: new Date(),
        }),
      );
      const closedRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_3,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            expected_quote_version: null,
            unit_price: 45000,
            max_quantity: 300,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(closedRes.status).toBe(422);
      expect((await readJson<ProblemDetailsBody>(closedRes)).code).toBe(
        'BIDDING_CLOSED',
      );

      // 3b. BIDDING_CLOSED (via expired bidding_deadline with bidding_closed_at === null)
      requestsStore.set(
        '10001',
        createSampleQuoteRequest({
          id: '10001',
          status: 'sent_to_artisans',
          version: 2,
          bidding_deadline: new Date(Date.now() - 1_000),
          delivery_deadline: futureDeliveryDeadline,
          bidding_closed_at: null,
        }),
      );
      const expiredBiddingRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_3,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            expected_quote_version: null,
            unit_price: 45000,
            max_quantity: 300,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(expiredBiddingRes.status).toBe(422);
      expect((await readJson<ProblemDetailsBody>(expiredBiddingRes)).code).toBe(
        'BIDDING_CLOSED',
      );
      expect(quotesStore.size).toBe(0);

      // 4a. INVALID_STATE (disallowed QuoteRequest state: buyer_accepted)
      requestsStore.set(
        '10001',
        createSampleQuoteRequest({
          id: '10001',
          status: 'buyer_accepted',
          version: 3,
          bidding_deadline: futureBiddingDeadline,
          delivery_deadline: futureDeliveryDeadline,
        }),
      );
      const invalidReqStateRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_3,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            expected_quote_version: null,
            unit_price: 45000,
            max_quantity: 300,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(invalidReqStateRes.status).toBe(422);
      const invalidReqStateBody =
        await readJson<ProblemDetailsBody>(invalidReqStateRes);
      expect(invalidReqStateBody.code).toBe('INVALID_STATE');
      expect(invalidReqStateBody.tracking_id).toBe(
        invalidReqStateRes.headers.get('x-request-id'),
      );
      expect(quotesStore.size).toBe(0);

      // 4b. INVALID_STATE (accepted Quote edit attempt)
      const origRecipient = recipientsStore.get(compositeKey('10001', '301'));
      if (!origRecipient) {
        throw new Error('Expected recipient 10001:301 in store');
      }
      requestsStore.set(
        '10001',
        createSampleQuoteRequest({
          id: '10001',
          status: 'artisans_bidding',
          version: 3,
          bidding_deadline: futureBiddingDeadline,
          delivery_deadline: futureDeliveryDeadline,
        }),
      );
      recipientsStore.set(
        compositeKey('10001', '301'),
        createSampleRecipient({
          id: '11001',
          request_id: '10001',
          workshop_id: '301',
          response_status: 'quoted',
          version: 2,
        }),
      );
      quotesStore.set(
        compositeKey('10001', '301'),
        createSampleQuote({
          id: '5001',
          request_id: '10001',
          workshop_id: '301',
          status: 'accepted',
          version: 1,
          bid_accept_deadline: new Date(validAcceptDeadlineIso),
          committed_delivery_at: new Date(validCommittedDeliveryIso),
        }),
      );
      const acceptedQuoteEditRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_3,
          },
          body: JSON.stringify({
            expected_recipient_version: 2,
            expected_quote_version: 1,
            unit_price: 46000,
            max_quantity: 300,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(acceptedQuoteEditRes.status).toBe(422);
      expect((await readJson<ProblemDetailsBody>(acceptedQuoteEditRes)).code).toBe(
        'INVALID_STATE',
      );
      const storedAcceptedQuote = quotesStore.get(compositeKey('10001', '301'));
      expect(storedAcceptedQuote?.status).toBe('accepted');
      expect(storedAcceptedQuote?.version).toBe(1);

      // Restore clean stores for step 5
      quotesStore.clear();
      recipientsStore.set(compositeKey('10001', '301'), origRecipient);

      // 5. CONCURRENCY_CONFLICT (stale expected_recipient_version)
      requestsStore.set('10001', origReq);
      const conflictRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_4,
          },
          body: JSON.stringify({
            expected_recipient_version: 99,
            expected_quote_version: null,
            unit_price: 45000,
            max_quantity: 300,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(conflictRes.status).toBe(409);
      expect((await readJson<ProblemDetailsBody>(conflictRes)).code).toBe(
        'CONCURRENCY_CONFLICT',
      );
      expect(quotesStore.size).toBe(0);
    });

    it('HT-08: generates valid OpenAPI 3.0.0 Swagger spec for POST /api/v1/artisan/quote-requests/:id/quote and registers SubmitQuoteUseCase in TradingModule', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const route = doc.paths['/api/v1/artisan/quote-requests/{id}/quote']?.post;
      expect(route).toBeDefined();
      expect(route?.operationId).toBe('ArtisanQuoteRequestController_submitQuote');
      expect(route).toHaveProperty('x-roles', ['artisan']);
      expect(route?.parameters).toContainEqual(
        expect.objectContaining({
          name: 'X-Idempotency-Key',
          in: 'header',
          required: true,
        }),
      );
      expect(route?.parameters).toContainEqual(
        expect.objectContaining({
          name: 'X-CSRF-Token',
          in: 'header',
          required: true,
        }),
      );
      expect(route?.requestBody).toMatchObject({
        required: true,
        content: {
          'application/json': {
            schema: {
              additionalProperties: false,
              required: [
                'expected_recipient_version',
                'expected_quote_version',
                'unit_price',
                'max_quantity',
                'bid_accept_deadline',
                'committed_delivery_at',
              ],
            },
          },
        },
      });
      expect(route?.responses?.['201']).toBeDefined();
      expect(route?.responses?.['200']).toBeDefined();
      expect(route?.responses?.['409']).toBeDefined();
      expect(route?.responses?.['422']).toBeDefined();

      const exported = Reflect.getMetadata('exports', TradingModule) as unknown[];
      expect(exported).toContain(SubmitQuoteUseCase);
    });

    it('HT-09: accepts valid boundary extremes for unit_price (1 and 999_999_999_999_999) and max_quantity (1 and 2_147_483_647) over HTTP', async () => {
      const minRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            expected_quote_version: null,
            unit_price: 1,
            max_quantity: 1,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(minRes.status).toBe(201);
      const minBody = await readJson<SubmitQuoteSuccessBody>(minRes);
      quoteMutationDtoResponseSchema.parse(minBody.data);
      expect(minBody.data.quote.unit_price).toBe(1);
      expect(minBody.data.quote.max_quantity).toBe(1);

      // Reset request with max int32 quantity for upper bound check
      requestsStore.set(
        '10002',
        createSampleQuoteRequest({
          id: '10002',
          quantity: 2_147_483_647,
          status: 'sent_to_artisans',
          version: 2,
          bidding_deadline: futureBiddingDeadline,
          delivery_deadline: futureDeliveryDeadline,
        }),
      );
      recipientsStore.set(
        compositeKey('10002', '301'),
        createSampleRecipient({
          id: '11002',
          request_id: '10002',
          workshop_id: '301',
          response_status: 'pending',
          version: 1,
        }),
      );

      const maxRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10002/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_2,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            expected_quote_version: null,
            unit_price: 999_999_999_999_999,
            max_quantity: 2_147_483_647,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(maxRes.status).toBe(201);
      const maxBody = await readJson<SubmitQuoteSuccessBody>(maxRes);
      quoteMutationDtoResponseSchema.parse(maxBody.data);
      expect(maxBody.data.quote.unit_price).toBe(999_999_999_999_999);
      expect(maxBody.data.quote.max_quantity).toBe(2_147_483_647);
    });

    it('HT-10: supports second workshop quote without bumping request version and declined -> quoted transition over HTTP', async () => {
      workshopMock.getWorkshopSummary.mockImplementation(async (wsId: string) => ({
        id: wsId,
        name: wsId === '302' ? 'Xưởng Gốm Bát Tràng 2' : 'Xưởng Gốm Minh Long',
        status: 'active',
        isProfilePublic: true,
      }));

      // 1. Seed declined recipient for workshop 301 and transition declined -> quoted (201 Created)
      recipientsStore.set(
        compositeKey('10001', '301'),
        createSampleRecipient({
          id: '11001',
          request_id: '10001',
          workshop_id: '301',
          response_status: 'declined',
          decline_reason: 'Bận lịch',
          responded_by: '20',
          responded_at: SENT_AT,
          version: 2,
        }),
      );
      const declinedToQuotedRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 2,
            expected_quote_version: null,
            unit_price: 45000,
            max_quantity: 300,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(declinedToQuotedRes.status).toBe(201);
      const d2qBody =
        await readJson<SubmitQuoteSuccessBody>(declinedToQuotedRes);
      quoteMutationDtoResponseSchema.parse(d2qBody.data);
      expect(d2qBody.data.recipient.response_status).toBe('quoted');
      expect(d2qBody.data.recipient.decline_reason).toBeNull();
      expect(d2qBody.data.recipient.version).toBe(3);
      expect(d2qBody.operation.current_state.request.status).toBe(
        'artisans_bidding',
      );
      expect(d2qBody.operation.current_state.request.version).toBe(3);
      expect(statusLogs).toHaveLength(1);
      expect(historyLog).toContainEqual(
        expect.objectContaining({
          event_type: 'quote_submitted',
          prev_status: 'declined',
          new_status: 'quoted',
        }),
      );

      // 2. Invite workshop 302 and submit second quote -> 201 Created, request.version stays 3, statusLogs stays 1
      recipientsStore.set(
        compositeKey('10001', '302'),
        createSampleRecipient({
          id: '11002',
          request_id: '10001',
          workshop_id: '302',
          response_status: 'pending',
          version: 1,
        }),
      );
      const secondWorkshopRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=other-artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_2,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            expected_quote_version: null,
            unit_price: 47000,
            max_quantity: 500,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(secondWorkshopRes.status).toBe(201);
      const secondBody =
        await readJson<SubmitQuoteSuccessBody>(secondWorkshopRes);
      quoteMutationDtoResponseSchema.parse(secondBody.data);
      expect(secondBody.data.quote.workshop.id).toBe('302');
      expect(secondBody.operation.current_state.request.status).toBe(
        'artisans_bidding',
      );
      expect(secondBody.operation.current_state.request.version).toBe(3);
      expect(statusLogs).toHaveLength(1);
    });
  });
});
