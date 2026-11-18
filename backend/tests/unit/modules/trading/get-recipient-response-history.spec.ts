import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
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
import { HttpResult } from '../../../../src/common/http/interceptors/response-envelope.interceptor';
import { IDENTITY_CONTRACT } from '../../../../src/modules/identity/public/contracts/identity.contract';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../../../src/common/application/ports/transaction-runner';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import {
  type IQuoteRequestRepository,
  type IRecipientResponseHistoryRepository,
  type IRequestRecipientRepository,
  QUOTE_REQUEST_REPOSITORY,
  RECIPIENT_RESPONSE_HISTORY_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import type { RecipientEventDto } from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';
import { GetQuoteRequestByIdUseCase } from '../../../../src/modules/trading/application/use-cases/requests/get-quote-request-by-id.use-case';
import { GetRecipientResponseHistoryUseCase } from '../../../../src/modules/trading/application/use-cases/quotations/get-recipient-response-history.use-case';
import { QuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/quote-request.controller';
import { PrismaRecipientResponseHistoryRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/recipient-response-history.repository';
import { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import {
  InvalidTradingInputError,
  QuoteRequest,
  QuoteRequestNotFoundError,
  RequestRecipient,
  TradingDomainError,
  TradingPermissionDeniedError,
  TradingResourceNotFoundError,
  type RecipientResponseStatus,
  type RequestStatus,
} from '../../../../src/modules/trading/domain';

// ---------------------------------------------------------------------------
// Test Actors
// ---------------------------------------------------------------------------
const ownerBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-owner',
  sessionLevel: 'normal',
});

const otherBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '99',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-other',
  sessionLevel: 'normal',
});

const adminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-admin-1',
  sessionLevel: 'normal',
});

const ownerArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '201',
  role: 'artisan',
  workshopId: '301',
  authVersion: 1,
  sessionId: 'session-artisan-owner',
  sessionLevel: 'normal',
});

const competitorArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '202',
  role: 'artisan',
  workshopId: '302',
  authVersion: 1,
  sessionId: 'session-artisan-competitor',
  sessionLevel: 'normal',
});

const artisanWithoutWorkshopActor: AuthenticatedActor = Object.freeze({
  accountId: '203',
  role: 'artisan',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-artisan-no-ws',
  sessionLevel: 'normal',
});

const tempPasswordBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-temp-buyer',
  sessionLevel: 'temp_password',
});

const tempPasswordArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '201',
  role: 'artisan',
  workshopId: '301',
  authVersion: 1,
  sessionId: 'session-temp-artisan',
  sessionLevel: 'temp_password',
});

const tempPasswordAdminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-temp-admin',
  sessionLevel: 'temp_password',
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function createSampleQuoteRequest(
  overrides: Partial<{
    id: string;
    buyer_id: string;
    status: RequestStatus;
    version: number;
    cancelled_at: Date | null;
    cancelled_by: string | null;
    cancel_reason: string | null;
  }> = {},
): QuoteRequest {
  const cancelledAt =
    overrides.cancelled_at !== undefined ? overrides.cancelled_at : null;
  const cancelledBy =
    overrides.cancelled_by !== undefined
      ? overrides.cancelled_by
      : cancelledAt !== null
        ? overrides.buyer_id ?? '10'
        : null;

  return QuoteRequest.reconstitute({
    id: overrides.id ?? '100',
    buyer_id: overrides.buyer_id ?? '10',
    category_id: '1',
    spec: 'Bộ ấm chén men lam cổ Bát Tràng',
    quantity: 50,
    unit: 'set',
    unit_set_description: '1 ấm + 6 chén + 1 đĩa lót',
    status: overrides.status ?? 'artisans_bidding',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội',
    delivery_address: '123 Phố Huế, Hai Bà Trưng, Hà Nội',
    recipient_name: 'Nguyễn Văn A',
    recipient_phone: '0912345678',
    bidding_deadline: new Date('2026-11-15T10:00:00.000Z'),
    delivery_deadline: new Date('2026-11-28T17:00:00.000Z'),
    bidding_closed_at: null,
    version: overrides.version ?? 2,
    cancelled_at: cancelledAt,
    cancelled_by: cancelledBy,
    cancel_reason:
      overrides.cancel_reason !== undefined
        ? overrides.cancel_reason
        : cancelledAt
          ? 'Buyer cancelled request'
          : null,
    created_at: new Date('2026-11-10T07:00:00.000Z'),
    updated_at: new Date('2026-11-10T08:00:00.000Z'),
  });
}

