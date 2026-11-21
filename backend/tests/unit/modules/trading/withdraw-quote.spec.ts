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
import { AppModule } from '../../../../src/bootstrap/app.module';
import { configureHttp } from '../../../../src/bootstrap/configure-http';
import { AppLogger } from '../../../../src/common/observability/app-logger';
import { AppConfigModule } from '../../../../src/common/config/app-config';
import { SecurityModule } from '../../../../src/common/security/security.module';
import { createApiDocument } from '../../../../src/common/http/swagger/configure-swagger';
import { IDENTITY_CONTRACT } from '../../../../src/modules/identity/public/contracts/identity.contract';
import {
  WORKSHOP_CONTRACT,
  type IWorkshopContract,
} from '../../../../src/modules/workshops/public/contracts/workshop.contract';
import {
  TRANSACTION_RUNNER,
  type TransactionContext,
  type TransactionRunner,
} from '../../../../src/common/application/ports/transaction-runner';
import type { AuthenticatedActor } from '../../../../src/common/application/types/contract-types';
import type { OperationMetadata } from '../../../../src/common/application/types/operation-metadata';
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
import { WithdrawQuoteUseCase } from '../../../../src/modules/trading/application/use-cases/quotations/withdraw-quote.use-case';
import { ListArtisanQuoteRequestsUseCase } from '../../../../src/modules/trading/application/use-cases/requests/list-artisan-quote-requests.use-case';
import { TradingIdempotencyService } from '../../../../src/modules/trading/application/services/trading-idempotency.service';
import { ArtisanQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/artisan-quote-request.controller';
import { quoteMutationDtoResponseSchema } from '../../../../src/modules/trading/adapters/http/dtos/submit-quote.dto';
import { withdrawQuoteOperationResponseSchema } from '../../../../src/modules/trading/adapters/http/dtos/withdraw-quote.dto';
import {
  TRADING_CURRENT_STATE_RESOLVER,
  TradingCurrentStateResolver,
} from '../../../../src/modules/trading/adapters/http/interceptors/trading-current-state.resolver';
import { TradingMutationInterceptor } from '../../../../src/modules/trading/adapters/http/interceptors/trading-mutation.interceptor';
import { PrismaQuoteRequestRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository';
import { PrismaRequestRecipientRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository';
import { PrismaQuoteRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/quote.repository';
import { RecipientResponseHistoryMapper } from '../../../../src/modules/trading/adapters/persistence/mappers/recipient-response-history.mapper';
import {
  ConcurrencyConflictError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  MAX_WITHDRAW_REASON_LENGTH,
  Quote,
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
const VALID_IDEMPOTENCY_KEY_5 = 'e56fe074-6d14-4bff-804c-80aa166b7858';

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

interface WithdrawQuoteSuccessBody {
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
  const status = overrides.status ?? 'artisans_bidding';
  const isDraft = status === 'draft_request';
  return QuoteRequest.reconstitute({
    id: overrides.id ?? '10001',
    buyer_id: '10',
    category_id: isDraft ? null : '3',
    spec: isDraft ? null : 'Bộ ấm chén tử sa men rạn cao cấp',
    quantity:
      overrides.quantity !== undefined ? overrides.quantity : isDraft ? null : 500,
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
    version: overrides.version ?? 3,
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
    response_status: overrides.response_status ?? 'quoted',
    decline_reason: overrides.decline_reason ?? null,
    responded_by: overrides.responded_by ?? '20',
    responded_at: overrides.responded_at ?? SENT_AT,
    sent_at: SENT_AT,
    version: overrides.version ?? 2,
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

describe('Task 20: Withdraw Quote (UC-16, BR-15)', () => {
  describe('Tier 1 — WithdrawQuoteUseCase (Pure Application Rules)', () => {
    it('WQ-01: withdraws active quote, preserves commercial terms, bumps Quote & Recipient versions, keeps QuoteRequest untouched, writes RecipientResponseHistory(quote_withdrawn)', async () => {
      const txRunner = new MockTransactionRunner();
      const request = createSampleQuoteRequest({
        status: 'artisans_bidding',
        version: 3,
      });
      const recipient = createSampleRecipient({
        response_status: 'quoted',
        version: 2,
      });
      const quote = createSampleQuote({
        id: '401',
        status: 'active',
        version: 1,
        unit_price: 45000,
        max_quantity: 400,
      });

      let capturedHistory: RecipientResponseRecord | undefined;
      let capturedQuoteArg: Quote | undefined;
      let capturedRecipientArg: RequestRecipient | undefined;

      const quoteRequestRepo = {
        lockById: vi.fn().mockResolvedValue(request),
        update: vi.fn(),
      };
      const recipientRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
      };
      const quoteRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(quote),
        update: vi.fn().mockImplementation(
          async (args: {
            quote: Quote;
            expectedVersion?: number;
            recipient?: RequestRecipient;
            recipientHistory?: RecipientResponseRecord;
          }) => {
            capturedQuoteArg = args.quote;
            capturedRecipientArg = args.recipient;
            capturedHistory = args.recipientHistory;
            return args.quote;
          },
        ),
      };

      const workshopContract = new MockWorkshopContract().givenActiveWorkshops('301');
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Minh Long',
        status: 'active',
        isProfilePublic: true,
      });

      const useCase = new WithdrawQuoteUseCase(
        txRunner,
        asQuoteRequestRepo(quoteRequestRepo),
        asRecipientRepo(recipientRepo),
        asQuoteRepo(quoteRepo),
        workshopContract,
      );

      const output = await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 2,
        expectedQuoteVersion: 1,
        withdrawReason: '  Xưởng điều chỉnh lịch lò nung tháng 12  ',
        now: NOW,
      });

      expect(quoteRequestRepo.update).not.toHaveBeenCalled();
      expect(workshopContract.lockAndAssertActive).not.toHaveBeenCalled();
      expect(workshopContract.getWorkshopSummary).toHaveBeenCalledWith('301');

      expect(quoteRepo.update).toHaveBeenCalledTimes(1);
      expect(capturedQuoteArg?.status).toBe('withdrawn');
      expect(capturedQuoteArg?.version).toBe(2);
      expect(capturedQuoteArg?.withdraw_reason).toBe(
        'Xưởng điều chỉnh lịch lò nung tháng 12',
      );
      expect(capturedQuoteArg?.withdrawn_by).toBe('20');
      expect(capturedQuoteArg?.withdrawn_at?.toISOString()).toBe(NOW.toISOString());
      expect(capturedQuoteArg?.unit_price).toBe(45000);
      expect(capturedQuoteArg?.max_quantity).toBe(400);
      expect(capturedQuoteArg?.bid_accept_deadline.toISOString()).toBe(
        VALID_ACCEPT_DEADLINE.toISOString(),
      );
      expect(capturedQuoteArg?.committed_delivery_at.toISOString()).toBe(
        VALID_COMMITTED_DELIVERY.toISOString(),
      );

      expect(capturedRecipientArg?.response_status).toBe('withdrawn');
      expect(capturedRecipientArg?.version).toBe(3);
      expect(capturedRecipientArg?.responded_by).toBe('20');
      expect(capturedRecipientArg?.responded_at?.toISOString()).toBe(
        NOW.toISOString(),
      );

      expect(capturedHistory).toEqual({
        recipient_id: '11001',
        quote_id: '401',
        event_type: 'quote_withdrawn',
        prev_status: 'quoted',
        new_status: 'withdrawn',
        reason: 'Xưởng điều chỉnh lịch lò nung tháng 12',
        quote_snapshot: {
          unit_price: 45000,
          max_quantity: 400,
          bid_accept_deadline: VALID_ACCEPT_DEADLINE,
          committed_delivery_at: VALID_COMMITTED_DELIVERY,
          status: 'withdrawn',
          version: 2,
        },
        performed_by: '20',
        created_at: NOW,
      });

      expect(output.result.quote.status).toBe('withdrawn');
      expect(output.result.quote.version).toBe(2);
      expect(output.result.quote.withdraw_reason).toBe(
        'Xưởng điều chỉnh lịch lò nung tháng 12',
      );
      expect(output.result.quote.withdrawn_at).toBe(NOW.toISOString());
      expect(output.result.quote.is_eligible).toBe(false);
      expect(output.result.quote.ineligible_reasons).toEqual(['QUOTE_WITHDRAWN']);
      expect('withdrawn_by' in output.result.quote).toBe(false);

      expect(output.result.recipient.response_status).toBe('withdrawn');
      expect(output.result.recipient.version).toBe(3);
      expect(output.result.recipient.eligibility_labels).toEqual([
        'QUOTE_WITHDRAWN',
      ]);

      expect(output.currentState).toEqual({
        request: {
          id: '10001',
          status: 'artisans_bidding',
          version: 3,
          cancelled_at: null,
        },
        recipient: {
          id: '11001',
          status: 'withdrawn',
          version: 3,
        },
        quote: {
          id: '401',
          status: 'withdrawn',
          version: 2,
        },
      });
    });

    it('WQ-02: succeeds when bidding is closed (both bidding_closed_at != null and now >= bidding_deadline)', async () => {
      const txRunner = new MockTransactionRunner();

      // Case A: bidding_closed_at set explicitly
      const closedByTimestamp = createSampleQuoteRequest({
        status: 'artisans_bidding',
        bidding_closed_at: new Date('2026-11-11T12:00:00.000Z'),
      });
      const recipientA = createSampleRecipient({ version: 2 });
      const quoteA = createSampleQuote({ version: 1 });

      const useCaseA = new WithdrawQuoteUseCase(
        txRunner,
        asQuoteRequestRepo({ lockById: vi.fn().mockResolvedValue(closedByTimestamp) }),
        asRecipientRepo({
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipientA),
        }),
        asQuoteRepo({
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(quoteA),
          update: vi.fn().mockImplementation(async ({ quote }) => quote),
        }),
      );

      const resA = await useCaseA.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 2,
        expectedQuoteVersion: 1,
        withdrawReason: 'Rút sau khi Buyer đóng nhận báo giá sớm',
        now: NOW,
      });
      expect(resA.result.quote.status).toBe('withdrawn');

      // Case B: bidding_closed_at null, but now >= bidding_deadline
      const pastDeadline = createSampleQuoteRequest({
        status: 'artisans_bidding',
        bidding_closed_at: null,
        bidding_deadline: new Date('2026-11-12T08:00:00.000Z'),
      });
      const useCaseB = new WithdrawQuoteUseCase(
        txRunner,
        asQuoteRequestRepo({ lockById: vi.fn().mockResolvedValue(pastDeadline) }),
        asRecipientRepo({
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipientA),
        }),
        asQuoteRepo({
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(quoteA),
          update: vi.fn().mockImplementation(async ({ quote }) => quote),
        }),
      );

      const resB = await useCaseB.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 2,
        expectedQuoteVersion: 1,
        withdrawReason: 'Rút sau khi quá hạn nhận báo giá',
        now: NOW,
      });
      expect(resB.result.quote.status).toBe('withdrawn');
    });

    it('WQ-03: succeeds when workshop is suspended (without calling lockAndAssertActive) and when quote bid_accept_deadline has expired', async () => {
      const txRunner = new MockTransactionRunner();
      const request = createSampleQuoteRequest({ status: 'artisans_bidding' });
      const recipient = createSampleRecipient({ version: 2 });
      const expiredQuote = createSampleQuote({
        version: 1,
        bid_accept_deadline: new Date('2026-11-12T08:30:00.000Z'),
      });

      const workshopContract = new MockWorkshopContract().givenSuspended('301');
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Tạm Ngừng',
        status: 'suspended',
        isProfilePublic: false,
      });

      const useCase = new WithdrawQuoteUseCase(
        txRunner,
        asQuoteRequestRepo({ lockById: vi.fn().mockResolvedValue(request) }),
        asRecipientRepo({
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
        }),
        asQuoteRepo({
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(expiredQuote),
          update: vi.fn().mockImplementation(async ({ quote }) => quote),
        }),
        workshopContract,
      );

      const result = await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 2,
        expectedQuoteVersion: 1,
        withdrawReason: 'Xưởng đang tạm ngừng hoạt động nên rút báo giá',
        now: NOW,
      });

      expect(workshopContract.lockAndAssertActive).not.toHaveBeenCalled();
      expect(workshopContract.getWorkshopSummary).toHaveBeenCalledWith('301');
      expect(result.result.quote.status).toBe('withdrawn');
      expect(result.result.quote.is_eligible).toBe(false);
      expect(result.result.quote.ineligible_reasons).toEqual([
        'QUOTE_WITHDRAWN',
        'WORKSHOP_SUSPENDED',
        'QUOTE_EXPIRED',
      ]);
      expect(result.result.recipient.eligibility_labels).toEqual([
        'QUOTE_WITHDRAWN',
        'WORKSHOP_SUSPENDED',
        'QUOTE_EXPIRED',
      ]);
    });

    it('WQ-04: acquires locks in deterministic order (QuoteRequest -> RequestRecipient -> Quote) and passes through external input.tx without invoking txRunner.run', async () => {
      const txRunner = new MockTransactionRunner();
      const externalTx = { __tx: 'external' } as unknown as TransactionContext;

      const lockRequest = vi
        .fn()
        .mockResolvedValue(createSampleQuoteRequest({ status: 'artisans_bidding' }));
      const lockRecipient = vi
        .fn()
        .mockResolvedValue(createSampleRecipient({ version: 2 }));
      const lockQuote = vi
        .fn()
        .mockResolvedValue(createSampleQuote({ version: 1 }));
      const updateQuote = vi
        .fn()
        .mockImplementation(async ({ quote }) => quote);

      const useCase = new WithdrawQuoteUseCase(
        txRunner,
        asQuoteRequestRepo({ lockById: lockRequest }),
        asRecipientRepo({ lockByRequestAndWorkshop: lockRecipient }),
        asQuoteRepo({
          lockByRequestAndWorkshop: lockQuote,
          update: updateQuote,
        }),
      );

      await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 2,
        expectedQuoteVersion: 1,
        withdrawReason: 'Kiểm tra thứ tự lock',
        now: NOW,
        tx: externalTx,
      });

      expect(txRunner.contexts).toHaveLength(0);
      expect(lockRequest).toHaveBeenCalledWith('10001', externalTx);
      expect(lockRecipient).toHaveBeenCalledWith('10001', '301', externalTx);
      expect(lockQuote).toHaveBeenCalledWith('10001', '301', externalTx);
      expect(updateQuote).toHaveBeenCalledWith(expect.any(Object), externalTx);

      const reqOrder = lockRequest.mock.invocationCallOrder[0];
      const recOrder = lockRecipient.mock.invocationCallOrder[0];
      const quoteOrder = lockQuote.mock.invocationCallOrder[0];
      expect(reqOrder).toBeLessThan(recOrder);
      expect(recOrder).toBeLessThan(quoteOrder);
    });

    it('WQ-05: enforces actor role, temp_password restriction, workshop association, and anti-IDOR 404', async () => {
      const txRunner = new MockTransactionRunner();
      const useCase = new WithdrawQuoteUseCase(
        txRunner,
        asQuoteRequestRepo({ lockById: vi.fn().mockResolvedValue(null) }),
        asRecipientRepo({ lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null) }),
        asQuoteRepo({ lockByRequestAndWorkshop: vi.fn() }),
      );

      await expect(
        useCase.execute({
          actor: tempPasswordArtisanActor,
          requestId: '10001',
          expectedRecipientVersion: 2,
          expectedQuoteVersion: 1,
          withdrawReason: 'reason',
        }),
      ).rejects.toMatchObject({
        code: 'TEMP_PASSWORD_RESTRICTED',
      });

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '10001',
          expectedRecipientVersion: 2,
          expectedQuoteVersion: 1,
          withdrawReason: 'reason',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '10001',
          expectedRecipientVersion: 2,
          expectedQuoteVersion: 1,
          withdrawReason: 'reason',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      await expect(
        useCase.execute({
          actor: artisanWithoutWorkshopActor,
          requestId: '10001',
          expectedRecipientVersion: 2,
          expectedQuoteVersion: 1,
          withdrawReason: 'reason',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      // Missing request -> 404
      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '99999',
          expectedRecipientVersion: 2,
          expectedQuoteVersion: 1,
          withdrawReason: 'reason',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      // Existing request, uninvited workshop -> identical 404 anti-IDOR
      const uninvitedUseCase = new WithdrawQuoteUseCase(
        txRunner,
        asQuoteRequestRepo({
          lockById: vi.fn().mockResolvedValue(createSampleQuoteRequest()),
        }),
        asRecipientRepo({
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
        }),
        asQuoteRepo({ lockByRequestAndWorkshop: vi.fn() }),
      );

      await expect(
        uninvitedUseCase.execute({
          actor: otherArtisanActor,
          requestId: '10001',
          expectedRecipientVersion: 2,
          expectedQuoteVersion: 1,
          withdrawReason: 'reason',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);
    });

    it('WQ-06: rejects invalid requestId, missing/non-positive/null versions, and empty/whitespace/overlong withdraw_reason while accepting exact MAX_WITHDRAW_REASON_LENGTH', async () => {
      const txRunner = new MockTransactionRunner();
      const useCase = new WithdrawQuoteUseCase(
        txRunner,
        asQuoteRequestRepo({
          lockById: vi.fn().mockResolvedValue(createSampleQuoteRequest()),
        }),
        asRecipientRepo({
          lockByRequestAndWorkshop: vi
            .fn()
            .mockResolvedValue(createSampleRecipient({ version: 2 })),
        }),
        asQuoteRepo({
          lockByRequestAndWorkshop: vi
            .fn()
            .mockResolvedValue(createSampleQuote({ version: 1 })),
          update: vi.fn().mockImplementation(async ({ quote }) => quote),
        }),
      );

      for (const badId of ['', '0', '-1', 'abc']) {
        await expect(
          useCase.execute({
            actor: artisanActor,
            requestId: badId,
            expectedRecipientVersion: 2,
            expectedQuoteVersion: 1,
            withdrawReason: 'valid reason',
          }),
        ).rejects.toThrow(InvalidTradingInputError);
      }

      for (const badVersion of [0, -1, 1.5, Number.NaN]) {
        await expect(
          useCase.execute({
            actor: artisanActor,
            requestId: '10001',
            expectedRecipientVersion: badVersion,
            expectedQuoteVersion: 1,
            withdrawReason: 'valid reason',
          }),
        ).rejects.toThrow(InvalidTradingInputError);

        await expect(
          useCase.execute({
            actor: artisanActor,
            requestId: '10001',
            expectedRecipientVersion: 2,
            expectedQuoteVersion: badVersion,
            withdrawReason: 'valid reason',
          }),
        ).rejects.toThrow(InvalidTradingInputError);
      }

      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 2,
          withdrawReason: 'valid reason',
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 2,
          expectedQuoteVersion: 1,
          withdrawReason: '   \t\n  ',
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 2,
          expectedQuoteVersion: 1,
          withdrawReason: 'a'.repeat(MAX_WITHDRAW_REASON_LENGTH + 1),
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      const maxReason = 'a'.repeat(MAX_WITHDRAW_REASON_LENGTH);
      const boundaryResult = await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 2,
        expectedQuoteVersion: 1,
        withdrawReason: `  ${maxReason}  `,
        now: NOW,
      });
      expect(boundaryResult.result.quote.withdraw_reason).toBe(maxReason);
    });

    it('WQ-07: rejects cancelled, accepted/beyond, draft_request, missing quote (pending/declined), and already-withdrawn/accepted quote with InvalidStateTransitionError (422)', async () => {
      const txRunner = new MockTransactionRunner();

      const cases: Array<{
        label: string;
        request: QuoteRequest;
        recipient: RequestRecipient;
        quote: Quote | null;
      }> = [
        {
          label: 'cancelled request',
          request: createSampleQuoteRequest({
            status: 'artisans_bidding',
            cancelled_at: NOW,
            cancelled_by: '10',
            cancel_reason: 'Hủy yêu cầu',
          }),
          recipient: createSampleRecipient({ version: 2 }),
          quote: createSampleQuote({ version: 1 }),
        },
        {
          label: 'buyer_accepted request',
          request: createSampleQuoteRequest({ status: 'buyer_accepted' }),
          recipient: createSampleRecipient({ version: 2 }),
          quote: createSampleQuote({ version: 1 }),
        },
        {
          label: 'in_production request',
          request: createSampleQuoteRequest({ status: 'in_production' }),
          recipient: createSampleRecipient({ version: 2 }),
          quote: createSampleQuote({ version: 1 }),
        },
        {
          label: 'delivered request',
          request: createSampleQuoteRequest({ status: 'delivered' }),
          recipient: createSampleRecipient({ version: 2 }),
          quote: createSampleQuote({ version: 1 }),
        },
        {
          label: 'draft_request',
          request: createSampleQuoteRequest({ status: 'draft_request' }),
          recipient: createSampleRecipient({ version: 2 }),
          quote: createSampleQuote({ version: 1 }),
        },
        {
          label: 'missing quote (pending)',
          request: createSampleQuoteRequest({ status: 'artisans_bidding' }),
          recipient: createSampleRecipient({
            response_status: 'pending',
            responded_by: null,
            responded_at: null,
            version: 2,
          }),
          quote: null,
        },
        {
          label: 'missing quote (declined)',
          request: createSampleQuoteRequest({ status: 'artisans_bidding' }),
          recipient: createSampleRecipient({
            response_status: 'declined',
            decline_reason: 'Bận lịch',
            version: 2,
          }),
          quote: null,
        },
        {
          label: 'already withdrawn quote',
          request: createSampleQuoteRequest({ status: 'artisans_bidding' }),
          recipient: createSampleRecipient({
            response_status: 'withdrawn',
            version: 2,
          }),
          quote: createSampleQuote({
            status: 'withdrawn',
            withdraw_reason: 'Đã rút trước đó',
            withdrawn_by: '20',
            withdrawn_at: NOW,
            version: 1,
          }),
        },
        {
          label: 'accepted quote',
          request: createSampleQuoteRequest({ status: 'artisans_bidding' }),
          recipient: createSampleRecipient({
            response_status: 'quoted',
            version: 2,
          }),
          quote: createSampleQuote({ status: 'accepted', version: 1 }),
        },
      ];

      for (const testCase of cases) {
        const updateSpy = vi.fn();
        const useCase = new WithdrawQuoteUseCase(
          txRunner,
          asQuoteRequestRepo({
            lockById: vi.fn().mockResolvedValue(testCase.request),
          }),
          asRecipientRepo({
            lockByRequestAndWorkshop: vi
              .fn()
              .mockResolvedValue(testCase.recipient),
          }),
          asQuoteRepo({
            lockByRequestAndWorkshop: vi.fn().mockResolvedValue(testCase.quote),
            update: updateSpy,
          }),
        );

        await expect(
          useCase.execute({
            actor: artisanActor,
            requestId: '10001',
            expectedRecipientVersion: 2,
            expectedQuoteVersion: 1,
            withdrawReason: 'Lý do rút hợp lệ',
            now: NOW,
          }),
          testCase.label,
        ).rejects.toThrow(InvalidStateTransitionError);

        expect(updateSpy).not.toHaveBeenCalled();
      }
    });

    it('WQ-08: throws ConcurrencyConflictError (409) when expected_recipient_version or expected_quote_version mismatches', async () => {
      const txRunner = new MockTransactionRunner();
      const updateSpy = vi.fn();

      const useCase = new WithdrawQuoteUseCase(
        txRunner,
        asQuoteRequestRepo({
          lockById: vi.fn().mockResolvedValue(createSampleQuoteRequest()),
        }),
        asRecipientRepo({
          lockByRequestAndWorkshop: vi
            .fn()
            .mockResolvedValue(createSampleRecipient({ version: 4 })),
        }),
        asQuoteRepo({
          lockByRequestAndWorkshop: vi
            .fn()
            .mockResolvedValue(createSampleQuote({ version: 3 })),
          update: updateSpy,
        }),
      );

      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 3,
          expectedQuoteVersion: 3,
          withdrawReason: 'Stale recipient version',
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 4,
          expectedQuoteVersion: 2,
          withdrawReason: 'Stale quote version',
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      expect(updateSpy).not.toHaveBeenCalled();
    });
  });

  describe('Tier 2 — Domain Entity & History Mapper Invariants', () => {
    it('DM-01: Quote.withdraw enforces draft_request, max withdraw_reason length, and preserves commercial terms', () => {
      const quote = createSampleQuote({ status: 'active', version: 2 });
      const recipient = createSampleRecipient({
        response_status: 'quoted',
        version: 3,
      });
      const draftRequest = createSampleQuoteRequest({ status: 'draft_request' });

      expect(() =>
        quote.withdraw({
          request: draftRequest,
          recipient,
          actorId: '20',
          expectedQuoteVersion: 2,
          withdrawReason: 'Cannot withdraw on draft',
          now: NOW,
        }),
      ).toThrow(InvalidStateTransitionError);

      const openRequest = createSampleQuoteRequest({ status: 'artisans_bidding' });
      expect(() =>
        quote.withdraw({
          request: openRequest,
          recipient,
          actorId: '20',
          expectedQuoteVersion: 2,
          withdrawReason: 'x'.repeat(MAX_WITHDRAW_REASON_LENGTH + 1),
          now: NOW,
        }),
      ).toThrow(InvalidTradingInputError);

      const withdrawn = quote.withdraw({
        request: openRequest,
        recipient,
        actorId: '20',
        expectedQuoteVersion: 2,
        withdrawReason: '  Không đủ nguyên liệu  ',
        now: NOW,
      });

      expect(withdrawn.quote.status).toBe('withdrawn');
      expect(withdrawn.quote.version).toBe(3);
      expect(withdrawn.quote.unit_price).toBe(quote.unit_price);
      expect(withdrawn.quote.max_quantity).toBe(quote.max_quantity);
      expect(withdrawn.quote.created_at.getTime()).toBe(
        quote.created_at.getTime(),
      );
      expect(withdrawn.recipientHistory.event_type).toBe('quote_withdrawn');
      expect(withdrawn.recipientHistory.reason).toBe('Không đủ nguyên liệu');
    });

    it('DM-02: RecipientResponseHistoryMapper maps quote_withdrawn with strict 6-field quote_snapshot', () => {
      const quote = createSampleQuote({ status: 'active', version: 1 });
      const recipient = createSampleRecipient({
        response_status: 'quoted',
        version: 2,
      });
      const request = createSampleQuoteRequest({ status: 'artisans_bidding' });

      const withdrawn = quote.withdraw({
        request,
        recipient,
        actorId: '20',
        expectedQuoteVersion: 1,
        withdrawReason: 'Điều chỉnh kế hoạch sản xuất',
        now: NOW,
      });

      const prismaInput = RecipientResponseHistoryMapper.toPrismaCreateInput(
        withdrawn.recipientHistory,
        Prisma.DbNull,
      );

      expect(prismaInput.event_type).toBe('quote_withdrawn');
      expect(prismaInput.prev_status).toBe('quoted');
      expect(prismaInput.new_status).toBe('withdrawn');
      expect(prismaInput.reason).toBe('Điều chỉnh kế hoạch sản xuất');
      expect(prismaInput.quote_id).toBe(401n);
      expect(prismaInput.quote_snapshot).toEqual({
        unit_price: 45000,
        max_quantity: 400,
        bid_accept_deadline: VALID_ACCEPT_DEADLINE.toISOString(),
        committed_delivery_at: VALID_COMMITTED_DELIVERY.toISOString(),
        status: 'withdrawn',
        version: 2,
      });
    });
  });

  describe('Tier 3 — Prisma Repositories & PrismaTransactionRunner Persistence', () => {
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
      max_quantity: 400,
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

    it('PR-01: runs lock order, optimistic updateMany on Quote & RequestRecipient, and creates RecipientResponseHistory inside one Prisma transaction', async () => {
      const updatedQuoteRow = {
        ...quoteRow,
        status: 'withdrawn',
        version: 2,
        withdraw_reason: 'Rút báo giá trong transaction',
        withdrawn_by: 20n,
        withdrawn_at: NOW,
        updated_at: NOW,
      };

      const mockClient = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: 10001n }])
          .mockResolvedValueOnce([{ id: 11001n }])
          .mockResolvedValueOnce([{ id: 888n }]),
        quoteRequest: {
          findUnique: vi.fn().mockResolvedValue(requestRow),
          updateMany: vi.fn(),
        },
        requestRecipient: {
          findUnique: vi.fn().mockResolvedValue(recipientRow),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        quote: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(quoteRow)
            .mockResolvedValueOnce(updatedQuoteRow),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        recipientResponseHistory: {
          create: vi.fn().mockResolvedValue({ id: 9001n }),
        },
      };

      const mockPrismaService = {
        $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn(mockClient),
        ),
      } as unknown as PrismaService;

      const txRunner = new PrismaTransactionRunner(mockPrismaService);
      const useCase = new WithdrawQuoteUseCase(
        txRunner,
        new PrismaQuoteRequestRepository(txRunner),
        new PrismaRequestRecipientRepository(txRunner),
        new PrismaQuoteRepository(txRunner),
      );

      const output = await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 2,
        expectedQuoteVersion: 1,
        withdrawReason: 'Rút báo giá trong transaction',
        now: NOW,
      });

      expect(mockClient.quoteRequest.updateMany).not.toHaveBeenCalled();
      expect(mockClient.quote.updateMany).toHaveBeenCalledWith({
        where: { id: 888n, version: 1 },
        data: expect.objectContaining({
          status: 'withdrawn',
          version: 2,
          withdraw_reason: 'Rút báo giá trong transaction',
          withdrawn_by: 20n,
          withdrawn_at: NOW,
        }),
      });
      expect(mockClient.requestRecipient.updateMany).toHaveBeenCalledWith({
        where: { id: 11001n, version: 2 },
        data: expect.objectContaining({
          response_status: 'withdrawn',
          version: 3,
          responded_by: 20n,
          responded_at: NOW,
        }),
      });
      expect(mockClient.recipientResponseHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          recipient_id: 11001n,
          quote_id: 888n,
          event_type: 'quote_withdrawn',
          prev_status: 'quoted',
          new_status: 'withdrawn',
          reason: 'Rút báo giá trong transaction',
          performed_by: 20n,
        }),
      });
      expect(output.result.quote.status).toBe('withdrawn');
      expect(output.result.quote.version).toBe(2);
    });

    it('PR-02: throws ConcurrencyConflictError when quote.updateMany count is 0', async () => {
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
      const useCase = new WithdrawQuoteUseCase(
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
          withdrawReason: 'Concurrent quote mismatch',
          now: NOW,
        }),
      ).rejects.toThrow(ConcurrencyConflictError);
    });

    it('PR-03: throws ConcurrencyConflictError when requestRecipient.updateMany count is 0', async () => {
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
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        quote: {
          findUnique: vi.fn().mockResolvedValue(quoteRow),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };

      const mockPrismaService = {
        $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn(mockClient),
        ),
      } as unknown as PrismaService;

      const txRunner = new PrismaTransactionRunner(mockPrismaService);
      const useCase = new WithdrawQuoteUseCase(
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
          withdrawReason: 'Concurrent recipient mismatch',
          now: NOW,
        }),
      ).rejects.toThrow(ConcurrencyConflictError);
    });
  });

  describe('Tier 4 — HTTP Controller, ValidationPipe, Guards, Idempotency & OpenAPI Contract (POST /api/v1/artisan/quote-requests/:id/quote/withdraw)', () => {
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

    let futureBiddingDeadline: Date;
    let futureDeliveryDeadline: Date;
    let validAcceptDeadlineIso: string;
    let validCommittedDeliveryIso: string;

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
          {
            provide: WithdrawQuoteUseCase,
            useFactory: (
              txRunner: TransactionRunner,
              qrRepo: IQuoteRequestRepository,
              recRepo: IRequestRecipientRepository,
              qRepo: IQuoteRepository,
              wsContract: IWorkshopContract,
            ) =>
              new WithdrawQuoteUseCase(
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
      futureBiddingDeadline = new Date(nowMs + 5 * TWENTY_FOUR_HOURS_MS);
      futureDeliveryDeadline = new Date(nowMs + 20 * TWENTY_FOUR_HOURS_MS);
      validAcceptDeadlineIso = new Date(
        futureBiddingDeadline.getTime() + TWENTY_FOUR_HOURS_MS + 3_600_000,
      ).toISOString();
      validCommittedDeliveryIso = new Date(
        futureDeliveryDeadline.getTime() - 3_600_000,
      ).toISOString();

      identityMock.resolveSession.mockImplementation(async (token: string) => {
        if (token === 'artisan-token') return artisanActor;
        if (token === 'other-artisan-token') return otherArtisanActor;
        if (token === 'artisan-no-workshop-token') {
          return artisanWithoutWorkshopActor;
        }
        if (token === 'temp-artisan-token') return tempPasswordArtisanActor;
        if (token === 'buyer-token') return buyerActor;
        if (token === 'admin-token') return adminActor;
        return null;
      });

      workshopMock.givenActiveWorkshops('301', '302');
      workshopMock.getWorkshopSummary.mockImplementation(
        async (wsId: string) => ({
          id: wsId,
          name:
            wsId === '302' ? 'Xưởng Gốm Bát Tràng 2' : 'Xưởng Gốm Minh Long',
          status: 'active',
          isProfilePublic: true,
        }),
      );

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
          id: '401',
          request_id: '10001',
          workshop_id: '301',
          status: 'active',
          version: 1,
          bid_accept_deadline: new Date(validAcceptDeadlineIso),
          committed_delivery_at: new Date(validCommittedDeliveryIso),
        }),
      );
    });

    it('HT-01: POST /quote/withdraw returns 200 OK, Cache-Control: no-store, valid envelope + operation.current_state, leaves QuoteRequest in artisans_bidding, and supports resubmit on same Quote record', async () => {
      const res = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 2,
            expected_quote_version: 1,
            withdraw_reason: '  Xưởng điều chỉnh công suất lò nung  ',
          }),
        },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await readJson<WithdrawQuoteSuccessBody>(res);
      expect(body.success).toBe(true);
      quoteMutationDtoResponseSchema.parse(body.data);
      withdrawQuoteOperationResponseSchema.parse(body.operation);

      expect(body.data.quote.status).toBe('withdrawn');
      expect(body.data.quote.version).toBe(2);
      expect(body.data.quote.withdraw_reason).toBe(
        'Xưởng điều chỉnh công suất lò nung',
      );
      expect(body.data.quote.unit_price).toBe(45000);
      expect(body.data.quote.max_quantity).toBe(400);
      expect(body.data.quote.is_eligible).toBe(false);
      expect(body.data.quote.ineligible_reasons).toEqual(['QUOTE_WITHDRAWN']);

      expect(body.data.recipient.response_status).toBe('withdrawn');
      expect(body.data.recipient.version).toBe(3);
      expect(body.data.recipient.eligibility_labels).toEqual([
        'QUOTE_WITHDRAWN',
      ]);

      // BR-23: Even when last active quote is withdrawn, QuoteRequest stays artisans_bidding with unchanged version
      expect(body.operation.replayed).toBe(false);
      expect(body.operation.current_state).toEqual({
        request: {
          id: '10001',
          status: 'artisans_bidding',
          version: 3,
          cancelled_at: null,
        },
        recipient: {
          id: '11001',
          status: 'withdrawn',
          version: 3,
        },
        quote: {
          id: '401',
          status: 'withdrawn',
          version: 2,
        },
      });
      expect(requestsStore.get('10001')?.status).toBe('artisans_bidding');
      expect(requestsStore.get('10001')?.version).toBe(3);

      expect(historyLog).toHaveLength(1);
      expect(historyLog[0].event_type).toBe('quote_withdrawn');

      // UC-16 / BR-15: Artisan can resubmit on the same Quote record while bidding is still open
      const resubmitRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_2,
          },
          body: JSON.stringify({
            expected_recipient_version: 3,
            expected_quote_version: 2,
            unit_price: 46000,
            max_quantity: 350,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(resubmitRes.status).toBe(200);
      const resubmitBody = await readJson<WithdrawQuoteSuccessBody>(resubmitRes);
      expect(resubmitBody.data.quote.id).toBe('401');
      expect(resubmitBody.data.quote.status).toBe('active');
      expect(resubmitBody.data.quote.version).toBe(3);
      expect(resubmitBody.data.quote.withdraw_reason).toBeNull();
      expect(historyLog).toHaveLength(2);
      expect(historyLog[1].event_type).toBe('quote_resubmitted');
    });

    it('HT-02: succeeds with 200 OK when bidding is closed AND when workshop is suspended', async () => {
      workshopMock.givenSuspended('301');
      workshopMock.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Tạm Ngừng',
        status: 'suspended',
        isProfilePublic: false,
      });

      requestsStore.set(
        '10001',
        createSampleQuoteRequest({
          id: '10001',
          status: 'artisans_bidding',
          version: 3,
          bidding_deadline: futureBiddingDeadline,
          delivery_deadline: futureDeliveryDeadline,
          bidding_closed_at: new Date(),
        }),
      );

      const res = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 2,
            expected_quote_version: 1,
            withdraw_reason: 'Rút khi đã đóng nhận và hộ tạm ngừng',
          }),
        },
      );

      expect(res.status).toBe(200);
      expect(workshopMock.lockAndAssertActive).not.toHaveBeenCalled();
      const body = await readJson<WithdrawQuoteSuccessBody>(res);
      expect(body.data.quote.status).toBe('withdrawn');
      expect(body.data.quote.ineligible_reasons).toEqual([
        'QUOTE_WITHDRAWN',
        'WORKSHOP_SUSPENDED',
      ]);
      expect(body.data.recipient.eligibility_labels).toEqual([
        'QUOTE_WITHDRAWN',
        'WORKSHOP_SUSPENDED',
      ]);

      // Also verify closed bidding via past bidding_deadline (bidding_closed_at = null)
      // and verify resubmit is blocked afterwards with 422 BIDDING_CLOSED
      const pastBidding = new Date(Date.now() - 3_600_000);
      requestsStore.set(
        '10002',
        createSampleQuoteRequest({
          id: '10002',
          status: 'artisans_bidding',
          version: 3,
          bidding_deadline: pastBidding,
          delivery_deadline: futureDeliveryDeadline,
          bidding_closed_at: null,
        }),
      );
      recipientsStore.set(
        compositeKey('10002', '301'),
        createSampleRecipient({
          id: '11002',
          request_id: '10002',
          workshop_id: '301',
          response_status: 'quoted',
          version: 2,
        }),
      );
      quotesStore.set(
        compositeKey('10002', '301'),
        createSampleQuote({
          id: '402',
          request_id: '10002',
          workshop_id: '301',
          status: 'active',
          version: 1,
          bid_accept_deadline: new Date(validAcceptDeadlineIso),
          committed_delivery_at: new Date(validCommittedDeliveryIso),
        }),
      );
      workshopMock.givenActiveWorkshops('301');
      workshopMock.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Minh Long',
        status: 'active',
        isProfilePublic: true,
      });

      const pastDeadlineWithdrawRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10002/quote/withdraw`,
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
            withdraw_reason: 'Rút sau khi hết hạn nhận báo giá',
          }),
        },
      );
      expect(pastDeadlineWithdrawRes.status).toBe(200);

      const resubmitClosedRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10002/quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_3,
          },
          body: JSON.stringify({
            expected_recipient_version: 3,
            expected_quote_version: 2,
            unit_price: 46000,
            max_quantity: 350,
            bid_accept_deadline: validAcceptDeadlineIso,
            committed_delivery_at: validCommittedDeliveryIso,
          }),
        },
      );
      expect(resubmitClosedRes.status).toBe(422);
      expect((await readJson<ProblemDetailsBody>(resubmitClosedRes)).code).toBe(
        'BIDDING_CLOSED',
      );
    });

    it('HT-03: supports idempotency replay with fresh current_state (even after resubmit or request cancellation) and rejects payload mismatch with 409 IDEMPOTENCY_CONFLICT', async () => {
      const payload = {
        expected_recipient_version: 2,
        expected_quote_version: 1,
        withdraw_reason: 'Lý do rút chuẩn',
      };

      const firstRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify(payload),
        },
      );
      expect(firstRes.status).toBe(200);
      const firstBody = await readJson<WithdrawQuoteSuccessBody>(firstRes);
      expect(firstBody.operation.replayed).toBe(false);

      // Mutate store afterwards (simulate request cancelled later)
      const currentReq = requestsStore.get('10001')!;
      const cancelTime = new Date();
      requestsStore.set(
        '10001',
        QuoteRequest.reconstitute({
          ...currentReq,
          version: 4,
          cancelled_at: cancelTime,
          cancelled_by: '10',
          cancel_reason: 'Hủy sau khi nghệ nhân đã rút',
        }),
      );

      // Replay exact same key & payload -> 200 OK with replayed: true and fresh current_state
      const replayRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify(payload),
        },
      );
      expect(replayRes.status).toBe(200);
      const replayBody = await readJson<WithdrawQuoteSuccessBody>(replayRes);
      expect(replayBody.operation.replayed).toBe(true);
      expect(replayBody.operation.id).toBe(firstBody.operation.id);
      expect(replayBody.data).toEqual(firstBody.data);
      expect(replayBody.operation.current_state).toEqual({
        request: {
          id: '10001',
          status: 'artisans_bidding',
          version: 4,
          cancelled_at: cancelTime.toISOString(),
        },
        recipient: {
          id: '11001',
          status: 'withdrawn',
          version: 3,
        },
        quote: {
          id: '401',
          status: 'withdrawn',
          version: 2,
        },
      });
      expect(historyLog).toHaveLength(1);

      // Same key + different withdraw_reason -> 409 IDEMPOTENCY_CONFLICT
      const mismatchReasonRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            ...payload,
            withdraw_reason: 'Lý do khác',
          }),
        },
      );
      expect(mismatchReasonRes.status).toBe(409);
      expect((await readJson<ProblemDetailsBody>(mismatchReasonRes)).code).toBe(
        'IDEMPOTENCY_CONFLICT',
      );

      // Same key + different expected_quote_version -> 409 IDEMPOTENCY_CONFLICT
      const mismatchVersionRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            ...payload,
            expected_quote_version: 2,
          }),
        },
      );
      expect(mismatchVersionRes.status).toBe(409);
      expect((await readJson<ProblemDetailsBody>(mismatchVersionRes)).code).toBe(
        'IDEMPOTENCY_CONFLICT',
      );

      // Cross-account idempotency isolation (SEC-06):
      // Workshop 302 (account 22) using the SAME X-Idempotency-Key does not replay account 20's record
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
        compositeKey('10001', '302'),
        createSampleRecipient({
          id: '11002',
          request_id: '10001',
          workshop_id: '302',
          response_status: 'quoted',
          responded_by: '22',
          version: 2,
        }),
      );
      quotesStore.set(
        compositeKey('10001', '302'),
        createSampleQuote({
          id: '402',
          request_id: '10001',
          workshop_id: '302',
          status: 'active',
          version: 1,
          bid_accept_deadline: new Date(validAcceptDeadlineIso),
          committed_delivery_at: new Date(validCommittedDeliveryIso),
        }),
      );
      const otherAccountSameKeyRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=other-artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify(payload),
        },
      );
      expect(otherAccountSameKeyRes.status).toBe(200);
      const otherAccountBody =
        await readJson<WithdrawQuoteSuccessBody>(otherAccountSameKeyRes);
      expect(otherAccountBody.operation.replayed).toBe(false);
      expect(otherAccountBody.data.quote.id).toBe('402');
      expect(otherAccountBody.data.quote.workshop.id).toBe('302');
    });

    it('HT-04: enforces authentication, roles, temp_password, and anti-IDOR 404 for uninvited or non-existent requests', async () => {
      const bodyPayload = JSON.stringify({
        expected_recipient_version: 2,
        expected_quote_version: 1,
        withdraw_reason: 'Lý do rút',
      });

      const unauthRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: bodyPayload,
        },
      );
      expect(unauthRes.status).toBe(401);
      expect((await readJson<ProblemDetailsBody>(unauthRes)).code).toBe(
        'AUTHENTICATION_REQUIRED',
      );

      const buyerRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=buyer-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: bodyPayload,
        },
      );
      expect(buyerRes.status).toBe(403);
      expect((await readJson<ProblemDetailsBody>(buyerRes)).code).toBe(
        'PERMISSION_DENIED',
      );

      const adminRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=admin-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: bodyPayload,
        },
      );
      expect(adminRes.status).toBe(403);
      expect((await readJson<ProblemDetailsBody>(adminRes)).code).toBe(
        'PERMISSION_DENIED',
      );

      const noWorkshopRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-no-workshop-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: bodyPayload,
        },
      );
      expect(noWorkshopRes.status).toBe(403);
      expect((await readJson<ProblemDetailsBody>(noWorkshopRes)).code).toBe(
        'PERMISSION_DENIED',
      );

      const tempPwdRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=temp-artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: bodyPayload,
        },
      );
      expect(tempPwdRes.status).toBe(403);
      expect((await readJson<ProblemDetailsBody>(tempPwdRes)).code).toBe(
        'TEMP_PASSWORD_RESTRICTED',
      );

      // Uninvited workshop (302) -> 404 RESOURCE_NOT_FOUND
      const uninvitedRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=other-artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: bodyPayload,
        },
      );
      expect(uninvitedRes.status).toBe(404);
      expect((await readJson<ProblemDetailsBody>(uninvitedRes)).code).toBe(
        'RESOURCE_NOT_FOUND',
      );

      // Non-existent request -> identical 404 RESOURCE_NOT_FOUND
      const missingRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/99999/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_2,
          },
          body: bodyPayload,
        },
      );
      expect(missingRes.status).toBe(404);
      expect((await readJson<ProblemDetailsBody>(missingRes)).code).toBe(
        'RESOURCE_NOT_FOUND',
      );
    });

    it('HT-05: rejects missing/invalid X-Idempotency-Key, bad :id, empty/whitespace/overlong withdraw_reason, null/invalid versions, and extra unknown fields with 400 INVALID_INPUT', async () => {
      // Missing X-Idempotency-Key
      const missingKeyRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
          },
          body: JSON.stringify({
            expected_recipient_version: 2,
            expected_quote_version: 1,
            withdraw_reason: 'Lý do',
          }),
        },
      );
      expect(missingKeyRes.status).toBe(400);
      const missingKeyBody = await readJson<ProblemDetailsBody>(missingKeyRes);
      expect(missingKeyBody.code).toBe('INVALID_INPUT');
      expect(missingKeyBody.tracking_id).toBe(
        missingKeyRes.headers.get('x-request-id'),
      );

      // Non-UUIDv4 X-Idempotency-Key
      const badKeyRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': 'not-a-uuid',
          },
          body: JSON.stringify({
            expected_recipient_version: 2,
            expected_quote_version: 1,
            withdraw_reason: 'Lý do',
          }),
        },
      );
      expect(badKeyRes.status).toBe(400);
      expect((await readJson<ProblemDetailsBody>(badKeyRes)).code).toBe(
        'INVALID_INPUT',
      );

      // Non-numeric :id
      const badIdRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/abc/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 2,
            expected_quote_version: 1,
            withdraw_reason: 'Lý do',
          }),
        },
      );
      expect(badIdRes.status).toBe(400);
      expect((await readJson<ProblemDetailsBody>(badIdRes)).code).toBe(
        'INVALID_INPUT',
      );

      // Empty/whitespace withdraw_reason -> 400 INVALID_INPUT with /withdraw_reason JSON Pointer
      const emptyReasonRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 2,
            expected_quote_version: 1,
            withdraw_reason: '   \n\t  ',
          }),
        },
      );
      expect(emptyReasonRes.status).toBe(400);
      const emptyReasonBody = await readJson<ProblemDetailsBody>(emptyReasonRes);
      expect(emptyReasonBody.code).toBe('INVALID_INPUT');
      expect(emptyReasonBody.errors).toContainEqual(
        expect.objectContaining({ field: '/withdraw_reason' }),
      );

      // Missing withdraw_reason
      const missingReasonRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 2,
            expected_quote_version: 1,
          }),
        },
      );
      expect(missingReasonRes.status).toBe(400);
      expect((await readJson<ProblemDetailsBody>(missingReasonRes)).code).toBe(
        'INVALID_INPUT',
      );

      // Overlong withdraw_reason (> 10,000)
      const longReasonRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 2,
            expected_quote_version: 1,
            withdraw_reason: 'a'.repeat(MAX_WITHDRAW_REASON_LENGTH + 1),
          }),
        },
      );
      expect(longReasonRes.status).toBe(400);
      expect((await readJson<ProblemDetailsBody>(longReasonRes)).code).toBe(
        'INVALID_INPUT',
      );

      // Null expected_quote_version (allowed only on submit, never withdraw)
      const nullVersionRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
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
            withdraw_reason: 'Lý do',
          }),
        },
      );
      expect(nullVersionRes.status).toBe(400);
      expect((await readJson<ProblemDetailsBody>(nullVersionRes)).code).toBe(
        'INVALID_INPUT',
      );

      // Extra unknown fields (z.strictObject anti-mass-assignment)
      const extraFieldRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 2,
            expected_quote_version: 1,
            withdraw_reason: 'Lý do',
            status: 'accepted',
          }),
        },
      );
      expect(extraFieldRes.status).toBe(400);
      expect((await readJson<ProblemDetailsBody>(extraFieldRes)).code).toBe(
        'INVALID_INPUT',
      );

      // Verify zero store mutation
      expect(quotesStore.get(compositeKey('10001', '301'))?.status).toBe(
        'active',
      );
      expect(historyLog).toHaveLength(0);
    });

    it('HT-06: maps stale versions to 409 CONCURRENCY_CONFLICT and invalid states (no quote, withdrawn, buyer_accepted, cancelled) to 422 INVALID_STATE', async () => {
      // Stale recipient version -> 409
      const staleRecRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 99,
            expected_quote_version: 1,
            withdraw_reason: 'Lý do',
          }),
        },
      );
      expect(staleRecRes.status).toBe(409);
      expect((await readJson<ProblemDetailsBody>(staleRecRes)).code).toBe(
        'CONCURRENCY_CONFLICT',
      );

      // Stale quote version -> 409
      const staleQuoteRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_2,
          },
          body: JSON.stringify({
            expected_recipient_version: 2,
            expected_quote_version: 99,
            withdraw_reason: 'Lý do',
          }),
        },
      );
      expect(staleQuoteRes.status).toBe(409);
      expect((await readJson<ProblemDetailsBody>(staleQuoteRes)).code).toBe(
        'CONCURRENCY_CONFLICT',
      );

      // Request buyer_accepted (e.g. concurrent accept won the race) -> 422 INVALID_STATE
      requestsStore.set(
        '10001',
        createSampleQuoteRequest({
          id: '10001',
          status: 'buyer_accepted',
          version: 4,
          bidding_deadline: futureBiddingDeadline,
          delivery_deadline: futureDeliveryDeadline,
        }),
      );
      const acceptedReqRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
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
            withdraw_reason: 'Rút sau khi Buyer đã chốt',
          }),
        },
      );
      expect(acceptedReqRes.status).toBe(422);
      expect((await readJson<ProblemDetailsBody>(acceptedReqRes)).code).toBe(
        'INVALID_STATE',
      );

      // Request cancelled -> 422 INVALID_STATE
      requestsStore.set(
        '10001',
        createSampleQuoteRequest({
          id: '10001',
          status: 'artisans_bidding',
          version: 4,
          bidding_deadline: futureBiddingDeadline,
          delivery_deadline: futureDeliveryDeadline,
          cancelled_at: new Date(),
          cancelled_by: '10',
          cancel_reason: 'Buyer hủy yêu cầu',
        }),
      );
      const cancelledReqRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_4,
          },
          body: JSON.stringify({
            expected_recipient_version: 2,
            expected_quote_version: 1,
            withdraw_reason: 'Rút khi yêu cầu đã hủy',
          }),
        },
      );
      expect(cancelledReqRes.status).toBe(422);
      expect((await readJson<ProblemDetailsBody>(cancelledReqRes)).code).toBe(
        'INVALID_STATE',
      );

      // Open request, no quote submitted yet -> 422 INVALID_STATE
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
      quotesStore.delete(compositeKey('10001', '301'));
      const noQuoteRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_5,
          },
          body: JSON.stringify({
            expected_recipient_version: 2,
            expected_quote_version: 1,
            withdraw_reason: 'Chưa gửi báo giá',
          }),
        },
      );
      expect(noQuoteRes.status).toBe(422);
      expect((await readJson<ProblemDetailsBody>(noQuoteRes)).code).toBe(
        'INVALID_STATE',
      );

      // Already withdrawn quote -> 422 INVALID_STATE
      quotesStore.set(
        compositeKey('10001', '301'),
        createSampleQuote({
          id: '401',
          request_id: '10001',
          workshop_id: '301',
          status: 'withdrawn',
          withdraw_reason: 'Đã rút trước đó',
          withdrawn_by: '20',
          withdrawn_at: NOW,
          version: 2,
          bid_accept_deadline: new Date(validAcceptDeadlineIso),
          committed_delivery_at: new Date(validCommittedDeliveryIso),
        }),
      );
      recipientsStore.set(
        compositeKey('10001', '301'),
        createSampleRecipient({
          id: '11001',
          request_id: '10001',
          workshop_id: '301',
          response_status: 'withdrawn',
          version: 3,
        }),
      );
      const alreadyWithdrawnRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/quote/withdraw`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': 'f670f185-7e25-4c00-915d-91bb277c8969',
          },
          body: JSON.stringify({
            expected_recipient_version: 3,
            expected_quote_version: 2,
            withdraw_reason: 'Rút lần 2 không dùng idempotency',
          }),
        },
      );
      expect(alreadyWithdrawnRes.status).toBe(422);
      expect((await readJson<ProblemDetailsBody>(alreadyWithdrawnRes)).code).toBe(
        'INVALID_STATE',
      );
    });

    it('HT-07: generates valid OpenAPI 3.0.0 Swagger spec, exports WithdrawQuoteUseCase from TradingModule, and boots AppModule cleanly', async () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const route =
        doc.paths['/api/v1/artisan/quote-requests/{id}/quote/withdraw']?.post;
      expect(route).toBeDefined();
      expect(route?.operationId).toBe(
        'ArtisanQuoteRequestController_withdrawQuote',
      );
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
                'withdraw_reason',
              ],
            },
          },
        },
      });
      expect(route?.responses?.['200']).toBeDefined();
      expect(route?.responses?.['400']).toBeDefined();
      expect(route?.responses?.['409']).toBeDefined();
      expect(route?.responses?.['422']).toBeDefined();

      const exported = Reflect.getMetadata('exports', TradingModule) as unknown[];
      expect(exported).toContain(WithdrawQuoteUseCase);

      const connectSpy = vi
        .spyOn(PrismaService.prototype, '$connect')
        .mockResolvedValue(undefined);
      const disconnectSpy = vi
        .spyOn(PrismaService.prototype, '$disconnect')
        .mockResolvedValue(undefined);
      const queryRawSpy = vi
        .spyOn(PrismaService.prototype, '$queryRaw')
        .mockResolvedValue([{ '?column?': 1 }]);

      let bootedApp: NestExpressApplication | undefined;
      try {
        bootedApp = await NestFactory.create<NestExpressApplication>(
          AppModule,
          { logger: false },
        );
        await bootedApp.init();

        expect(bootedApp.get(WithdrawQuoteUseCase)).toBeInstanceOf(
          WithdrawQuoteUseCase,
        );
        expect(bootedApp.get(ArtisanQuoteRequestController)).toBeInstanceOf(
          ArtisanQuoteRequestController,
        );
      } finally {
        await bootedApp?.close();
        connectSpy.mockRestore();
        disconnectSpy.mockRestore();
        queryRawSpy.mockRestore();
      }
    });
  });
});
