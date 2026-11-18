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
import { AppModule } from '../../../../src/bootstrap/app.module';
import { AppLogger } from '../../../../src/common/observability/app-logger';
import { AppConfigModule } from '../../../../src/common/config/app-config';
import { SecurityModule } from '../../../../src/common/security/security.module';
import { createApiDocument } from '../../../../src/common/http/swagger/configure-swagger';
import { IDENTITY_CONTRACT } from '../../../../src/modules/identity/public/contracts/identity.contract';
import {
  TRADING_CONTRACT,
  type ITradingContract,
} from '../../../../src/modules/trading/public/contracts/trading.contract';
import { WORKSHOP_CONTRACT } from '../../../../src/modules/workshops/public/contracts/workshop.contract';
import {
  TRANSACTION_RUNNER,
  type TransactionContext,
} from '../../../../src/common/application/ports/transaction-runner';
import type { AuthenticatedActor } from '../../../../src/common/application/types/contract-types';
import { PrismaService } from '../../../../src/infrastructure/database/prisma/prisma.service';
import { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import { TradingModule } from '../../../../src/modules/trading/trading.module';
import {
  IDEMPOTENCY_RECORD_REPOSITORY,
  QUOTE_REPOSITORY,
  QUOTE_REQUEST_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
  ALLOCATION_REPOSITORY,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { DeclineQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/quotations/decline-quote-request.use-case';
import { TradingIdempotencyService } from '../../../../src/modules/trading/application/services/trading-idempotency.service';
import { ArtisanQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/artisan-quote-request.controller';
import { QuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/quote-request.controller';
import {
  TRADING_CURRENT_STATE_RESOLVER,
  TradingCurrentStateResolver,
} from '../../../../src/modules/trading/adapters/http/interceptors/trading-current-state.resolver';
import { TradingMutationInterceptor } from '../../../../src/modules/trading/adapters/http/interceptors/trading-mutation.interceptor';
import { ListArtisanQuoteRequestsUseCase } from '../../../../src/modules/trading/application/use-cases/requests/list-artisan-quote-requests.use-case';
import { PrismaQuoteRequestRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository';
import { PrismaRequestRecipientRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository';
import { PrismaQuoteRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/quote.repository';
import { RecipientResponseHistoryMapper } from '../../../../src/modules/trading/adapters/persistence/mappers/recipient-response-history.mapper';
import {
  BiddingClosedError,
  computeCanonicalFingerprint,
  ConcurrencyConflictError,
  IdempotencyConflictError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  MAX_DECLINE_REASON_LENGTH,
  Quote,
  QuoteRequest,
  QuoteRequestNotFoundError,
  RequestRecipient,
  TradingDomainError,
  TradingPermissionDeniedError,
  type RecipientResponseRecord,
} from '../../../../src/modules/trading/domain';
import type {
  CreateIdempotencyRecordInput,
  IdempotencyScopeKey,
  PersistedIdempotencyRecord,
} from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import { MockWorkshopContract } from '../../../support/mocks/workshop.mock';

const SENT_AT = new Date('2026-11-10T08:00:00.000Z');
const BIDDING_DEADLINE = new Date('2026-12-01T10:00:00.000Z');
const DELIVERY_DEADLINE = new Date('2026-12-15T10:00:00.000Z');
const NOW = new Date('2026-11-12T09:00:00.000Z');

const VALID_IDEMPOTENCY_KEY_1 = 'b85ebf30-2f70-47bb-8d08-46ccf22d3414';
const VALID_IDEMPOTENCY_KEY_2 = 'd91cbf41-3a81-48cc-9e19-57ddf33e4525';
const VALID_IDEMPOTENCY_KEY_3 = 'e02dcf52-4b92-49dd-af2a-68eef44f5636';

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

function createSampleQuoteRequest(
  overrides: Partial<{
    id: string;
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
  return QuoteRequest.reconstitute({
    id: overrides.id ?? '10001',
    buyer_id: '10',
    category_id: '3',
    spec: 'Bộ ấm chén tử sa men rạn cao cấp',
    quantity: 500,
    unit: 'set',
    unit_set_description: '1 ấm + 6 chén',
    status: overrides.status ?? 'sent_to_artisans',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội, Gia Lâm',
    delivery_address: '123 Đường Gốm, Bát Tràng',
    recipient_name: 'Nguyễn Văn A',
    recipient_phone: '0912345678',
    bidding_deadline:
      overrides.bidding_deadline !== undefined
        ? overrides.bidding_deadline
        : BIDDING_DEADLINE,
    delivery_deadline:
      overrides.delivery_deadline !== undefined
        ? overrides.delivery_deadline
        : DELIVERY_DEADLINE,
    bidding_closed_at: overrides.bidding_closed_at ?? null,
    split_requested_at: null,
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
    status: 'active' | 'withdrawn' | 'accepted';
    version: number;
  }> = {},
): Quote {
  return Quote.reconstitute({
    id: overrides.id ?? '12001',
    request_id: overrides.request_id ?? '10001',
    workshop_id: overrides.workshop_id ?? '301',
    unit_price: 45_000,
    max_quantity: 500,
    bid_accept_deadline: new Date('2026-12-03T10:00:00.000Z'),
    committed_delivery_at: new Date('2026-12-12T10:00:00.000Z'),
    status: overrides.status ?? 'active',
    version: overrides.version ?? 1,
    withdraw_reason:
      overrides.status === 'withdrawn' ? 'Thiếu nguyên liệu' : null,
    withdrawn_by: overrides.status === 'withdrawn' ? '20' : null,
    withdrawn_at:
      overrides.status === 'withdrawn' ? new Date('2026-11-11T10:00:00.000Z') : null,
    created_at: SENT_AT,
    updated_at: SENT_AT,
  });
}

describe('Task 18: Artisan Decline Quote Request (POST /api/v1/artisan/quote-requests/:id/decline — UC-16, BR-15)', () => {
  describe('DeclineQuoteRequestUseCase (Pure Application & Domain Logic)', () => {
    it('UT-01: declines pending invitation with trimmed decline_reason, keeps QuoteRequest intact, and writes RecipientResponseHistory', async () => {
      const txRunner = new MockTransactionRunner();
      const request = createSampleQuoteRequest({
        id: '10001',
        status: 'artisans_bidding',
        version: 3,
      });
      const recipient = createSampleRecipient({
        id: '11001',
        request_id: '10001',
        workshop_id: '301',
        response_status: 'pending',
        version: 1,
      });

      const quoteRequestRepo = {
        lockById: vi.fn().mockResolvedValue(request),
        update: vi.fn(),
      };

      let capturedHistory: RecipientResponseRecord | undefined;
      const recipientRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
        update: vi.fn().mockImplementation(async ({ recipient: updated, history }) => {
          capturedHistory = history;
          return updated;
        }),
      };

      const quoteRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      };

      const workshopContract = new MockWorkshopContract();
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng gốm mẫu Bát Tràng',
        status: 'active',
        isProfilePublic: true,
      });

      const useCase = new DeclineQuoteRequestUseCase(
        txRunner,
        quoteRequestRepo as any,
        recipientRepo as any,
        quoteRepo as any,
        workshopContract,
      );

      const result = await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 1,
        declineReason: '  Xưởng đang đầy tải lò nung tháng 11  ',
        now: NOW,
      });

      expect(result.recipient).toEqual({
        id: '11001',
        request_id: '10001',
        workshop: { id: '301', name: 'Xưởng gốm mẫu Bát Tràng' },
        response_status: 'declined',
        version: 2,
        sent_at: SENT_AT.toISOString(),
        responded_at: NOW.toISOString(),
        decline_reason: 'Xưởng đang đầy tải lò nung tháng 11',
        eligibility_labels: [],
      });

      expect(result.currentState).toEqual({
        request: {
          id: '10001',
          status: 'artisans_bidding',
          version: 3,
          cancelled_at: null,
        },
        recipient: {
          id: '11001',
          status: 'declined',
          version: 2,
        },
      });

      expect(capturedHistory).toEqual({
        recipient_id: '11001',
        quote_id: null,
        event_type: 'declined',
        prev_status: 'pending',
        new_status: 'declined',
        reason: 'Xưởng đang đầy tải lò nung tháng 11',
        quote_snapshot: null,
        performed_by: '20',
        created_at: NOW,
      });

      expect(quoteRequestRepo.update).not.toHaveBeenCalled();
      expect(quoteRepo.create).not.toHaveBeenCalled();

      // Verify deterministic lock order: QuoteRequest -> RequestRecipient -> Quote
      const reqOrder = quoteRequestRepo.lockById.mock.invocationCallOrder[0];
      const recOrder =
        recipientRepo.lockByRequestAndWorkshop.mock.invocationCallOrder[0];
      const quoteOrder =
        quoteRepo.lockByRequestAndWorkshop.mock.invocationCallOrder[0];
      expect(reqOrder).toBeLessThan(recOrder);
      expect(recOrder).toBeLessThan(quoteOrder);
    });

    it('UT-02: normalizes omitted, null, and whitespace-only decline_reason to null in both entity and history', async () => {
      for (const reasonInput of [undefined, null, '   \t\n  ']) {
        const txRunner = new MockTransactionRunner();
        const request = createSampleQuoteRequest({ status: 'sent_to_artisans' });
        const recipient = createSampleRecipient({ response_status: 'pending' });
        let capturedHistory: RecipientResponseRecord | undefined;

        const quoteRequestRepo = { lockById: vi.fn().mockResolvedValue(request) };
        const recipientRepo = {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
          update: vi.fn().mockImplementation(async ({ recipient: updated, history }) => {
            capturedHistory = history;
            return updated;
          }),
        };
        const quoteRepo = {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
        };

        const useCase = new DeclineQuoteRequestUseCase(
          txRunner,
          quoteRequestRepo as any,
          recipientRepo as any,
          quoteRepo as any,
        );

        const result = await useCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 1,
          declineReason: reasonInput,
          now: NOW,
        });

        expect(result.recipient.decline_reason).toBeNull();
        expect(capturedHistory?.reason).toBeNull();
        expect(result.recipient.workshop).toEqual({ id: '301', name: '' });
      }
    });

    it('UT-03: allows suspended workshop to decline an open invitation without calling lockAndAssertActive (BR-15)', async () => {
      const txRunner = new MockTransactionRunner();
      const request = createSampleQuoteRequest({ status: 'sent_to_artisans' });
      const recipient = createSampleRecipient({ response_status: 'pending' });
      const workshopContract = new MockWorkshopContract().givenSuspended('301');
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng tạm ngừng',
        status: 'suspended',
        isProfilePublic: false,
      });

      const useCase = new DeclineQuoteRequestUseCase(
        txRunner,
        { lockById: vi.fn().mockResolvedValue(request) } as any,
        {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
          update: vi.fn().mockImplementation(async ({ recipient: r }) => r),
        } as any,
        { lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null) } as any,
        workshopContract,
      );

      const result = await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 1,
        declineReason: 'Đang tạm ngừng bảo trì lò',
        now: NOW,
      });

      expect(result.recipient.response_status).toBe('declined');
      expect(result.recipient.eligibility_labels).toEqual(['WORKSHOP_SUSPENDED']);
      expect(workshopContract.lockAndAssertActive).not.toHaveBeenCalled();
    });

    it('UT-04: passes through external TransactionContext input.tx without starting a nested txRunner.run', async () => {
      const txRunner = new MockTransactionRunner();
      const externalTx = { txTag: 'external-tx' } as unknown as TransactionContext;
      const request = createSampleQuoteRequest();
      const recipient = createSampleRecipient();

      const quoteRequestRepo = { lockById: vi.fn().mockResolvedValue(request) };
      const recipientRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
        update: vi.fn().mockImplementation(async ({ recipient: r }) => r),
      };
      const quoteRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
      };

      const useCase = new DeclineQuoteRequestUseCase(
        txRunner,
        quoteRequestRepo as any,
        recipientRepo as any,
        quoteRepo as any,
      );

      await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 1,
        now: NOW,
        tx: externalTx,
      });

      expect(txRunner.contexts).toHaveLength(0);
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
      expect(recipientRepo.update).toHaveBeenCalledWith(
        expect.anything(),
        externalTx,
      );
    });

    it('UT-05: rejects non-artisan role, missing workshopId, and temp_password sessions (SEC-05, SEC-06)', async () => {
      const useCase = new DeclineQuoteRequestUseCase(
        new MockTransactionRunner(),
        { lockById: vi.fn() } as any,
        { lockByRequestAndWorkshop: vi.fn(), update: vi.fn() } as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '10001',
          expectedRecipientVersion: 1,
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '10001',
          expectedRecipientVersion: 1,
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      await expect(
        useCase.execute({
          actor: artisanWithoutWorkshopActor,
          requestId: '10001',
          expectedRecipientVersion: 1,
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      await expect(
        useCase.execute({
          actor: tempPasswordArtisanActor,
          requestId: '10001',
          expectedRecipientVersion: 1,
        }),
      ).rejects.toMatchObject({
        code: 'TEMP_PASSWORD_RESTRICTED',
      });
    });

    it('UT-06: throws identical 404 QuoteRequestNotFoundError for missing request OR uninvited workshop (SEC-06 anti-IDOR)', async () => {
      const missingReqUseCase = new DeclineQuoteRequestUseCase(
        new MockTransactionRunner(),
        { lockById: vi.fn().mockResolvedValue(null) } as any,
        { lockByRequestAndWorkshop: vi.fn(), update: vi.fn() } as any,
      );

      await expect(
        missingReqUseCase.execute({
          actor: artisanActor,
          requestId: '99999',
          expectedRecipientVersion: 1,
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      const uninvitedUseCase = new DeclineQuoteRequestUseCase(
        new MockTransactionRunner(),
        {
          lockById: vi.fn().mockResolvedValue(createSampleQuoteRequest()),
        } as any,
        {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        } as any,
      );

      await expect(
        uninvitedUseCase.execute({
          actor: otherArtisanActor,
          requestId: '10001',
          expectedRecipientVersion: 1,
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);
    });

    it('UT-07: validates requestId, expectedRecipientVersion, and decline_reason max length boundary (10,000 vs 10,001)', async () => {
      const request = createSampleQuoteRequest();
      const recipient = createSampleRecipient();
      const recipientRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
        update: vi.fn().mockImplementation(async ({ recipient: r }) => r),
      };
      const useCase = new DeclineQuoteRequestUseCase(
        new MockTransactionRunner(),
        { lockById: vi.fn().mockResolvedValue(request) } as any,
        recipientRepo as any,
      );

      for (const badId of ['', '0', '-5', 'abc']) {
        await expect(
          useCase.execute({
            actor: artisanActor,
            requestId: badId,
            expectedRecipientVersion: 1,
          }),
        ).rejects.toThrow(InvalidTradingInputError);
      }

      for (const badVersion of [0, -1, 1.5, Number.NaN]) {
        await expect(
          useCase.execute({
            actor: artisanActor,
            requestId: '10001',
            expectedRecipientVersion: badVersion,
          }),
        ).rejects.toThrow(InvalidTradingInputError);
      }

      const maxBoundary = 'a'.repeat(MAX_DECLINE_REASON_LENGTH);
      const ok = await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 1,
        declineReason: `  ${maxBoundary}  `,
        now: NOW,
      });
      expect(ok.recipient.decline_reason).toBe(maxBoundary);

      const overLimit = 'a'.repeat(MAX_DECLINE_REASON_LENGTH + 1);
      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 1,
          declineReason: overLimit,
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('UT-08: rejects closed/expired bidding (422 BIDDING_CLOSED) and cancelled/accepted/draft requests (422 INVALID_STATE)', async () => {
      const recipient = createSampleRecipient();
      const updateSpy = vi.fn();

      // Early closed
      const earlyClosedReq = createSampleQuoteRequest({
        bidding_closed_at: new Date('2026-11-11T12:00:00.000Z'),
      });
      const earlyClosedUseCase = new DeclineQuoteRequestUseCase(
        new MockTransactionRunner(),
        { lockById: vi.fn().mockResolvedValue(earlyClosedReq) } as any,
        {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
          update: updateSpy,
        } as any,
      );
      await expect(
        earlyClosedUseCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 1,
          now: NOW,
        }),
      ).rejects.toThrow(BiddingClosedError);

      // Exact deadline boundary (now === bidding_deadline -> closed)
      const openReq = createSampleQuoteRequest();
      const deadlineUseCase = new DeclineQuoteRequestUseCase(
        new MockTransactionRunner(),
        { lockById: vi.fn().mockResolvedValue(openReq) } as any,
        {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
          update: updateSpy,
        } as any,
      );
      await expect(
        deadlineUseCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 1,
          now: BIDDING_DEADLINE,
        }),
      ).rejects.toThrow(BiddingClosedError);

      // Cancelled, buyer_accepted, in_production, delivered, draft_request -> 422 INVALID_STATE
      const invalidRequests = [
        createSampleQuoteRequest({
          cancelled_at: new Date('2026-11-11T10:00:00.000Z'),
          cancelled_by: '10',
        }),
        createSampleQuoteRequest({ status: 'buyer_accepted' }),
        createSampleQuoteRequest({ status: 'in_production' }),
        createSampleQuoteRequest({ status: 'delivered' }),
        createSampleQuoteRequest({
          status: 'draft_request',
          bidding_deadline: null,
          delivery_deadline: null,
        }),
      ];

      for (const reqEntity of invalidRequests) {
        const invalidStateUseCase = new DeclineQuoteRequestUseCase(
          new MockTransactionRunner(),
          { lockById: vi.fn().mockResolvedValue(reqEntity) } as any,
          {
            lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
            update: updateSpy,
          } as any,
        );
        await expect(
          invalidStateUseCase.execute({
            actor: artisanActor,
            requestId: '10001',
            expectedRecipientVersion: 1,
            now: NOW,
          }),
        ).rejects.toThrow(InvalidStateTransitionError);
      }

      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('UT-09: rejects already declined, quoted, withdrawn recipients or existing Quote row (BR-15)', async () => {
      const request = createSampleQuoteRequest({ status: 'artisans_bidding' });
      const updateSpy = vi.fn();

      for (const status of ['declined', 'quoted', 'withdrawn'] as const) {
        const recipient = createSampleRecipient({
          response_status: status,
          version: 2,
        });
        const useCase = new DeclineQuoteRequestUseCase(
          new MockTransactionRunner(),
          { lockById: vi.fn().mockResolvedValue(request) } as any,
          {
            lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
            update: updateSpy,
          } as any,
          { lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null) } as any,
        );

        await expect(
          useCase.execute({
            actor: artisanActor,
            requestId: '10001',
            expectedRecipientVersion: 2,
            now: NOW,
          }),
        ).rejects.toThrow(InvalidStateTransitionError);
      }

      // Defensive Quote existence check even if recipient row were still 'pending'
      const pendingRecipient = createSampleRecipient({ response_status: 'pending' });
      const existingQuote = createSampleQuote({ status: 'withdrawn' });
      const quoteExistsUseCase = new DeclineQuoteRequestUseCase(
        new MockTransactionRunner(),
        { lockById: vi.fn().mockResolvedValue(request) } as any,
        {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(pendingRecipient),
          update: updateSpy,
        } as any,
        {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(existingQuote),
        } as any,
      );

      await expect(
        quoteExistsUseCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 1,
          now: NOW,
        }),
      ).rejects.toThrow(InvalidStateTransitionError);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('UT-10: throws ConcurrencyConflictError (409) when expected_recipient_version does not match', async () => {
      const request = createSampleQuoteRequest();
      const recipient = createSampleRecipient({ version: 2 });
      const updateSpy = vi.fn();

      const useCase = new DeclineQuoteRequestUseCase(
        new MockTransactionRunner(),
        { lockById: vi.fn().mockResolvedValue(request) } as any,
        {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
          update: updateSpy,
        } as any,
      );

      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 1,
          now: NOW,
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRecipientVersion: 3,
          now: NOW,
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      expect(updateSpy).not.toHaveBeenCalled();
    });
  });

  describe('Domain & Mapper Invariants (RequestRecipient.decline & RecipientResponseHistoryMapper)', () => {
    it('DM-01: enforces MAX_DECLINE_REASON_LENGTH directly in RequestRecipient.decline and maps valid Prisma history input', () => {
      const recipient = createSampleRecipient({ version: 1 });

      expect(() =>
        recipient.decline({
          actorId: '20',
          expectedVersion: 1,
          reason: 'x'.repeat(MAX_DECLINE_REASON_LENGTH + 1),
          requestBiddingOpen: true,
          requestAcceptedOrCancelled: false,
          now: NOW,
        }),
      ).toThrow(InvalidTradingInputError);

      const { recipient: updated, history } = recipient.decline({
        actorId: '20',
        expectedVersion: 1,
        reason: '  Không kịp tiến độ  ',
        requestBiddingOpen: true,
        requestAcceptedOrCancelled: false,
        now: NOW,
      });

      expect(updated.version).toBe(2);
      expect(updated.response_status).toBe('declined');
      expect(updated.decline_reason).toBe('Không kịp tiến độ');

      const prismaHistory = RecipientResponseHistoryMapper.toPrismaCreateInput(
        history,
        Prisma.DbNull,
      );
      expect(prismaHistory).toMatchObject({
        recipient_id: 11001n,
        quote_id: null,
        event_type: 'declined',
        prev_status: 'pending',
        new_status: 'declined',
        reason: 'Không kịp tiến độ',
        quote_snapshot: Prisma.DbNull,
        performed_by: 20n,
      });
    });
  });

  describe('Mock-Prisma Repository & FOR UPDATE Locking Verification', () => {
    it('PR-01: executes SELECT ... FOR UPDATE on QuoteRequest, RequestRecipient, and Quote, updates with optimistic version, and inserts RecipientResponseHistory', async () => {
      const mockClient = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: 10001n }])
          .mockResolvedValueOnce([{ id: 11001n }])
          .mockResolvedValueOnce([]),
        quoteRequest: {
          findUnique: vi.fn().mockResolvedValue({
            id: 10001n,
            buyer_id: 10n,
            category_id: 3n,
            spec: 'Ấm chén men ngọc',
            quantity: 200,
            unit: 'set',
            unit_set_description: '1 ấm 6 chén',
            status: 'sent_to_artisans',
            delivery_mode: 'at_workshop',
            delivery_region: null,
            delivery_address: null,
            recipient_name: 'Buyer',
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
          }),
        },
        requestRecipient: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce({
              id: 11001n,
              request_id: 10001n,
              workshop_id: 301n,
              response_status: 'pending',
              decline_reason: null,
              responded_by: null,
              responded_at: null,
              sent_at: SENT_AT,
              version: 1,
            })
            .mockResolvedValueOnce({
              id: 11001n,
              request_id: 10001n,
              workshop_id: 301n,
              response_status: 'declined',
              decline_reason: 'Hết công suất',
              responded_by: 20n,
              responded_at: NOW,
              sent_at: SENT_AT,
              version: 2,
            }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        recipientResponseHistory: {
          create: vi.fn().mockResolvedValue({ id: 50001n }),
        },
        quote: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };

      const mockPrismaService = {
        $transaction: vi.fn(
          async (fn: (tx: unknown) => Promise<unknown>) => await fn(mockClient),
        ),
      } as unknown as PrismaService;
      const txRunner = new PrismaTransactionRunner(mockPrismaService);

      const useCase = new DeclineQuoteRequestUseCase(
        txRunner,
        new PrismaQuoteRequestRepository(txRunner),
        new PrismaRequestRecipientRepository(txRunner),
        new PrismaQuoteRepository(txRunner),
      );

      const result = await useCase.execute({
        actor: artisanActor,
        requestId: '10001',
        expectedRecipientVersion: 1,
        declineReason: 'Hết công suất',
        now: NOW,
      });

      expect(result.recipient.response_status).toBe('declined');
      expect(result.recipient.version).toBe(2);
      expect(mockClient.$queryRaw).toHaveBeenCalledTimes(3);
      expect(mockClient.requestRecipient.updateMany).toHaveBeenCalledWith({
        where: { id: 11001n, version: 1 },
        data: expect.objectContaining({
          response_status: 'declined',
          decline_reason: 'Hết công suất',
          responded_by: 20n,
          responded_at: NOW,
          version: 2,
        }),
      });
      expect(mockClient.recipientResponseHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          recipient_id: 11001n,
          quote_id: null,
          event_type: 'declined',
          prev_status: 'pending',
          new_status: 'declined',
          reason: 'Hết công suất',
          quote_snapshot: Prisma.DbNull,
          performed_by: 20n,
        }),
      });
    });
  });

  describe('HTTP Controller, ValidationPipe, Guards, Idempotency & CurrentStateResolver (POST /api/v1/artisan/quote-requests/:id/decline)', () => {
    let app: NestExpressApplication;
    let base: string;
    let identityMock: MockIdentityContract;
    let workshopMock: MockWorkshopContract;

    // Stateful in-memory stores for full HTTP + Idempotency + Replay testing
    const requestsStore = new Map<string, QuoteRequest>();
    const recipientsStore = new Map<string, RequestRecipient>();
    const quotesStore = new Map<string, Quote>();
    const idempotencyStore = new Map<string, PersistedIdempotencyRecord<unknown>>();
    const historyLog: RecipientResponseRecord[] = [];
    let nextIdempotencySeq = 19001;

    function recipientKey(requestId: string, workshopId: string): string {
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
          recipientsStore.get(recipientKey(requestId, workshopId)) ?? null,
      ),
      lockByRequestAndWorkshop: vi.fn(
        async (requestId: string, workshopId: string) =>
          recipientsStore.get(recipientKey(requestId, workshopId)) ?? null,
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
          const key = recipientKey(recipient.request_id, recipient.workshop_id);
          const current = recipientsStore.get(key);
          if (!current || (expectedVersion && current.version !== expectedVersion)) {
            throw new ConcurrencyConflictError('Version mismatch');
          }
          recipientsStore.set(key, recipient);
          if (history) {
            historyLog.push(history);
          }
          return recipient;
        },
      ),
    };

    const inMemoryQuoteRepo = {
      findById: vi.fn().mockResolvedValue(null),
      lockByRequestAndWorkshop: vi.fn(
        async (requestId: string, workshopId: string) =>
          quotesStore.get(recipientKey(requestId, workshopId)) ?? null,
      ),
    };

    const inMemoryAllocationRepo = {
      findById: vi.fn().mockResolvedValue(null),
    };

    const inMemoryIdempotencyRepo = {
      findByScope: vi.fn(async (scope: IdempotencyScopeKey) => {
        return idempotencyStore.get(scopeKey(scope)) ?? null;
      }),
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
      }),
      findAndVerifyReplay: vi.fn(async () => null),
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
          { provide: QUOTE_REQUEST_REPOSITORY, useValue: inMemoryQuoteRequestRepo },
          { provide: REQUEST_RECIPIENT_REPOSITORY, useValue: inMemoryRecipientRepo },
          { provide: QUOTE_REPOSITORY, useValue: inMemoryQuoteRepo },
          { provide: ALLOCATION_REPOSITORY, useValue: inMemoryAllocationRepo },
          {
            provide: IDEMPOTENCY_RECORD_REPOSITORY,
            useValue: inMemoryIdempotencyRepo,
          },
          { provide: WORKSHOP_CONTRACT, useValue: workshopMock },
          {
            provide: TradingIdempotencyService,
            useFactory: (repo: any, txRunner: any) =>
              new TradingIdempotencyService(repo, txRunner),
            inject: [IDEMPOTENCY_RECORD_REPOSITORY, TRANSACTION_RUNNER],
          },
          {
            provide: TRADING_CURRENT_STATE_RESOLVER,
            useFactory: (
              qrRepo: any,
              allocRepo: any,
              qRepo: any,
              recRepo: any,
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
            useFactory: (txRunner: any, qrRepo: any) =>
              new ListArtisanQuoteRequestsUseCase(txRunner, qrRepo),
            inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
          },
          {
            provide: DeclineQuoteRequestUseCase,
            useFactory: (
              txRunner: any,
              qrRepo: any,
              recRepo: any,
              qRepo: any,
              wsContract: any,
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
      nextIdempotencySeq = 19001;
      vi.clearAllMocks();

      requestsStore.set(
        '10001',
        createSampleQuoteRequest({
          id: '10001',
          status: 'artisans_bidding',
          version: 3,
          bidding_deadline: new Date(Date.now() + 86_400_000),
          delivery_deadline: new Date(Date.now() + 7 * 86_400_000),
        }),
      );
      recipientsStore.set(
        recipientKey('10001', '301'),
        createSampleRecipient({
          id: '11001',
          request_id: '10001',
          workshop_id: '301',
          response_status: 'pending',
          version: 1,
        }),
      );

      workshopMock.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng gốm mẫu Bát Tràng',
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

    it('HT-01: POST /api/v1/artisan/quote-requests/:id/decline succeeds (200) with operation.current_state including request + recipient', async () => {
      const res = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            decline_reason: '  Xưởng đang đầy tải.  ',
          }),
        },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
      const body = (await res.json()) as any;
      expect(body).toMatchObject({
        success: true,
        data: {
          id: '11001',
          request_id: '10001',
          workshop: { id: '301', name: 'Xưởng gốm mẫu Bát Tràng' },
          response_status: 'declined',
          version: 2,
          sent_at: SENT_AT.toISOString(),
          decline_reason: 'Xưởng đang đầy tải.',
          eligibility_labels: [],
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
              status: 'declined',
              version: 2,
            },
          },
        },
      });
      expect(typeof body.data.responded_at).toBe('string');
      expect(historyLog).toHaveLength(1);
    });

    it('HT-02: accepts omitted, null, and whitespace-only decline_reason returning decline_reason: null', async () => {
      const payloads = [
        { expected_recipient_version: 1 },
        { expected_recipient_version: 1, decline_reason: null },
        { expected_recipient_version: 1, decline_reason: '   ' },
      ];
      const keys = [
        VALID_IDEMPOTENCY_KEY_1,
        VALID_IDEMPOTENCY_KEY_2,
        VALID_IDEMPOTENCY_KEY_3,
      ];

      for (let i = 0; i < payloads.length; i++) {
        recipientsStore.set(
          recipientKey('10001', '301'),
          createSampleRecipient({
            id: '11001',
            request_id: '10001',
            workshop_id: '301',
            response_status: 'pending',
            version: 1,
          }),
        );
        idempotencyStore.clear();

        const res = await fetch(
          `${base}/api/v1/artisan/quote-requests/10001/decline`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: 'vcraft-session=artisan-token',
              'X-Idempotency-Key': keys[i],
            },
            body: JSON.stringify(payloads[i]),
          },
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.data.response_status).toBe('declined');
        expect(body.data.decline_reason).toBeNull();
      }
    });

    it('HT-03: allows suspended workshop to decline over HTTP (BR-15) and returns WORKSHOP_SUSPENDED label', async () => {
      workshopMock.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng tạm ngừng',
        status: 'suspended',
        isProfilePublic: false,
      });

      const res = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({ expected_recipient_version: 1 }),
        },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
      const body = (await res.json()) as any;
      expect(body.data.response_status).toBe('declined');
      expect(body.data.eligibility_labels).toEqual(['WORKSHOP_SUSPENDED']);
    });

    it('HT-04: idempotency replay keeps cached data, sets replayed: true, refreshes current_state, and rejects payload mismatch with 409 IDEMPOTENCY_CONFLICT', async () => {
      const payload = {
        expected_recipient_version: 1,
        decline_reason: 'Bận đơn hàng xuất khẩu',
      };

      const firstRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
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
      expect(firstRes.headers.get('cache-control')).toContain('no-store');
      const firstBody = (await firstRes.json()) as any;
      expect(firstBody.operation.replayed).toBe(false);

      // Simulate later change: artisan changed mind and submitted a quote (recipient now 'quoted' v3)
      recipientsStore.set(
        recipientKey('10001', '301'),
        createSampleRecipient({
          id: '11001',
          request_id: '10001',
          workshop_id: '301',
          response_status: 'quoted',
          version: 3,
        }),
      );

      // Replay with exact same key & payload (expected_recipient_version still 1)
      const replayRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
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
      expect(replayRes.headers.get('cache-control')).toContain('no-store');
      const replayBody = (await replayRes.json()) as any;
      expect(replayBody.data).toEqual(firstBody.data); // cached snapshot preserved
      expect(replayBody.operation.replayed).toBe(true);
      expect(replayBody.operation.current_state).toEqual({
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
      });
      expect(historyLog).toHaveLength(1); // No duplicate history row

      // Reuse same key with different payload -> 409 IDEMPOTENCY_CONFLICT
      const conflictRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            decline_reason: 'Lý do khác',
          }),
        },
      );
      expect(conflictRes.status).toBe(409);
      const conflictBody = (await conflictRes.json()) as any;
      expect(conflictBody.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('HT-05: rejects missing/invalid X-Idempotency-Key, strict DTO violations, and invalid :id with 400 INVALID_INPUT', async () => {
      // Missing X-Idempotency-Key
      const missingKeyRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
          },
          body: JSON.stringify({ expected_recipient_version: 1 }),
        },
      );
      expect(missingKeyRes.status).toBe(400);
      expect(((await missingKeyRes.json()) as any).code).toBe('INVALID_INPUT');

      // Malformed X-Idempotency-Key
      const badKeyRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': 'not-a-uuid-v4',
          },
          body: JSON.stringify({ expected_recipient_version: 1 }),
        },
      );
      expect(badKeyRes.status).toBe(400);
      expect(((await badKeyRes.json()) as any).code).toBe('INVALID_INPUT');

      // Unknown extra fields (mass assignment attempt)
      const extraFieldRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({
            expected_recipient_version: 1,
            workshop_id: '999',
            response_status: 'quoted',
          }),
        },
      );
      expect(extraFieldRes.status).toBe(400);
      const extraBody = (await extraFieldRes.json()) as any;
      expect(extraBody.code).toBe('INVALID_INPUT');
      expect(Array.isArray(extraBody.errors)).toBe(true);

      // String coercion rejected, <=0 version rejected, >10000 chars rejected, invalid :id rejected
      const invalidCases = [
        { id: '10001', body: { expected_recipient_version: '1' } },
        { id: '10001', body: { expected_recipient_version: 0 } },
        {
          id: '10001',
          body: {
            expected_recipient_version: 1,
            decline_reason: 'x'.repeat(10001),
          },
        },
        { id: 'not-an-id', body: { expected_recipient_version: 1 } },
      ];

      for (const testCase of invalidCases) {
        const res = await fetch(
          `${base}/api/v1/artisan/quote-requests/${testCase.id}/decline`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: 'vcraft-session=artisan-token',
              'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_2,
            },
            body: JSON.stringify(testCase.body),
          },
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as any).code).toBe('INVALID_INPUT');
      }
    });

    it('HT-06: enforces authentication, roles, temp_password restriction, and workshopId isolation (401/403)', async () => {
      // Unauthenticated -> 401
      const unauthRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({ expected_recipient_version: 1 }),
        },
      );
      expect(unauthRes.status).toBe(401);
      expect(((await unauthRes.json()) as any).code).toBe(
        'AUTHENTICATION_REQUIRED',
      );

      // Buyer -> 403 PERMISSION_DENIED
      const buyerRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=buyer-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({ expected_recipient_version: 1 }),
        },
      );
      expect(buyerRes.status).toBe(403);
      expect(((await buyerRes.json()) as any).code).toBe('PERMISSION_DENIED');

      // Admin -> 403 PERMISSION_DENIED
      const adminRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=admin-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({ expected_recipient_version: 1 }),
        },
      );
      expect(adminRes.status).toBe(403);
      expect(((await adminRes.json()) as any).code).toBe('PERMISSION_DENIED');

      // Temp password artisan -> 403 TEMP_PASSWORD_RESTRICTED
      const tempRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=temp-artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({ expected_recipient_version: 1 }),
        },
      );
      expect(tempRes.status).toBe(403);
      expect(((await tempRes.json()) as any).code).toBe(
        'TEMP_PASSWORD_RESTRICTED',
      );

      // Artisan without workshopId -> 403 PERMISSION_DENIED
      const noWorkshopRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=no-workshop-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({ expected_recipient_version: 1 }),
        },
      );
      expect(noWorkshopRes.status).toBe(403);
      expect(((await noWorkshopRes.json()) as any).code).toBe('PERMISSION_DENIED');
    });

    it('HT-07: maps 404 anti-IDOR, 409 CONCURRENCY_CONFLICT, 422 BIDDING_CLOSED, and 422 INVALID_STATE accurately', async () => {
      // Uninvited artisan -> 404 RESOURCE_NOT_FOUND
      const uninvitedRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=other-artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({ expected_recipient_version: 1 }),
        },
      );
      expect(uninvitedRes.status).toBe(404);
      expect(((await uninvitedRes.json()) as any).code).toBe('RESOURCE_NOT_FOUND');

      // Stale version -> 409 CONCURRENCY_CONFLICT
      const staleRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: JSON.stringify({ expected_recipient_version: 99 }),
        },
      );
      expect(staleRes.status).toBe(409);
      expect(((await staleRes.json()) as any).code).toBe('CONCURRENCY_CONFLICT');

      // Closed bidding -> 422 BIDDING_CLOSED
      requestsStore.set(
        '10001',
        createSampleQuoteRequest({
          id: '10001',
          status: 'artisans_bidding',
          version: 4,
          bidding_closed_at: new Date(Date.now() - 1_000),
          bidding_deadline: new Date(Date.now() + 86_400_000),
        }),
      );
      const closedRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_2,
          },
          body: JSON.stringify({ expected_recipient_version: 1 }),
        },
      );
      expect(closedRes.status).toBe(422);
      expect(((await closedRes.json()) as any).code).toBe('BIDDING_CLOSED');

      // Already quoted / withdrawn -> 422 INVALID_STATE
      requestsStore.set(
        '10001',
        createSampleQuoteRequest({
          id: '10001',
          status: 'artisans_bidding',
          version: 4,
          bidding_deadline: new Date(Date.now() + 86_400_000),
        }),
      );
      recipientsStore.set(
        recipientKey('10001', '301'),
        createSampleRecipient({
          id: '11001',
          request_id: '10001',
          workshop_id: '301',
          response_status: 'withdrawn',
          version: 2,
        }),
      );
      quotesStore.set(
        recipientKey('10001', '301'),
        createSampleQuote({ status: 'withdrawn', version: 2 }),
      );
      const withdrawnRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_3,
          },
          body: JSON.stringify({ expected_recipient_version: 2 }),
        },
      );
      expect(withdrawnRes.status).toBe(422);
      expect(((await withdrawnRes.json()) as any).code).toBe('INVALID_STATE');
    });

    it('HT-08: generates valid OpenAPI 3.0.0 Swagger spec for POST /api/v1/artisan/quote-requests/:id/decline', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const route =
        doc.paths['/api/v1/artisan/quote-requests/{id}/decline']?.post;
      expect(route).toBeDefined();
      expect(route?.operationId).toBe(
        'ArtisanQuoteRequestController_declineQuoteRequest',
      );
      expect((route as any)?.['x-roles']).toEqual(['artisan']);
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
              required: ['expected_recipient_version'],
            },
          },
        },
      });
      expect(route?.responses?.['200']).toBeDefined();
      expect(route?.responses?.['422']).toBeDefined();
    });

    it('HT-09A: AppModule compiles and boots cleanly in NestJS without UnknownExportException', async () => {
      const connectSpy = vi
        .spyOn(PrismaService.prototype, '$connect')
        .mockResolvedValue(undefined);
      const disconnectSpy = vi
        .spyOn(PrismaService.prototype, '$disconnect')
        .mockResolvedValue(undefined);
      const queryRawSpy = vi
        .spyOn(PrismaService.prototype, '$queryRaw' as any)
        .mockResolvedValue([{ '?column?': 1 }]);

      let bootedApp: NestExpressApplication | undefined;
      try {
        bootedApp = await NestFactory.create<NestExpressApplication>(
          AppModule,
          { logger: false },
        );
        await bootedApp.init();

        expect(bootedApp.get(ArtisanQuoteRequestController)).toBeInstanceOf(
          ArtisanQuoteRequestController,
        );
        expect(bootedApp.get(QuoteRequestController)).toBeInstanceOf(
          QuoteRequestController,
        );
        expect(bootedApp.get(DeclineQuoteRequestUseCase)).toBeInstanceOf(
          DeclineQuoteRequestUseCase,
        );
        expect(bootedApp.get(TradingMutationInterceptor)).toBeInstanceOf(
          TradingMutationInterceptor,
        );
        expect(bootedApp.get(TradingIdempotencyService)).toBeInstanceOf(
          TradingIdempotencyService,
        );
        expect(bootedApp.get(TRADING_CURRENT_STATE_RESOLVER)).toBeInstanceOf(
          TradingCurrentStateResolver,
        );
      } finally {
        await bootedApp?.close();
        connectSpy.mockRestore();
        disconnectSpy.mockRestore();
        queryRawSpy.mockRestore();
      }
    });

    it('HT-09B: TradingModule.register(...) compiles and boots cleanly in NestJS with TRADING_CONTRACT bound', async () => {
      const connectSpy = vi
        .spyOn(PrismaService.prototype, '$connect')
        .mockResolvedValue(undefined);
      const disconnectSpy = vi
        .spyOn(PrismaService.prototype, '$disconnect')
        .mockResolvedValue(undefined);
      const queryRawSpy = vi
        .spyOn(PrismaService.prototype, '$queryRaw' as any)
        .mockResolvedValue([{ '?column?': 1 }]);

      class DummyTradingContract implements ITradingContract {
        async getAllocationsForBatchValidation() {
          return [];
        }
        async checkAcceptedQuoteExists() {
          return false;
        }
        async cancelOpenRequestsOnWorkshopSuspend() {
          return 0;
        }
      }

      class TestRegisteredAppModule {}
      Module({
        imports: [
          SecurityModule.register(),
          TradingModule.register(DummyTradingContract),
        ],
      })(TestRegisteredAppModule);

      let registeredApp: NestExpressApplication | undefined;
      try {
        registeredApp = await NestFactory.create<NestExpressApplication>(
          TestRegisteredAppModule,
          { logger: false },
        );
        await registeredApp.init();

        expect(registeredApp.get(TRADING_CONTRACT)).toBeInstanceOf(
          DummyTradingContract,
        );
        expect(
          registeredApp.get(ArtisanQuoteRequestController),
        ).toBeInstanceOf(ArtisanQuoteRequestController);
        expect(registeredApp.get(DeclineQuoteRequestUseCase)).toBeInstanceOf(
          DeclineQuoteRequestUseCase,
        );
      } finally {
        await registeredApp?.close();
        connectSpy.mockRestore();
        disconnectSpy.mockRestore();
        queryRawSpy.mockRestore();
      }
    });

    it('PROTO-01: canonicalizeJson preserves __proto__ key and HTTP replay with __proto__ injection rejects with 409 IDEMPOTENCY_CONFLICT', async () => {
      const cleanObj = JSON.parse('{"expected_recipient_version":1}');
      const protoObj = JSON.parse(
        '{"expected_recipient_version":1,"__proto__":{"evil":true}}',
      );
      expect(computeCanonicalFingerprint(cleanObj)).not.toBe(
        computeCanonicalFingerprint(protoObj),
      );
      expect(({} as Record<string, unknown>).evil).toBeUndefined();

      // Commit clean request first
      const firstRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: '{"expected_recipient_version":1}',
        },
      );
      expect(firstRes.status).toBe(200);

      // Replay same X-Idempotency-Key with raw JSON containing __proto__
      const replayRes = await fetch(
        `${base}/api/v1/artisan/quote-requests/10001/decline`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=artisan-token',
            'X-Idempotency-Key': VALID_IDEMPOTENCY_KEY_1,
          },
          body: '{"expected_recipient_version":1,"__proto__":{"evil":true}}',
        },
      );
      expect(replayRes.status).toBe(409);
      const replayBody = (await replayRes.json()) as any;
      expect(replayBody.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(({} as Record<string, unknown>).evil).toBeUndefined();
    });

    it('CR-01: TradingCurrentStateResolver resolves recipient alongside request only when workshopId context is supplied', async () => {
      const dummyTx = { txId: 'tx-cr-01' } as unknown as TransactionContext;
      const req = createSampleQuoteRequest({
        id: '10001',
        status: 'artisans_bidding',
        version: 3,
      });
      const rec = createSampleRecipient({
        id: '11001',
        request_id: '10001',
        workshop_id: '301',
        response_status: 'declined',
        version: 2,
      });

      const qrRepo = { findById: vi.fn().mockResolvedValue(req) };
      const recRepo = {
        findById: vi.fn(),
        findByRequestAndWorkshop: vi
          .fn()
          .mockResolvedValueOnce(rec)
          .mockResolvedValueOnce(null),
      };
      const resolver = new TradingCurrentStateResolver(
        qrRepo as any,
        { findById: vi.fn() } as any,
        { findById: vi.fn() } as any,
        recRepo as any,
      );

      // Without context -> unchanged behavior (request only)
      const withoutCtx = await resolver.resolveCurrentState(
        'QuoteRequest',
        '10001',
        dummyTx,
      );
      expect(withoutCtx).toEqual({
        request: {
          id: '10001',
          status: 'artisans_bidding',
          version: 3,
          cancelled_at: null,
        },
      });

      // With workshopId context & existing recipient
      const withRecipient = await resolver.resolveCurrentState(
        'QuoteRequest',
        '10001',
        dummyTx,
        { workshopId: '301', action: 'decline' },
      );
      expect(withRecipient).toEqual({
        request: {
          id: '10001',
          status: 'artisans_bidding',
          version: 3,
          cancelled_at: null,
        },
        recipient: {
          id: '11001',
          status: 'declined',
          version: 2,
        },
      });

      // With workshopId context & missing recipient for decline action -> recipient: null
      const missingRecipient = await resolver.resolveCurrentState(
        'QuoteRequest',
        '10001',
        dummyTx,
        { workshopId: '301', action: 'decline' },
      );
      expect(missingRecipient.recipient).toBeNull();
    });
  });

  describe('Concurrent FOR UPDATE Lock Serialization & Idempotency Race Regression (CC-01..CC-03)', () => {
    function createSerializedForUpdateHarness() {
      let currentRequest = createSampleQuoteRequest({
        id: '10001',
        status: 'artisans_bidding',
        version: 3,
        bidding_deadline: BIDDING_DEADLINE,
        delivery_deadline: DELIVERY_DEADLINE,
      });
      let currentRecipient = createSampleRecipient({
        id: '11001',
        request_id: '10001',
        workshop_id: '301',
        response_status: 'pending',
        version: 1,
      });
      const historyRecords: RecipientResponseRecord[] = [];
      const committedIdempotency = new Map<
        string,
        PersistedIdempotencyRecord<unknown>
      >();
      let seq = 19001;

      const makeKey = (s: IdempotencyScopeKey) =>
        `${s.account_id}|${s.action}|${s.object_type}|${s.object_id}|${s.idempotency_key}`;

      // Row-level FOR UPDATE lock queue held until transaction finishes
      let lockTail = Promise.resolve();
      const acquiredLockInTx = new WeakSet<object>();

      const acquireForUpdate = async (tx: TransactionContext) => {
        const txObj = tx as unknown as object;
        if (acquiredLockInTx.has(txObj)) return;
        acquiredLockInTx.add(txObj);
        let release!: () => void;
        const next = new Promise<void>((res) => {
          release = res;
        });
        const prev = lockTail;
        lockTail = prev.then(() => next);
        await prev;
        (txObj as { __release?: () => void }).__release = release;
      };

      // Barrier so two concurrent callers both observe findByScope === null before entering tx
      let preCheckCount = 0;
      let releasePreCheckBarrier!: () => void;
      const preCheckBarrier = new Promise<void>((res) => {
        releasePreCheckBarrier = res;
      });

      const txRunner = {
        run: async <T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> => {
          const txObj: { __release?: () => void } = {};
          const tx = txObj as unknown as TransactionContext;
          try {
            return await work(tx);
          } finally {
            txObj.__release?.();
          }
        },
      };

      const quoteRequestRepo = {
        findById: vi.fn(async () => currentRequest),
        lockById: vi.fn(async (_id: string, tx: TransactionContext) => {
          await acquireForUpdate(tx);
          return currentRequest;
        }),
      };

      const recipientRepo = {
        findByRequestAndWorkshop: vi.fn(async () => currentRecipient),
        lockByRequestAndWorkshop: vi.fn(
          async (_reqId: string, _wsId: string, tx: TransactionContext) => {
            await acquireForUpdate(tx);
            return currentRecipient;
          },
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
            if (expectedVersion && currentRecipient.version !== expectedVersion) {
              throw new ConcurrencyConflictError('Version mismatch');
            }
            currentRecipient = recipient;
            if (history) {
              historyRecords.push(history);
            }
            return recipient;
          },
        ),
      };

      const quoteRepo = {
        findById: vi.fn(async () => null),
        lockByRequestAndWorkshop: vi.fn(async () => null),
      };

      const idempotencyRepo = {
        findByScope: vi.fn(async (scope: IdempotencyScopeKey) => {
          preCheckCount++;
          if (preCheckCount <= 2) {
            if (preCheckCount === 2) {
              releasePreCheckBarrier();
            }
            await preCheckBarrier;
          }
          return committedIdempotency.get(makeKey(scope)) ?? null;
        }),
        findAndVerifyReplay: vi.fn(async (input: IdempotencyScopeKey & { request_fingerprint: string }) => {
          const rec = committedIdempotency.get(makeKey(input)) ?? null;
          if (!rec || rec.request_fingerprint !== input.request_fingerprint) {
            return null;
          }
          return rec;
        }),
        save: vi.fn(async (input: CreateIdempotencyRecordInput<unknown>) => {
          const key = makeKey(input);
          if (committedIdempotency.has(key)) {
            const err = new Error('P2002') as Error & { code?: string };
            err.code = 'P2002';
            throw err;
          }
          const rec: PersistedIdempotencyRecord<unknown> = {
            id: String(seq++),
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
          committedIdempotency.set(key, rec);
          return rec;
        }),
        deleteExpiredBefore: vi.fn(async () => 0),
      };

      const workshopContract = new MockWorkshopContract();
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng gốm mẫu Bát Tràng',
        status: 'active',
        isProfilePublic: true,
      });

      const useCase = new DeclineQuoteRequestUseCase(
        txRunner,
        quoteRequestRepo as any,
        recipientRepo as any,
        quoteRepo as any,
        workshopContract,
      );
      const stateResolver = new TradingCurrentStateResolver(
        quoteRequestRepo as any,
        { findById: vi.fn() } as any,
        quoteRepo as any,
        recipientRepo as any,
      );
      const idempotencyService = new TradingIdempotencyService(
        idempotencyRepo as any,
        txRunner,
      );

      return {
        useCase,
        stateResolver,
        idempotencyService,
        historyRecords,
        committedIdempotency,
        getCurrentRecipient: () => currentRecipient,
      };
    }

    it('CC-01: concurrent identical decline requests serialized by FOR UPDATE return 1 initial + 1 replayed=true without duplicate history', async () => {
      const harness = createSerializedForUpdateHarness();
      const payload = {
        expected_recipient_version: 1,
        decline_reason: 'Xưởng đang đầy tải.',
      };

      const runDecline = (p: typeof payload) =>
        harness.idempotencyService.executeWithIdempotency({
          accountId: artisanActor.accountId,
          action: 'decline',
          objectType: 'QuoteRequest',
          objectId: '10001',
          idempotencyKey: VALID_IDEMPOTENCY_KEY_1,
          payload: p,
          now: NOW,
          getCurrentState: (tx) =>
            harness.stateResolver.resolveCurrentState('QuoteRequest', '10001', tx, {
              workshopId: artisanActor.workshopId,
              action: 'decline',
            }),
          execute: async (tx) => {
            const res = await harness.useCase.execute({
              actor: artisanActor,
              requestId: '10001',
              expectedRecipientVersion: p.expected_recipient_version,
              declineReason: p.decline_reason,
              now: NOW,
              tx,
            });
            return { result: res.recipient, currentState: res.currentState };
          },
        });

      const [res1, res2] = await Promise.all([
        runDecline(payload),
        runDecline(payload),
      ]);

      expect(res1.replayed).toBe(false);
      expect(res2.replayed).toBe(true);
      expect(res2.operation.id).toBe(res1.operation.id);
      expect(res2.data).toEqual(res1.data);
      expect(res2.operation.current_state).toEqual({
        request: {
          id: '10001',
          status: 'artisans_bidding',
          version: 3,
          cancelled_at: null,
        },
        recipient: {
          id: '11001',
          status: 'declined',
          version: 2,
        },
      });
      expect(harness.historyRecords).toHaveLength(1);
      expect(harness.committedIdempotency.size).toBe(1);
    });

    it('CC-02: concurrent decline requests with same X-Idempotency-Key but different payloads reject second with 409 IDEMPOTENCY_CONFLICT (not CONCURRENCY_CONFLICT)', async () => {
      const harness = createSerializedForUpdateHarness();

      const runDecline = (reason: string) =>
        harness.idempotencyService.executeWithIdempotency({
          accountId: artisanActor.accountId,
          action: 'decline',
          objectType: 'QuoteRequest',
          objectId: '10001',
          idempotencyKey: VALID_IDEMPOTENCY_KEY_1,
          payload: { expected_recipient_version: 1, decline_reason: reason },
          now: NOW,
          getCurrentState: (tx) =>
            harness.stateResolver.resolveCurrentState('QuoteRequest', '10001', tx, {
              workshopId: artisanActor.workshopId,
              action: 'decline',
            }),
          execute: async (tx) => {
            const res = await harness.useCase.execute({
              actor: artisanActor,
              requestId: '10001',
              expectedRecipientVersion: 1,
              declineReason: reason,
              now: NOW,
              tx,
            });
            return { result: res.recipient, currentState: res.currentState };
          },
        });

      const [settled1, settled2] = await Promise.allSettled([
        runDecline('Bận đơn hàng 1'),
        runDecline('Bận đơn hàng 2'),
      ]);

      expect(settled1.status).toBe('fulfilled');
      expect(settled2.status).toBe('rejected');
      const err = (settled2 as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(IdempotencyConflictError);
      expect(err.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(harness.historyRecords).toHaveLength(1);
    });

    it('CC-03: unrelated request with a DIFFERENT X-Idempotency-Key and stale expected_recipient_version still throws ConcurrencyConflictError (409 CONCURRENCY_CONFLICT)', async () => {
      const harness = createSerializedForUpdateHarness();

      // Pre-satisfy the 2-call barrier inside the harness so single sequential calls don't block
      await Promise.all([
        harness.idempotencyService.executeWithIdempotency({
          accountId: artisanActor.accountId,
          action: 'decline',
          objectType: 'QuoteRequest',
          objectId: '10001',
          idempotencyKey: VALID_IDEMPOTENCY_KEY_1,
          payload: { expected_recipient_version: 1, decline_reason: 'first' },
          now: NOW,
          getCurrentState: (tx) =>
            harness.stateResolver.resolveCurrentState('QuoteRequest', '10001', tx, {
              workshopId: artisanActor.workshopId,
              action: 'decline',
            }),
          execute: async (tx) => {
            const res = await harness.useCase.execute({
              actor: artisanActor,
              requestId: '10001',
              expectedRecipientVersion: 1,
              declineReason: 'first',
              now: NOW,
              tx,
            });
            return { result: res.recipient, currentState: res.currentState };
          },
        }),
        harness.idempotencyService.executeWithIdempotency({
          accountId: artisanActor.accountId,
          action: 'decline',
          objectType: 'QuoteRequest',
          objectId: '10001',
          idempotencyKey: VALID_IDEMPOTENCY_KEY_1,
          payload: { expected_recipient_version: 1, decline_reason: 'first' },
          now: NOW,
          getCurrentState: (tx) =>
            harness.stateResolver.resolveCurrentState('QuoteRequest', '10001', tx, {
              workshopId: artisanActor.workshopId,
              action: 'decline',
            }),
          execute: async (tx) => {
            const res = await harness.useCase.execute({
              actor: artisanActor,
              requestId: '10001',
              expectedRecipientVersion: 1,
              declineReason: 'first',
              now: NOW,
              tx,
            });
            return { result: res.recipient, currentState: res.currentState };
          },
        }),
      ]);

      // New key with stale expected_recipient_version: 1 (DB is now at version 2) -> must throw CONCURRENCY_CONFLICT
      await expect(
        harness.idempotencyService.executeWithIdempotency({
          accountId: artisanActor.accountId,
          action: 'decline',
          objectType: 'QuoteRequest',
          objectId: '10001',
          idempotencyKey: VALID_IDEMPOTENCY_KEY_2,
          payload: { expected_recipient_version: 1, decline_reason: 'stale retry' },
          now: NOW,
          getCurrentState: (tx) =>
            harness.stateResolver.resolveCurrentState('QuoteRequest', '10001', tx, {
              workshopId: artisanActor.workshopId,
              action: 'decline',
            }),
          execute: async (tx) => {
            const res = await harness.useCase.execute({
              actor: artisanActor,
              requestId: '10001',
              expectedRecipientVersion: 1,
              declineReason: 'stale retry',
              now: NOW,
              tx,
            });
            return { result: res.recipient, currentState: res.currentState };
          },
        }),
      ).rejects.toThrow(ConcurrencyConflictError);
    });
  });
});