function createSampleRecipient(
  overrides: Partial<{
    id: string;
    request_id: string;
    workshop_id: string;
    response_status: RecipientResponseStatus;
    decline_reason: string | null;
    responded_by: string | null;
    responded_at: Date | null;
    version: number;
  }> = {},
): RequestRecipient {
  return RequestRecipient.reconstitute({
    id: overrides.id ?? '11001',
    request_id: overrides.request_id ?? '100',
    workshop_id: overrides.workshop_id ?? '301',
    response_status: overrides.response_status ?? 'quoted',
    decline_reason: overrides.decline_reason ?? null,
    responded_by: overrides.responded_by ?? '201',
    responded_at:
      overrides.responded_at !== undefined
        ? overrides.responded_at
        : new Date('2026-11-10T08:00:00.000Z'),
    sent_at: new Date('2026-11-10T07:05:00.000Z'),
    version: overrides.version ?? 2,
  });
}

function createAllSixLifecycleEvents(): readonly RecipientEventDto[] {
  return Object.freeze([
    Object.freeze({
      id: '13001',
      event_type: 'declined',
      prev_status: 'pending',
      new_status: 'declined',
      reason: 'Lịch lò đang kín',
      quote_snapshot: null,
      performed_by: Object.freeze({ id: '201', display_name: null }),
      created_at: '2026-11-10T08:00:00.000Z',
    }),
    Object.freeze({
      id: '13002',
      event_type: 'quote_submitted',
      prev_status: 'declined',
      new_status: 'quoted',
      reason: null,
      quote_snapshot: Object.freeze({
        unit_price: 45000,
        max_quantity: 3000,
        bid_accept_deadline: '2026-11-16T17:00:00.000Z',
        committed_delivery_at: '2026-11-28T17:00:00.000Z',
        status: 'active',
        version: 1,
      }),
      performed_by: Object.freeze({ id: '201', display_name: null }),
      created_at: '2026-11-10T09:00:00.000Z',
    }),
    Object.freeze({
      id: '13003',
      event_type: 'quote_updated',
      prev_status: 'quoted',
      new_status: 'quoted',
      reason: null,
      quote_snapshot: Object.freeze({
        unit_price: 42000,
        max_quantity: 3000,
        bid_accept_deadline: '2026-11-16T17:00:00.000Z',
        committed_delivery_at: '2026-11-27T17:00:00.000Z',
        status: 'active',
        version: 2,
      }),
      performed_by: Object.freeze({ id: '201', display_name: null }),
      created_at: '2026-11-10T10:00:00.000Z',
    }),
    Object.freeze({
      id: '13004',
      event_type: 'quote_withdrawn',
      prev_status: 'quoted',
      new_status: 'withdrawn',
      reason: 'Điều chỉnh kế hoạch nguyên liệu đất sét',
      quote_snapshot: Object.freeze({
        unit_price: 42000,
        max_quantity: 3000,
        bid_accept_deadline: '2026-11-16T17:00:00.000Z',
        committed_delivery_at: '2026-11-27T17:00:00.000Z',
        status: 'withdrawn',
        version: 3,
      }),
      performed_by: Object.freeze({ id: '201', display_name: null }),
      created_at: '2026-11-10T11:00:00.000Z',
    }),
    Object.freeze({
      id: '13005',
      event_type: 'quote_resubmitted',
      prev_status: 'withdrawn',
      new_status: 'quoted',
      reason: null,
      quote_snapshot: Object.freeze({
        unit_price: 43000,
        max_quantity: 3000,
        bid_accept_deadline: '2026-11-16T17:00:00.000Z',
        committed_delivery_at: '2026-11-28T17:00:00.000Z',
        status: 'active',
        version: 4,
      }),
      performed_by: Object.freeze({ id: '201', display_name: null }),
      created_at: '2026-11-10T12:00:00.000Z',
    }),
    Object.freeze({
      id: '13006',
      event_type: 'quote_accepted',
      prev_status: 'quoted',
      new_status: 'quoted',
      reason: null,
      quote_snapshot: Object.freeze({
        unit_price: 43000,
        max_quantity: 3000,
        bid_accept_deadline: '2026-11-16T17:00:00.000Z',
        committed_delivery_at: '2026-11-28T17:00:00.000Z',
        status: 'accepted',
        version: 5,
      }),
      performed_by: Object.freeze({
        id: '10',
        display_name: 'Buyer Nguyễn Văn A',
      }),
      created_at: '2026-11-10T13:00:00.000Z',
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
describe('GET /api/v1/quote-requests/:id/recipients/:recipientId/history (Task 22, UC-16, BR-15, SEC-06)', () => {
  const identityMock = new MockIdentityContract();
  const txRunner = new MockTransactionRunner();

  const mockQuoteRequestRepo = {
    findById: vi.fn(),
    findDetailById: vi.fn(),
  };

  const mockRecipientRepo = {
    findById: vi.fn(),
    findByRequestAndWorkshop: vi.fn(),
  };

  const mockRecipientHistoryRepo = {
    findEventsWithPagination: vi.fn(),
  };

  let useCase: GetRecipientResponseHistoryUseCase;
  let app: NestExpressApplication;
  let base: string;

  class TestIdentityModule {}
  Module({
    providers: [{ provide: IDENTITY_CONTRACT, useValue: identityMock }],
    exports: [IDENTITY_CONTRACT],
  })(TestIdentityModule);

  class TestAppModule {}
  Module({
    imports: [AppConfigModule, SecurityModule.register([TestIdentityModule])],
    controllers: [QuoteRequestController],
    providers: [
      { provide: TRANSACTION_RUNNER, useValue: txRunner },
      { provide: QUOTE_REQUEST_REPOSITORY, useValue: mockQuoteRequestRepo },
      { provide: REQUEST_RECIPIENT_REPOSITORY, useValue: mockRecipientRepo },
      {
        provide: RECIPIENT_RESPONSE_HISTORY_REPOSITORY,
        useValue: mockRecipientHistoryRepo,
      },
      {
        provide: GetQuoteRequestByIdUseCase,
        useFactory: (runner: TransactionRunner, repo: IQuoteRequestRepository) =>
          new GetQuoteRequestByIdUseCase(runner, repo),
        inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
      },
      {
        provide: GetRecipientResponseHistoryUseCase,
        useFactory: (
          runner: TransactionRunner,
          qrRepo: IQuoteRequestRepository,
          rRepo: IRequestRecipientRepository,
          hRepo: IRecipientResponseHistoryRepository,
        ) =>
          new GetRecipientResponseHistoryUseCase(runner, qrRepo, rRepo, hRepo),
        inject: [
          TRANSACTION_RUNNER,
          QUOTE_REQUEST_REPOSITORY,
          REQUEST_RECIPIENT_REPOSITORY,
          RECIPIENT_RESPONSE_HISTORY_REPOSITORY,
        ],
      },
    ],
  })(TestAppModule);

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/test');
    vi.stubEnv(
      'SESSION_SECRET',
      'test_secret_32_chars_for_development_purposes',
    );
    vi.stubEnv('NODE_ENV', 'development');

    useCase = new GetRecipientResponseHistoryUseCase(
      txRunner,
      mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
      mockRecipientRepo as unknown as IRequestRecipientRepository,
      mockRecipientHistoryRepo as unknown as IRecipientResponseHistoryRepository,
    );

    app = await NestFactory.create<NestExpressApplication>(TestAppModule, {
      bodyParser: false,
      logger: false,
      abortOnError: false,
    });
    configureHttp(app, new AppLogger('error', (_line, done) => done()));
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()) + '/api/v1';
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    identityMock.resolveSession.mockImplementation(async (token: string) => {
      if (token === 'session-buyer-owner') return ownerBuyerActor;
      if (token === 'session-buyer-other') return otherBuyerActor;
      if (token === 'session-admin-1') return adminActor;
      if (token === 'session-artisan-owner') return ownerArtisanActor;
      if (token === 'session-artisan-competitor') return competitorArtisanActor;
      if (token === 'session-artisan-no-ws')
        return artisanWithoutWorkshopActor;
      if (token === 'session-temp-buyer') return tempPasswordBuyerActor;
      if (token === 'session-temp-artisan') return tempPasswordArtisanActor;
      if (token === 'session-temp-admin') return tempPasswordAdminActor;
      return null;
    });
  });

  // =========================================================================
  // Suite A: Use-Case Unit Tests
  // =========================================================================
  describe('Suite A: GetRecipientResponseHistoryUseCase Unit Tests', () => {
    it('allows owning Buyer to retrieve all 6 recipient event types with default pagination', async () => {
      const request = createSampleQuoteRequest();
      const recipient = createSampleRecipient();
      const events = createAllSixLifecycleEvents();

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findById.mockResolvedValueOnce(recipient);
      mockRecipientHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const result = await useCase.execute({
        actor: ownerBuyerActor,
        requestId: '100',
        recipientId: '11001',
      });

      expect(result).toBeInstanceOf(HttpResult);
      expect(mockQuoteRequestRepo.findById).toHaveBeenCalledWith(
        '100',
        expect.anything(),
      );
      expect(mockRecipientRepo.findById).toHaveBeenCalledWith(
        '11001',
        expect.anything(),
      );
      expect(
        mockRecipientHistoryRepo.findEventsWithPagination,
      ).toHaveBeenCalledWith(
        { recipientId: '11001', page: 1, limit: 20 },
        expect.anything(),
      );

      expect(result.data).toHaveLength(6);
      expect(result.metadata.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 6,
        total_pages: 1,
      });
      expect(result.data.map((e) => e.event_type)).toEqual([
        'declined',
        'quote_submitted',
        'quote_updated',
        'quote_withdrawn',
        'quote_resubmitted',
        'quote_accepted',
      ]);
      expect(result.data[0].quote_snapshot).toBeNull();
      expect(result.data[0].performed_by).toEqual({
        id: '201',
        display_name: null,
      });
      expect(result.data[3].reason).toBe(
        'Điều chỉnh kế hoạch nguyên liệu đất sét',
      );
      expect(result.data[5].performed_by).toEqual({
        id: '10',
        display_name: 'Buyer Nguyễn Văn A',
      });
      expect(Object.keys(result.data[1]).sort()).toEqual([
        'created_at',
        'event_type',
        'id',
        'new_status',
        'performed_by',
        'prev_status',
        'quote_snapshot',
        'reason',
      ]);
    });

    it('allows Admin to retrieve history for any valid matching (:id, :recipientId) pair', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(
        createSampleQuoteRequest({ buyer_id: '99' }),
      );
      mockRecipientRepo.findById.mockResolvedValueOnce(
        createSampleRecipient({ workshop_id: '302' }),
      );
      mockRecipientHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [createAllSixLifecycleEvents()[0]],
        totalRecords: 1,
      });

      const result = await useCase.execute({
        actor: adminActor,
        requestId: '100',
        recipientId: '11001',
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].event_type).toBe('declined');
    });

    it('allows owning Artisan (workshopId matches recipient.workshop_id) to retrieve own recipient history', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(
        createSampleQuoteRequest(),
      );
      mockRecipientRepo.findById.mockResolvedValueOnce(
        createSampleRecipient({ workshop_id: '301' }),
      );
      mockRecipientHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [createAllSixLifecycleEvents()[1]],
        totalRecords: 1,
      });

      const result = await useCase.execute({
        actor: ownerArtisanActor,
        requestId: '100',
        recipientId: '11001',
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].event_type).toBe('quote_submitted');
    });

    it('retains history read access when QuoteRequest is cancelled or delivered (BR-04, BR-21, BR-22, UC-18)', async () => {
      for (const requestOverride of [
        {
          status: 'artisans_bidding' as RequestStatus,
          cancelled_at: new Date('2026-11-12T10:00:00.000Z'),
          cancel_reason: 'Cancelled by buyer',
        },
        {
          status: 'delivered' as RequestStatus,
          cancelled_at: null,
        },
      ]) {
        mockQuoteRequestRepo.findById.mockResolvedValueOnce(
          createSampleQuoteRequest(requestOverride),
        );
        mockRecipientRepo.findById.mockResolvedValueOnce(
          createSampleRecipient({ workshop_id: '301' }),
        );
        mockRecipientHistoryRepo.findEventsWithPagination.mockResolvedValueOnce(
          {
            rows: [createAllSixLifecycleEvents()[1]],
            totalRecords: 1,
          },
        );

        const res = await useCase.execute({
          actor: ownerArtisanActor,
          requestId: '100',
          recipientId: '11001',
        });

        expect(res.data).toHaveLength(1);
      }
    });

    it('rejects non-owning Buyer with 404 QuoteRequestNotFoundError (SEC-06 Anti-IDOR) without loading recipient/history', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(
        createSampleQuoteRequest({ buyer_id: '10' }),
      );

      await expect(
        useCase.execute({
          actor: otherBuyerActor,
          requestId: '100',
          recipientId: '11001',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(mockRecipientRepo.findById).not.toHaveBeenCalled();
      expect(
        mockRecipientHistoryRepo.findEventsWithPagination,
      ).not.toHaveBeenCalled();
    });

    it('rejects non-owning Artisan (competitor workshop on same request) with 404 TradingResourceNotFoundError (SEC-06 Anti-IDOR)', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(
        createSampleQuoteRequest(),
      );
      mockRecipientRepo.findById.mockResolvedValueOnce(
        createSampleRecipient({ workshop_id: '301' }),
      );

      await expect(
        useCase.execute({
          actor: competitorArtisanActor,
          requestId: '100',
          recipientId: '11001',
        }),
      ).rejects.toThrow(TradingResourceNotFoundError);

      expect(
        mockRecipientHistoryRepo.findEventsWithPagination,
      ).not.toHaveBeenCalled();
    });

    it('rejects mismatched (:id, :recipientId) pair with 404 TradingResourceNotFoundError even for Admin and owning Buyer', async () => {
      for (const actor of [adminActor, ownerBuyerActor, ownerArtisanActor]) {
        mockQuoteRequestRepo.findById.mockResolvedValueOnce(
          createSampleQuoteRequest({ id: '100' }),
        );
        // Recipient belongs to request 999, NOT 100
        mockRecipientRepo.findById.mockResolvedValueOnce(
          createSampleRecipient({
            id: '11001',
            request_id: '999',
            workshop_id: '301',
          }),
        );

        await expect(
          useCase.execute({
            actor,
            requestId: '100',
            recipientId: '11001',
          }),
        ).rejects.toThrow(TradingResourceNotFoundError);
      }

      expect(
        mockRecipientHistoryRepo.findEventsWithPagination,
      ).not.toHaveBeenCalled();
    });

    it('rejects missing QuoteRequest or missing RequestRecipient with 404 RESOURCE_NOT_FOUND', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(null);
      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '999999',
          recipientId: '11001',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(
        createSampleQuoteRequest(),
      );
      mockRecipientRepo.findById.mockResolvedValueOnce(null);
      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '100',
          recipientId: '999999',
        }),
      ).rejects.toThrow(TradingResourceNotFoundError);
    });

    it('rejects Artisan without workshopId and unsupported roles with 403 TradingPermissionDeniedError', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(
        createSampleQuoteRequest(),
      );
      await expect(
        useCase.execute({
          actor: artisanWithoutWorkshopActor,
          requestId: '100',
          recipientId: '11001',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(
        createSampleQuoteRequest(),
      );
      await expect(
        useCase.execute({
          actor: { ...ownerBuyerActor, role: 'unknown_role' as never },
          requestId: '100',
          recipientId: '11001',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(mockRecipientRepo.findById).not.toHaveBeenCalled();
    });

    it('rejects temp_password sessions for all roles with TEMP_PASSWORD_RESTRICTED before DB queries', async () => {
      for (const tempActor of [
        tempPasswordBuyerActor,
        tempPasswordArtisanActor,
        tempPasswordAdminActor,
      ]) {
        await expect(
          useCase.execute({
            actor: tempActor,
            requestId: '100',
            recipientId: '11001',
          }),
        ).rejects.toThrow(TradingDomainError);

        try {
          await useCase.execute({
            actor: tempActor,
            requestId: '100',
            recipientId: '11001',
          });
        } catch (error) {
          expect((error as TradingDomainError).code).toBe(
            'TEMP_PASSWORD_RESTRICTED',
          );
        }
      }

      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('rejects malformed :id, :recipientId, and out-of-range page/limit with InvalidTradingInputError', async () => {
      for (const badId of ['abc', '0', '-5', '9223372036854775808']) {
        await expect(
          useCase.execute({
            actor: ownerBuyerActor,
            requestId: badId,
            recipientId: '11001',
          }),
        ).rejects.toThrow(InvalidTradingInputError);

        await expect(
          useCase.execute({
            actor: ownerBuyerActor,
            requestId: '100',
            recipientId: badId,
          }),
        ).rejects.toThrow(InvalidTradingInputError);
      }

      for (const badQuery of [
        { page: 0, limit: 20 },
        { page: -1, limit: 20 },
        { page: 1.5, limit: 20 },
        { page: 1, limit: 0 },
        { page: 1, limit: 101 },
      ]) {
        await expect(
          useCase.execute({
            actor: ownerBuyerActor,
            requestId: '100',
            recipientId: '11001',
            query: badQuery,
          }),
        ).rejects.toThrow(InvalidTradingInputError);
      }

      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('handles empty history (total_pages: 0) and beyond-last-page requests without clamping', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(
        createSampleQuoteRequest(),
      );
      mockRecipientRepo.findById.mockResolvedValueOnce(
        createSampleRecipient({ response_status: 'pending' }),
      );
      mockRecipientHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const emptyRes = await useCase.execute({
        actor: ownerBuyerActor,
        requestId: '100',
        recipientId: '11001',
      });
      expect(emptyRes.data).toEqual([]);
      expect(emptyRes.metadata.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 0,
        total_pages: 0,
      });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(
        createSampleQuoteRequest(),
      );
      mockRecipientRepo.findById.mockResolvedValueOnce(
        createSampleRecipient(),
      );
      mockRecipientHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 12,
      });

      const beyondRes = await useCase.execute({
        actor: ownerBuyerActor,
        requestId: '100',
        recipientId: '11001',
        query: { page: 5, limit: 10 },
      });
      expect(beyondRes.data).toEqual([]);
      expect(beyondRes.metadata.pagination).toEqual({
        page: 5,
        limit: 10,
        total_records: 12,
        total_pages: 2,
      });
    });
  });

  // =========================================================================
  // Suite B: HTTP Pipeline, Security, Pagination & OpenAPI Integration Tests
  // =========================================================================
  describe('Suite B: HTTP Pipeline, Pagination & OpenAPI Integration Tests', () => {
    it('returns 200 OK with Cache-Control: no-store and paginated RecipientEventDto envelope for Buyer owner, Admin, and owning Artisan', async () => {
      const events = createAllSixLifecycleEvents();

      for (const cookieToken of [
        'session-buyer-owner',
        'session-admin-1',
        'session-artisan-owner',
      ]) {
        mockQuoteRequestRepo.findById.mockResolvedValueOnce(
          createSampleQuoteRequest(),
        );
        mockRecipientRepo.findById.mockResolvedValueOnce(
          createSampleRecipient({ workshop_id: '301' }),
        );
        mockRecipientHistoryRepo.findEventsWithPagination.mockResolvedValueOnce(
          {
            rows: events.slice(0, 2),
            totalRecords: 6,
          },
        );

        const res = await fetch(
          `${base}/quote-requests/100/recipients/11001/history?page=1&limit=2`,
          {
            headers: { cookie: `vcraft-session=${cookieToken}` },
          },
        );

        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        const json = await res.json();
        expect(json).toEqual({
          success: true,
          data: events.slice(0, 2),
          pagination: {
            page: 1,
            limit: 2,
            total_records: 6,
            total_pages: 3,
          },
        });
      }
    });

    it('defaults pagination to page=1 and limit=20 when query params are omitted and supports limit=100', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(
        createSampleQuoteRequest(),
      );
      mockRecipientRepo.findById.mockResolvedValueOnce(createSampleRecipient());
      mockRecipientHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const defaultRes = await fetch(
        `${base}/quote-requests/100/recipients/11001/history`,
        {
          headers: { cookie: 'vcraft-session=session-artisan-owner' },
        },
      );
      expect(defaultRes.status).toBe(200);
      expect(
        mockRecipientHistoryRepo.findEventsWithPagination,
      ).toHaveBeenCalledWith(
        { recipientId: '11001', page: 1, limit: 20 },
        expect.anything(),
      );
      expect((await defaultRes.json()).pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 0,
        total_pages: 0,
      });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(
        createSampleQuoteRequest(),
      );
      mockRecipientRepo.findById.mockResolvedValueOnce(createSampleRecipient());
      mockRecipientHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const maxLimitRes = await fetch(
        `${base}/quote-requests/100/recipients/11001/history?limit=100`,
        {
          headers: { cookie: 'vcraft-session=session-artisan-owner' },
        },
      );
      expect(maxLimitRes.status).toBe(200);
      expect(
        mockRecipientHistoryRepo.findEventsWithPagination,
      ).toHaveBeenLastCalledWith(
        { recipientId: '11001', page: 1, limit: 100 },
        expect.anything(),
      );
    });

    it('enforces 401 AUTHENTICATION_REQUIRED and 403 TEMP_PASSWORD_RESTRICTED / PERMISSION_DENIED', async () => {
      const unauth = await fetch(
        `${base}/quote-requests/100/recipients/11001/history`,
      );
      expect(unauth.status).toBe(401);
      expect((await unauth.json()).code).toBe('AUTHENTICATION_REQUIRED');

      const invalidCookie = await fetch(
        `${base}/quote-requests/100/recipients/11001/history`,
        { headers: { cookie: 'vcraft-session=bad-token' } },
      );
      expect(invalidCookie.status).toBe(401);

      const tempSession = await fetch(
        `${base}/quote-requests/100/recipients/11001/history`,
        { headers: { cookie: 'vcraft-session=session-temp-artisan' } },
      );
      expect(tempSession.status).toBe(403);
      expect((await tempSession.json()).code).toBe('TEMP_PASSWORD_RESTRICTED');

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(
        createSampleQuoteRequest(),
      );
      const noWs = await fetch(
        `${base}/quote-requests/100/recipients/11001/history`,
        { headers: { cookie: 'vcraft-session=session-artisan-no-ws' } },
      );
      expect(noWs.status).toBe(403);
      expect((await noWs.json()).code).toBe('PERMISSION_DENIED');
    });

    it('enforces 404 RESOURCE_NOT_FOUND anti-IDOR for non-owner Buyer, competitor Artisan, missing resources, and mismatched (:id, :recipientId)', async () => {
      // Non-owner Buyer
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(
        createSampleQuoteRequest({ buyer_id: '10' }),
      );
      const otherBuyerRes = await fetch(
        `${base}/quote-requests/100/recipients/11001/history`,
        { headers: { cookie: 'vcraft-session=session-buyer-other' } },
      );
      expect(otherBuyerRes.status).toBe(404);
      expect((await otherBuyerRes.json()).code).toBe('RESOURCE_NOT_FOUND');

      // Competitor Artisan on same request
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(
        createSampleQuoteRequest(),
      );
      mockRecipientRepo.findById.mockResolvedValueOnce(
        createSampleRecipient({ workshop_id: '301' }),
      );
      const competitorRes = await fetch(
        `${base}/quote-requests/100/recipients/11001/history`,
        { headers: { cookie: 'vcraft-session=session-artisan-competitor' } },
      );
      expect(competitorRes.status).toBe(404);
      expect((await competitorRes.json()).code).toBe('RESOURCE_NOT_FOUND');

      // Mismatched (:id, :recipientId) even for Admin
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(
        createSampleQuoteRequest({ id: '100' }),
      );
      mockRecipientRepo.findById.mockResolvedValueOnce(
        createSampleRecipient({ id: '11001', request_id: '200' }),
      );
      const mismatchRes = await fetch(
        `${base}/quote-requests/100/recipients/11001/history`,
        { headers: { cookie: 'vcraft-session=session-admin-1' } },
      );
      expect(mismatchRes.status).toBe(404);
      expect((await mismatchRes.json()).code).toBe('RESOURCE_NOT_FOUND');
    });

    it('rejects malformed path IDs, invalid pagination values, and unknown query params with 400 INVALID_INPUT', async () => {
      const invalidRequests = [
        `${base}/quote-requests/abc/recipients/11001/history`,
        `${base}/quote-requests/100/recipients/0/history`,
        `${base}/quote-requests/100/recipients/11001/history?page=0`,
        `${base}/quote-requests/100/recipients/11001/history?page=-1`,
        `${base}/quote-requests/100/recipients/11001/history?page=abc`,
        `${base}/quote-requests/100/recipients/11001/history?limit=0`,
        `${base}/quote-requests/100/recipients/11001/history?limit=101`,
        `${base}/quote-requests/100/recipients/11001/history?unexpected=1`,
      ];

      for (const url of invalidRequests) {
        const res = await fetch(url, {
          headers: { cookie: 'vcraft-session=session-admin-1' },
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.code).toBe('INVALID_INPUT');
      }
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('registers valid OpenAPI 3.0.0 Swagger metadata for /api/v1/quote-requests/{id}/recipients/{recipientId}/history', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const route =
        doc.paths['/api/v1/quote-requests/{id}/recipients/{recipientId}/history']
          ?.get;

      expect(route).toBeDefined();
      expect(route?.security).toEqual([{ session: [] }]);
      expect(route).toHaveProperty('x-roles', ['buyer', 'artisan', 'admin']);
      expect(route?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'id', in: 'path', required: true }),
          expect.objectContaining({
            name: 'recipientId',
            in: 'path',
            required: true,
          }),
          expect.objectContaining({
            name: 'page',
            in: 'query',
            required: false,
          }),
          expect.objectContaining({
            name: 'limit',
            in: 'query',
            required: false,
          }),
        ]),
      );
      expect(route?.responses['200']).toMatchObject({
        content: {
          'application/json': {
            schema: {
              properties: {
                success: { enum: [true] },
                data: {
                  type: 'array',
                  items: {
                    additionalProperties: false,
                    required: [
                      'id',
                      'event_type',
                      'prev_status',
                      'new_status',
                      'reason',
                      'quote_snapshot',
                      'performed_by',
                      'created_at',
                    ],
                  },
                },
                pagination: { $ref: '#/components/schemas/Pagination' },
              },
            },
          },
        },
      });
      expect(route?.responses['400']).toBeDefined();
      expect(route?.responses['401']).toBeDefined();
      expect(route?.responses['403']).toBeDefined();
      expect(route?.responses['404']).toBeDefined();
      expect(route?.responses['429']).toBeDefined();
      expect(route?.responses['500']).toBeDefined();
    });
  });

  // =========================================================================
  // Suite C: PrismaRecipientResponseHistoryRepository Pagination Unit Tests
  // =========================================================================
  describe('Suite C: PrismaRecipientResponseHistoryRepository.findEventsWithPagination', () => {
    it('executes count + chronological findMany with actor select and enforces 6-field quote_snapshot allowlist across all event types', async () => {
      const mockRows = [
        {
          id: 1n,
          recipient_id: 11001n,
          quote_id: null,
          event_type: 'declined',
          prev_status: 'pending',
          new_status: 'declined',
          reason: null,
          quote_snapshot: null,
          performed_by: 201n,
          created_at: new Date('2026-11-10T08:00:00.000Z'),
          performedBy: { id: 201n, display_name: null },
        },
        {
          id: 2n,
          recipient_id: 11001n,
          quote_id: 800n,
          event_type: 'quote_accepted',
          prev_status: 'quoted',
          new_status: 'quoted',
          reason: null,
          quote_snapshot: {
            unit_price: 45000,
            max_quantity: 3000,
            bid_accept_deadline: '2026-11-16T17:00:00.000Z',
            committed_delivery_at: '2026-11-28T17:00:00.000Z',
            status: 'accepted',
            version: 2,
            leaked_key: 'should-not-appear',
          },
          performed_by: 10n,
          created_at: new Date('2026-11-10T09:00:00.000Z'),
          performedBy: { id: 10n, display_name: 'Buyer Nguyễn Văn A' },
        },
      ];

      const mockPrismaClient = {
        recipientResponseHistory: {
          count: vi.fn().mockResolvedValue(2),
          findMany: vi.fn().mockResolvedValue(mockRows),
        },
      };

      const mockPrismaTxRunner = {
        getClient: vi.fn().mockReturnValue(mockPrismaClient),
        run: vi.fn().mockImplementation(async (cb: (tx: unknown) => unknown) =>
          cb({}),
        ),
      } as unknown as PrismaTransactionRunner;

      const repo = new PrismaRecipientResponseHistoryRepository(
        mockPrismaTxRunner,
      );

      const res = await repo.findEventsWithPagination({
        recipientId: '11001',
        page: 1,
        limit: 20,
      });

      expect(res.totalRecords).toBe(2);
      expect(res.rows).toHaveLength(2);
      expect(mockPrismaClient.recipientResponseHistory.findMany).toHaveBeenCalledWith(
        {
          where: { recipient_id: 11001n },
          include: {
            performedBy: {
              select: {
                id: true,
                display_name: true,
              },
            },
          },
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
          skip: 0,
          take: 20,
        },
      );
      expect(res.rows[0].quote_snapshot).toBeNull();
      expect(res.rows[0].performed_by).toEqual({
        id: '201',
        display_name: null,
      });
      expect(res.rows[1].quote_snapshot).toEqual({
        unit_price: 45000,
        max_quantity: 3000,
        bid_accept_deadline: '2026-11-16T17:00:00.000Z',
        committed_delivery_at: '2026-11-28T17:00:00.000Z',
        status: 'accepted',
        version: 2,
      });
      expect('leaked_key' in (res.rows[1].quote_snapshot as object)).toBe(false);
    });
  });
});
