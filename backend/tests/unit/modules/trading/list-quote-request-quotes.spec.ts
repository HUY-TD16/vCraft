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
import { Prisma } from '../../../../src/generated/prisma/client';
import { configureHttp } from '../../../../src/bootstrap/configure-http';
import { AppLogger } from '../../../../src/common/observability/app-logger';
import { AppConfigModule } from '../../../../src/common/config/app-config';
import { SecurityModule } from '../../../../src/common/security/security.module';
import { createApiDocument } from '../../../../src/common/http/swagger/configure-swagger';
import { IDENTITY_CONTRACT } from '../../../../src/modules/identity/public/contracts/identity.contract';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../../../src/common/application/ports/transaction-runner';
import type { PrismaService } from '../../../../src/infrastructure/database/prisma/prisma.service';
import { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import {
  IQuoteRepository,
  IQuoteRequestRepository,
  IRequestRecipientRepository,
  QUOTE_REPOSITORY,
  QUOTE_REQUEST_REPOSITORY,
  QuoteDetailItem,
  REQUEST_RECIPIENT_REPOSITORY,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { PrismaQuoteRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/quote.repository';
import { GetQuoteRequestByIdUseCase } from '../../../../src/modules/trading/application/use-cases/requests/get-quote-request-by-id.use-case';
import { ListQuoteRequestQuotesUseCase } from '../../../../src/modules/trading/application/use-cases/quotations/list-quote-request-quotes.use-case';
import { QuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/quote-request.controller';
import {
  InvalidTradingInputError,
  Quote,
  QuoteRequest,
  QuoteRequestNotFoundError,
  type QuoteStatus,
  RequestRecipient,
  type RequestStatus,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import type { QuoteDto } from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';
import { HttpResult } from '../../../../src/common/http/interceptors/response-envelope.interceptor';

// ---------------------------------------------------------------------------
// Test Actors
// ---------------------------------------------------------------------------
const buyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-1',
  sessionLevel: 'normal',
});

const otherBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '99',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-other-buyer',
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

const invitedArtisan1Actor: AuthenticatedActor = Object.freeze({
  accountId: '21',
  role: 'artisan',
  workshopId: '201',
  authVersion: 1,
  sessionId: 'session-artisan-201',
  sessionLevel: 'normal',
});

const invitedArtisan2Actor: AuthenticatedActor = Object.freeze({
  accountId: '22',
  role: 'artisan',
  workshopId: '202',
  authVersion: 1,
  sessionId: 'session-artisan-202',
  sessionLevel: 'normal',
});

const uninvitedArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '29',
  role: 'artisan',
  workshopId: '299',
  authVersion: 1,
  sessionId: 'session-artisan-uninvited',
  sessionLevel: 'normal',
});

const artisanWithoutWorkshopActor: AuthenticatedActor = Object.freeze({
  accountId: '30',
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
  accountId: '21',
  role: 'artisan',
  workshopId: '201',
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
// Fixtures & Helpers
// ---------------------------------------------------------------------------
function createSampleQuoteRequest(
  overrides: Partial<{
    id: string;
    buyer_id: string;
    status: RequestStatus;
    bidding_deadline: Date | null;
    delivery_deadline: Date | null;
    bidding_closed_at: Date | null;
    cancelled_at: Date | null;
    cancelled_by: string | null;
    cancel_reason: string | null;
    version: number;
  }> = {},
): QuoteRequest {
  const nowMs = Date.now();
  const cancelledAt = overrides.cancelled_at ?? null;
  const cancelledBy =
    overrides.cancelled_by !== undefined
      ? overrides.cancelled_by
      : cancelledAt !== null
        ? (overrides.buyer_id ?? '10')
        : null;

  return QuoteRequest.reconstitute({
    id: overrides.id ?? '100',
    buyer_id: overrides.buyer_id ?? '10',
    category_id: '1',
    spec: 'Bộ ấm chén men lam cổ Bát Tràng',
    quantity: 100,
    unit: 'set',
    unit_set_description: '1 ấm + 6 chén + 1 đĩa lót',
    status: overrides.status ?? 'artisans_bidding',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội',
    delivery_address: '123 Phố Huế, Hai Bà Trưng, Hà Nội',
    recipient_name: 'Nguyễn Văn A',
    recipient_phone: '0912345678',
    bidding_deadline:
      overrides.bidding_deadline !== undefined
        ? overrides.bidding_deadline
        : new Date(nowMs + 86_400_000 * 2),
    delivery_deadline:
      overrides.delivery_deadline !== undefined
        ? overrides.delivery_deadline
        : new Date(nowMs + 86_400_000 * 14),
    bidding_closed_at: overrides.bidding_closed_at ?? null,
    version: overrides.version ?? 2,
    cancelled_at: cancelledAt,
    cancelled_by: cancelledBy,
    cancel_reason:
      overrides.cancel_reason ??
      (cancelledAt !== null ? 'Buyer thay đổi kế hoạch' : null),
    created_at: new Date('2026-11-10T08:00:00.000Z'),
    updated_at: new Date('2026-11-10T09:00:00.000Z'),
  });
}

function createSampleRecipient(
  workshopId: string,
  responseStatus: 'pending' | 'declined' | 'quoted' | 'withdrawn' = 'quoted',
): RequestRecipient {
  return RequestRecipient.reconstitute({
    id: `90${workshopId}`,
    request_id: '100',
    workshop_id: workshopId,
    response_status: responseStatus,
    decline_reason:
      responseStatus === 'declined' ? 'Xưởng đang quá tải lò nung' : null,
    responded_by: responseStatus === 'pending' ? null : '21',
    responded_at:
      responseStatus === 'pending'
        ? null
        : new Date('2026-11-10T10:00:00.000Z'),
    sent_at: new Date('2026-11-10T08:05:00.000Z'),
    version: responseStatus === 'pending' ? 1 : 2,
  });
}

function createQuoteDetailItem(
  overrides: Partial<{
    id: string;
    request_id: string;
    workshop_id: string;
    workshop_name: string;
    workshop_status: 'active' | 'suspended';
    unit_price: number;
    max_quantity: number;
    bid_accept_deadline: Date;
    committed_delivery_at: Date;
    status: QuoteStatus;
    version: number;
    withdraw_reason: string | null;
    withdrawn_by: string | null;
    withdrawn_at: Date | null;
  }> = {},
): QuoteDetailItem {
  const nowMs = Date.now();
  const status: QuoteStatus = overrides.status ?? 'active';
  const workshopId = overrides.workshop_id ?? '201';
  const withdrawnAt =
    overrides.withdrawn_at !== undefined
      ? overrides.withdrawn_at
      : status === 'withdrawn'
        ? new Date('2026-11-11T11:00:00.000Z')
        : null;

  return {
    entity: Quote.reconstitute({
      id: overrides.id ?? '401',
      request_id: overrides.request_id ?? '100',
      workshop_id: workshopId,
      unit_price: overrides.unit_price ?? 450000,
      max_quantity: overrides.max_quantity ?? 120,
      bid_accept_deadline:
        overrides.bid_accept_deadline ?? new Date(nowMs + 86_400_000 * 4),
      committed_delivery_at:
        overrides.committed_delivery_at ?? new Date(nowMs + 86_400_000 * 10),
      status,
      version: overrides.version ?? 1,
      withdraw_reason:
        overrides.withdraw_reason !== undefined
          ? overrides.withdraw_reason
          : status === 'withdrawn'
            ? 'Điều chỉnh năng lực lò'
            : null,
      withdrawn_by:
        overrides.withdrawn_by !== undefined
          ? overrides.withdrawn_by
          : status === 'withdrawn'
            ? '21'
            : null,
      withdrawn_at: withdrawnAt,
      created_at: new Date('2026-11-10T10:00:00.000Z'),
      updated_at: new Date('2026-11-10T10:00:00.000Z'),
    }),
    workshop: {
      id: workshopId,
      name: overrides.workshop_name ?? `Xưởng Gốm ${workshopId}`,
      status: overrides.workshop_status ?? 'active',
    },
  };
}

function createSampleQuotes(): readonly QuoteDetailItem[] {
  return [
    createQuoteDetailItem({
      id: '401',
      workshop_id: '201',
      workshop_name: 'Xưởng Gốm Minh Long Bát Tràng',
      workshop_status: 'active',
      unit_price: 450000,
      max_quantity: 120,
      status: 'active',
    }),
    createQuoteDetailItem({
      id: '402',
      workshop_id: '202',
      workshop_name: 'Xưởng Đối Thủ Hai',
      workshop_status: 'active',
      unit_price: 420000,
      max_quantity: 100,
      status: 'active',
    }),
    createQuoteDetailItem({
      id: '403',
      workshop_id: '203',
      workshop_name: 'Xưởng Đối Thủ Tạm Ngừng',
      workshop_status: 'suspended',
      unit_price: 390000,
      max_quantity: 100,
      status: 'active',
    }),
  ];
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
describe('GET /api/v1/quote-requests/:id/quotes (Task 21: UC-18, BR-04, BR-14, BR-15, SEC-06, SEC-12)', () => {
  const identityMock = new MockIdentityContract();
  const txRunner = new MockTransactionRunner();

  const mockQuoteRequestRepo = {
    findById: vi.fn(),
    findDetailById: vi.fn(),
  };

  const mockRecipientRepo = {
    findByRequestAndWorkshop: vi.fn(),
  };

  const mockQuoteRepo = {
    findQuotesWithDetails: vi.fn(),
  };

  let useCase: ListQuoteRequestQuotesUseCase;
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
      { provide: QUOTE_REPOSITORY, useValue: mockQuoteRepo },
      {
        provide: GetQuoteRequestByIdUseCase,
        useFactory: (
          tr: TransactionRunner,
          qrRepo: IQuoteRequestRepository,
        ) => new GetQuoteRequestByIdUseCase(tr, qrRepo),
        inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
      },
      {
        provide: ListQuoteRequestQuotesUseCase,
        useFactory: (
          tr: TransactionRunner,
          qrRepo: IQuoteRequestRepository,
          rRepo: IRequestRecipientRepository,
          qRepo: IQuoteRepository,
        ) => new ListQuoteRequestQuotesUseCase(tr, qrRepo, rRepo, qRepo),
        inject: [
          TRANSACTION_RUNNER,
          QUOTE_REQUEST_REPOSITORY,
          REQUEST_RECIPIENT_REPOSITORY,
          QUOTE_REPOSITORY,
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

    useCase = new ListQuoteRequestQuotesUseCase(
      txRunner,
      mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
      mockRecipientRepo as unknown as IRequestRecipientRepository,
      mockQuoteRepo as unknown as IQuoteRepository,
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
      if (token === 'session-buyer-1') return buyerActor;
      if (token === 'session-other-buyer') return otherBuyerActor;
      if (token === 'session-admin-1') return adminActor;
      if (token === 'session-artisan-201') return invitedArtisan1Actor;
      if (token === 'session-artisan-202') return invitedArtisan2Actor;
      if (token === 'session-artisan-uninvited') return uninvitedArtisanActor;
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
  describe('Suite A: ListQuoteRequestQuotesUseCase Unit Tests', () => {
    it('allows owner Buyer to retrieve all quotes with accurate pagination and eligibility flags', async () => {
      const request = createSampleQuoteRequest();
      const quotes = createSampleQuotes();

      mockQuoteRequestRepo.findById.mockResolvedValue(request);
      mockQuoteRepo.findQuotesWithDetails.mockResolvedValue({
        rows: quotes,
        totalRecords: quotes.length,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        query: { page: 1, limit: 20 },
      });

      expect(result).toBeInstanceOf(HttpResult);
      expect(mockQuoteRepo.findQuotesWithDetails).toHaveBeenCalledWith(
        {
          requestId: '100',
          workshopId: undefined,
          page: 1,
          limit: 20,
        },
        expect.anything(),
      );
      expect(result.data).toHaveLength(3);
      expect(result.metadata.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 3,
        total_pages: 1,
      });

      // Exact 15-field QuoteDto allowlist & frozen immutability
      const first = result.data[0];
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.workshop)).toBe(true);
      expect(Object.keys(first).sort()).toEqual([
        'bid_accept_deadline',
        'committed_delivery_at',
        'created_at',
        'id',
        'ineligible_reasons',
        'is_eligible',
        'max_quantity',
        'request_id',
        'status',
        'unit_price',
        'updated_at',
        'version',
        'withdraw_reason',
        'withdrawn_at',
        'workshop',
      ]);
      expect(Object.keys(first.workshop).sort()).toEqual(['id', 'name']);
      expect('withdrawn_by' in first).toBe(false);
      expect('status' in first.workshop).toBe(false);

      expect(first.is_eligible).toBe(true);
      expect(first.ineligible_reasons).toEqual([]);
      expect(result.data[2].is_eligible).toBe(false);
      expect(result.data[2].ineligible_reasons).toEqual(['WORKSHOP_SUSPENDED']);
    });

    it('allows Admin to retrieve all quotes of any Buyer request', async () => {
      const request = createSampleQuoteRequest({ buyer_id: '777' });
      const quotes = createSampleQuotes();

      mockQuoteRequestRepo.findById.mockResolvedValue(request);
      mockQuoteRepo.findQuotesWithDetails.mockResolvedValue({
        rows: quotes,
        totalRecords: quotes.length,
      });

      const result = await useCase.execute({
        actor: adminActor,
        requestId: '100',
      });

      expect(mockQuoteRepo.findQuotesWithDetails).toHaveBeenCalledWith(
        {
          requestId: '100',
          workshopId: undefined,
          page: 1,
          limit: 20,
        },
        expect.anything(),
      );
      expect(result.data).toHaveLength(3);
      expect(result.metadata.pagination?.total_records).toBe(3);
    });

    it('rejects non-owner Buyer with 404 QuoteRequestNotFoundError (SEC-06 anti-IDOR) without querying quotes', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValue(
        createSampleQuoteRequest({ buyer_id: '10' }),
      );

      await expect(
        useCase.execute({
          actor: otherBuyerActor,
          requestId: '100',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(mockQuoteRepo.findQuotesWithDetails).not.toHaveBeenCalled();
    });

    it('scopes invited Artisan query to own workshopId so only own quote and total_records=1 are returned (BR-04)', async () => {
      const request = createSampleQuoteRequest();
      const ownQuote = createQuoteDetailItem({
        id: '401',
        workshop_id: '201',
        workshop_name: 'Xưởng Gốm Minh Long Bát Tràng',
        unit_price: 450000,
      });

      mockQuoteRequestRepo.findById.mockResolvedValue(request);
      mockRecipientRepo.findByRequestAndWorkshop.mockResolvedValue(
        createSampleRecipient('201', 'quoted'),
      );
      mockQuoteRepo.findQuotesWithDetails.mockResolvedValue({
        rows: [ownQuote],
        totalRecords: 1,
      });

      const result = await useCase.execute({
        actor: invitedArtisan1Actor,
        requestId: '100',
        page: 1,
        limit: 20,
      });

      expect(mockRecipientRepo.findByRequestAndWorkshop).toHaveBeenCalledWith(
        '100',
        '201',
        expect.anything(),
      );
      expect(mockQuoteRepo.findQuotesWithDetails).toHaveBeenCalledWith(
        {
          requestId: '100',
          workshopId: '201',
          page: 1,
          limit: 20,
        },
        expect.anything(),
      );
      expect(result.data).toHaveLength(1);
      expect(result.data[0].workshop.id).toBe('201');
      expect(result.metadata.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 1,
        total_pages: 1,
      });
    });

    it('returns empty list with total_records=0 and total_pages=0 for invited Artisan without own quote (no competitor count leak)', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValue(
        createSampleQuoteRequest(),
      );
      mockRecipientRepo.findByRequestAndWorkshop.mockResolvedValue(
        createSampleRecipient('201', 'pending'),
      );
      mockQuoteRepo.findQuotesWithDetails.mockResolvedValue({
        rows: [],
        totalRecords: 0,
      });

      const result = await useCase.execute({
        actor: invitedArtisan1Actor,
        requestId: '100',
      });

      expect(mockQuoteRepo.findQuotesWithDetails).toHaveBeenCalledWith(
        {
          requestId: '100',
          workshopId: '201',
          page: 1,
          limit: 20,
        },
        expect.anything(),
      );
      expect(result.data).toEqual([]);
      expect(result.metadata.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 0,
        total_pages: 0,
      });
    });

    it('returns empty page=2 with total_records=1 and total_pages=1 when invited Artisan requests page=2', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValue(
        createSampleQuoteRequest(),
      );
      mockRecipientRepo.findByRequestAndWorkshop.mockResolvedValue(
        createSampleRecipient('201', 'quoted'),
      );
      mockQuoteRepo.findQuotesWithDetails.mockResolvedValue({
        rows: [],
        totalRecords: 1,
      });

      const result = await useCase.execute({
        actor: invitedArtisan1Actor,
        requestId: '100',
        query: { page: 2, limit: 20 },
      });

      expect(result.data).toEqual([]);
      expect(result.metadata.pagination).toEqual({
        page: 2,
        limit: 20,
        total_records: 1,
        total_pages: 1,
      });
    });

    it('rejects uninvited Artisan with 404 QuoteRequestNotFoundError (SEC-06 anti-IDOR)', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValue(
        createSampleQuoteRequest(),
      );
      mockRecipientRepo.findByRequestAndWorkshop.mockResolvedValue(null);

      await expect(
        useCase.execute({
          actor: uninvitedArtisanActor,
          requestId: '100',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(mockQuoteRepo.findQuotesWithDetails).not.toHaveBeenCalled();
    });

    it('rejects Artisan without workshopId with 403 TradingPermissionDeniedError', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValue(
        createSampleQuoteRequest(),
      );

      await expect(
        useCase.execute({
          actor: artisanWithoutWorkshopActor,
          requestId: '100',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(mockRecipientRepo.findByRequestAndWorkshop).not.toHaveBeenCalled();
      expect(mockQuoteRepo.findQuotesWithDetails).not.toHaveBeenCalled();
    });

    it('rejects temp_password sessions for all roles with TEMP_PASSWORD_RESTRICTED before DB queries', async () => {
      for (const tempActor of [
        tempPasswordBuyerActor,
        tempPasswordArtisanActor,
        tempPasswordAdminActor,
      ]) {
        await expect(
          useCase.execute({ actor: tempActor, requestId: '100' }),
        ).rejects.toThrow(TradingDomainError);

        try {
          await useCase.execute({ actor: tempActor, requestId: '100' });
        } catch (err) {
          expect(err).toBeInstanceOf(TradingDomainError);
          expect((err as TradingDomainError).code).toBe(
            'TEMP_PASSWORD_RESTRICTED',
          );
        }
      }

      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('throws 404 QuoteRequestNotFoundError when QuoteRequest does not exist', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValue(null);

      await expect(
        useCase.execute({ actor: buyerActor, requestId: '999999' }),
      ).rejects.toThrow(QuoteRequestNotFoundError);
    });

    it('validates requestId and pagination bounds with InvalidTradingInputError', async () => {
      for (const badId of [
        'abc',
        '0',
        '-1',
        '1.5',
        '01',
        '9223372036854775808',
        ' 100 ',
      ]) {
        await expect(
          useCase.execute({ actor: buyerActor, requestId: badId }),
        ).rejects.toThrow(InvalidTradingInputError);
      }

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          query: { page: 0, limit: 20 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          query: { page: 1, limit: 101 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('evaluates all eligibility and lifecycle edge cases (withdrawn, expired, suspended, cancelled, accepted, combined)', async () => {
      const nowMs = Date.now();
      const pastDeadline = new Date(nowMs - 60_000);
      const futureDelivery = new Date(nowMs + 86_400_000 * 10);

      // 1. Open request: active, withdrawn, expired, suspended, combined
      const openRequest = createSampleQuoteRequest({
        status: 'artisans_bidding',
      });
      mockQuoteRequestRepo.findById.mockResolvedValue(openRequest);
      mockQuoteRepo.findQuotesWithDetails.mockResolvedValue({
        rows: [
          createQuoteDetailItem({
            id: '401',
            workshop_id: '201',
            status: 'active',
          }),
          createQuoteDetailItem({
            id: '402',
            workshop_id: '202',
            status: 'withdrawn',
            withdraw_reason: 'Hết nguyên liệu men',
            withdrawn_by: '22',
          }),
          createQuoteDetailItem({
            id: '403',
            workshop_id: '203',
            status: 'active',
            bid_accept_deadline: pastDeadline,
            committed_delivery_at: futureDelivery,
          }),
          createQuoteDetailItem({
            id: '404',
            workshop_id: '204',
            workshop_status: 'suspended',
            status: 'withdrawn',
            bid_accept_deadline: pastDeadline,
          }),
        ],
        totalRecords: 4,
      });

      const openResult = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });

      expect(openResult.data[0].is_eligible).toBe(true);
      expect(openResult.data[0].ineligible_reasons).toEqual([]);

      expect(openResult.data[1].status).toBe('withdrawn');
      expect(openResult.data[1].withdraw_reason).toBe('Hết nguyên liệu men');
      expect(openResult.data[1].withdrawn_at).not.toBeNull();
      expect('withdrawn_by' in openResult.data[1]).toBe(false);
      expect(openResult.data[1].is_eligible).toBe(false);
      expect(openResult.data[1].ineligible_reasons).toEqual([
        'QUOTE_WITHDRAWN',
      ]);

      expect(openResult.data[2].status).toBe('active');
      expect(openResult.data[2].is_eligible).toBe(false);
      expect(openResult.data[2].ineligible_reasons).toEqual(['QUOTE_EXPIRED']);

      expect(openResult.data[3].is_eligible).toBe(false);
      expect(openResult.data[3].ineligible_reasons).toEqual([
        'QUOTE_WITHDRAWN',
        'WORKSHOP_SUSPENDED',
        'QUOTE_EXPIRED',
      ]);

      // 2. Cancelled request retains read access with REQUEST_CANCELLED
      const cancelledRequest = createSampleQuoteRequest({
        status: 'artisans_bidding',
        cancelled_at: new Date(nowMs - 3_600_000),
      });
      mockQuoteRequestRepo.findById.mockResolvedValue(cancelledRequest);
      mockRecipientRepo.findByRequestAndWorkshop.mockResolvedValue(
        createSampleRecipient('201', 'quoted'),
      );
      mockQuoteRepo.findQuotesWithDetails.mockResolvedValue({
        rows: [
          createQuoteDetailItem({
            id: '401',
            workshop_id: '201',
            status: 'active',
          }),
        ],
        totalRecords: 1,
      });

      const cancelledRes = await useCase.execute({
        actor: invitedArtisan1Actor,
        requestId: '100',
      });
      expect(cancelledRes.data[0].is_eligible).toBe(false);
      expect(cancelledRes.data[0].ineligible_reasons).toEqual([
        'REQUEST_CANCELLED',
      ]);

      // 3. Accepted/delivered request retains read access with REQUEST_ACCEPTED
      const acceptedRequest = createSampleQuoteRequest({
        status: 'buyer_accepted',
      });
      mockQuoteRequestRepo.findById.mockResolvedValue(acceptedRequest);
      mockQuoteRepo.findQuotesWithDetails.mockResolvedValue({
        rows: [
          createQuoteDetailItem({
            id: '401',
            workshop_id: '201',
            status: 'accepted',
          }),
        ],
        totalRecords: 1,
      });

      const acceptedRes = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });
      expect(acceptedRes.data[0].is_eligible).toBe(false);
      expect(acceptedRes.data[0].ineligible_reasons).toEqual([
        'REQUEST_ACCEPTED',
      ]);
    });

    it('handles draft_request cleanly: empty for Buyer/Admin, 404 for Artisan', async () => {
      const draftRequest = createSampleQuoteRequest({
        status: 'draft_request',
        bidding_deadline: null,
        delivery_deadline: null,
      });
      mockQuoteRequestRepo.findById.mockResolvedValue(draftRequest);
      mockRecipientRepo.findByRequestAndWorkshop.mockResolvedValue(null);
      mockQuoteRepo.findQuotesWithDetails.mockResolvedValue({
        rows: [],
        totalRecords: 0,
      });

      const buyerRes = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });
      expect(buyerRes.data).toEqual([]);
      expect(buyerRes.metadata.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 0,
        total_pages: 0,
      });

      await expect(
        useCase.execute({ actor: invitedArtisan1Actor, requestId: '100' }),
      ).rejects.toThrow(QuoteRequestNotFoundError);
    });

    it('slices multi-page Buyer/Admin results accurately', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValue(
        createSampleQuoteRequest(),
      );
      mockQuoteRepo.findQuotesWithDetails.mockResolvedValue({
        rows: [
          createQuoteDetailItem({ id: '403', workshop_id: '203' }),
          createQuoteDetailItem({ id: '404', workshop_id: '204' }),
        ],
        totalRecords: 5,
      });

      const page2 = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        query: { page: 2, limit: 2 },
      });

      expect(page2.data).toHaveLength(2);
      expect(page2.metadata.pagination).toEqual({
        page: 2,
        limit: 2,
        total_records: 5,
        total_pages: 3,
      });
    });
  });

  // =========================================================================
  // Suite B: HTTP Pipeline Integration Tests (NestFactory + configureHttp + fetch)
  // =========================================================================
  describe('Suite B: HTTP Pipeline Integration Tests', () => {
    it('returns 200 OK with Cache-Control: no-store and all QuoteDtos for owner Buyer and Admin', async () => {
      const quotes = createSampleQuotes();
      mockQuoteRequestRepo.findById.mockResolvedValue(
        createSampleQuoteRequest(),
      );
      mockQuoteRepo.findQuotesWithDetails.mockResolvedValue({
        rows: quotes,
        totalRecords: 3,
      });

      for (const session of ['session-buyer-1', 'session-admin-1']) {
        const res = await fetch(
          `${base}/quote-requests/100/quotes?page=1&limit=20`,
          {
            headers: { Cookie: `vcraft-session=${session}` },
          },
        );

        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        const body = (await res.json()) as {
          success: boolean;
          data: QuoteDto[];
          pagination: {
            page: number;
            limit: number;
            total_records: number;
            total_pages: number;
          };
        };

        expect(body.success).toBe(true);
        expect(body.data).toHaveLength(3);
        expect(body.pagination).toEqual({
          page: 1,
          limit: 20,
          total_records: 3,
          total_pages: 1,
        });
        expect(body.data[0].workshop).toEqual({
          id: '201',
          name: 'Xưởng Gốm Minh Long Bát Tràng',
        });
      }
    });

    it('prevents competitor leakage (prices, workshop names, total_records) when Artisan calls HTTP endpoint', async () => {
      const ownQuote = createQuoteDetailItem({
        id: '401',
        workshop_id: '201',
        workshop_name: 'Xưởng Gốm Minh Long Bát Tràng',
        unit_price: 450000,
      });

      mockQuoteRequestRepo.findById.mockResolvedValue(
        createSampleQuoteRequest(),
      );
      mockRecipientRepo.findByRequestAndWorkshop.mockResolvedValue(
        createSampleRecipient('201', 'quoted'),
      );
      mockQuoteRepo.findQuotesWithDetails.mockResolvedValue({
        rows: [ownQuote],
        totalRecords: 1,
      });

      const res = await fetch(
        `${base}/quote-requests/100/quotes?page=1&limit=20`,
        {
          headers: { Cookie: 'vcraft-session=session-artisan-201' },
        },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');

      const body = (await res.json()) as {
        success: boolean;
        data: QuoteDto[];
        pagination: {
          page: number;
          limit: number;
          total_records: number;
          total_pages: number;
        };
      };
      const serialized = JSON.stringify(body);

      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.pagination.total_records).toBe(1);
      expect(body.pagination.total_pages).toBe(1);
      expect(serialized).not.toContain('Xưởng Đối Thủ');
      expect(serialized).not.toContain('420000');
      expect(serialized).not.toContain('390000');
      expect(serialized).not.toContain('withdrawn_by');
      expect(serialized).not.toContain('buyer_id');
      expect(serialized).not.toContain('0912345678');
    });

    it('returns 200 OK with empty data and total_records=0 for invited suspended Artisan with no quote', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValue(
        createSampleQuoteRequest(),
      );
      mockRecipientRepo.findByRequestAndWorkshop.mockResolvedValue(
        createSampleRecipient('201', 'declined'),
      );
      mockQuoteRepo.findQuotesWithDetails.mockResolvedValue({
        rows: [],
        totalRecords: 0,
      });

      const res = await fetch(`${base}/quote-requests/100/quotes`, {
        headers: { Cookie: 'vcraft-session=session-artisan-201' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = (await res.json()) as {
        success: boolean;
        data: QuoteDto[];
        pagination: {
          page: number;
          limit: number;
          total_records: number;
          total_pages: number;
        };
      };
      expect(body).toEqual({
        success: true,
        data: [],
        pagination: { page: 1, limit: 20, total_records: 0, total_pages: 0 },
      });
    });

    it('returns 401 AUTHENTICATION_REQUIRED and 401 SESSION_EXPIRED in RFC 9457 Problem Details', async () => {
      const noCookieRes = await fetch(`${base}/quote-requests/100/quotes`);
      expect(noCookieRes.status).toBe(401);
      expect(noCookieRes.headers.get('content-type')).toContain(
        'application/problem+json',
      );
      const noCookieBody = (await noCookieRes.json()) as { code: string };
      expect(noCookieBody.code).toBe('AUTHENTICATION_REQUIRED');

      const expiredRes = await fetch(`${base}/quote-requests/100/quotes`, {
        headers: { Cookie: 'vcraft-session=expired-token-xyz' },
      });
      expect(expiredRes.status).toBe(401);
      const expiredBody = (await expiredRes.json()) as { code: string };
      expect(expiredBody.code).toBe('SESSION_EXPIRED');
    });

    it('returns 403 TEMP_PASSWORD_RESTRICTED and 403 PERMISSION_DENIED appropriately', async () => {
      const tempRes = await fetch(`${base}/quote-requests/100/quotes`, {
        headers: { Cookie: 'vcraft-session=session-temp-buyer' },
      });
      expect(tempRes.status).toBe(403);
      const tempBody = (await tempRes.json()) as { code: string };
      expect(tempBody.code).toBe('TEMP_PASSWORD_RESTRICTED');

      mockQuoteRequestRepo.findById.mockResolvedValue(
        createSampleQuoteRequest(),
      );
      const noWsRes = await fetch(`${base}/quote-requests/100/quotes`, {
        headers: { Cookie: 'vcraft-session=session-artisan-no-ws' },
      });
      expect(noWsRes.status).toBe(403);
      const noWsBody = (await noWsRes.json()) as { code: string };
      expect(noWsBody.code).toBe('PERMISSION_DENIED');
    });

    it('returns 404 RESOURCE_NOT_FOUND for missing request, non-owner Buyer, and uninvited Artisan', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValue(null);
      const missingRes = await fetch(`${base}/quote-requests/999/quotes`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });
      expect(missingRes.status).toBe(404);
      expect(((await missingRes.json()) as { code: string }).code).toBe(
        'RESOURCE_NOT_FOUND',
      );

      mockQuoteRequestRepo.findById.mockResolvedValue(
        createSampleQuoteRequest({ buyer_id: '10' }),
      );
      const nonOwnerRes = await fetch(`${base}/quote-requests/100/quotes`, {
        headers: { Cookie: 'vcraft-session=session-other-buyer' },
      });
      expect(nonOwnerRes.status).toBe(404);
      expect(((await nonOwnerRes.json()) as { code: string }).code).toBe(
        'RESOURCE_NOT_FOUND',
      );

      mockRecipientRepo.findByRequestAndWorkshop.mockResolvedValue(null);
      const uninvitedRes = await fetch(`${base}/quote-requests/100/quotes`, {
        headers: { Cookie: 'vcraft-session=session-artisan-uninvited' },
      });
      expect(uninvitedRes.status).toBe(404);
      expect(((await uninvitedRes.json()) as { code: string }).code).toBe(
        'RESOURCE_NOT_FOUND',
      );
    });

    it('returns 400 INVALID_INPUT for malformed :id or invalid/unknown query parameters', async () => {
      for (const url of [
        `${base}/quote-requests/abc/quotes`,
        `${base}/quote-requests/0/quotes`,
        `${base}/quote-requests/100/quotes?page=0`,
        `${base}/quote-requests/100/quotes?limit=101`,
        `${base}/quote-requests/100/quotes?limit=abc`,
        `${base}/quote-requests/100/quotes?extra=1`,
        `${base}/quote-requests/100/quotes?sort_by=unit_price`,
      ]) {
        const res = await fetch(url, {
          headers: { Cookie: 'vcraft-session=session-buyer-1' },
        });
        expect(res.status).toBe(400);
        expect(res.headers.get('content-type')).toContain(
          'application/problem+json',
        );
        const body = (await res.json()) as { code: string; tracking_id: string };
        expect(body.code).toBe('INVALID_INPUT');
        expect(body.tracking_id).toBeTruthy();
      }
    });

    it('generates valid OpenAPI 3.0.0 documentation for GET /api/v1/quote-requests/{id}/quotes', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const operation = doc.paths['/api/v1/quote-requests/{id}/quotes']?.get;
      expect(operation).toBeDefined();
      expect(operation).toHaveProperty('x-roles', [
        'buyer',
        'artisan',
        'admin',
      ]);
      expect(operation?.responses['200']).toBeDefined();
      expect(operation?.responses['400']).toBeDefined();
      expect(operation?.responses['401']).toBeDefined();
      expect(operation?.responses['403']).toBeDefined();
      expect(operation?.responses['404']).toBeDefined();
    });
  });

  // =========================================================================
  // Suite C: Persistence Unit Tests (PrismaQuoteRepository.findQuotesWithDetails)
  // =========================================================================
  describe('Suite C: PrismaQuoteRepository.findQuotesWithDetails Persistence Unit Tests', () => {
    const NOW = new Date('2026-11-10T10:00:00.000Z');
    const ACCEPT_DEADLINE = new Date('2026-11-15T10:00:00.000Z');
    const DELIVERY_DATE = new Date('2026-11-20T10:00:00.000Z');

    it('applies unscoped where={request_id} with deterministic orderBy, skip/take, and workshop column selection', async () => {
      const mockClient = {
        quote: {
          count: vi.fn().mockResolvedValue(2),
          findMany: vi.fn().mockResolvedValue([
            {
              id: 401n,
              request_id: 100n,
              workshop_id: 201n,
              unit_price: new Prisma.Decimal('450000'),
              max_quantity: 120,
              bid_accept_deadline: ACCEPT_DEADLINE,
              committed_delivery_at: DELIVERY_DATE,
              status: 'active',
              version: 1,
              withdraw_reason: null,
              withdrawn_by: null,
              withdrawn_at: null,
              created_at: NOW,
              updated_at: NOW,
              workshop: {
                id: 201n,
                name: 'Xưởng Gốm 201',
                status: 'active',
              },
            },
          ]),
        },
      };

      const mockPrisma = {
        $transaction: vi.fn(
          async (fn: (tx: unknown) => Promise<unknown>) => await fn(mockClient),
        ),
        ...mockClient,
      } as unknown as PrismaService;

      const prismaTxRunner = new PrismaTransactionRunner(mockPrisma);
      const repo = new PrismaQuoteRepository(prismaTxRunner, mockPrisma);

      const res = await prismaTxRunner.run((tx) =>
        repo.findQuotesWithDetails(
          { requestId: '100', page: 2, limit: 10 },
          tx,
        ),
      );

      expect(mockClient.quote.count).toHaveBeenCalledWith({
        where: { request_id: 100n },
      });
      expect(mockClient.quote.findMany).toHaveBeenCalledWith({
        where: { request_id: 100n },
        include: {
          workshop: {
            select: {
              id: true,
              name: true,
              status: true,
            },
          },
        },
        orderBy: { id: 'asc' },
        skip: 10,
        take: 10,
      });

      expect(res.totalRecords).toBe(2);
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].entity.id).toBe('401');
      expect(res.rows[0].entity.unit_price).toBe(450000);
      expect(res.rows[0].workshop).toEqual({
        id: '201',
        name: 'Xưởng Gốm 201',
        status: 'active',
      });
    });

    it('applies workshop_id filter BEFORE count and findMany when workshopId is provided (Artisan scoping)', async () => {
      const mockClient = {
        quote: {
          count: vi.fn().mockResolvedValue(1),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };

      const mockPrisma = {
        $transaction: vi.fn(
          async (fn: (tx: unknown) => Promise<unknown>) => await fn(mockClient),
        ),
        ...mockClient,
      } as unknown as PrismaService;

      const prismaTxRunner = new PrismaTransactionRunner(mockPrisma);
      const repo = new PrismaQuoteRepository(prismaTxRunner, mockPrisma);

      // Without explicit tx: uses injected PrismaService directly
      const res = await repo.findQuotesWithDetails({
        requestId: '100',
        workshopId: '201',
        page: 1,
        limit: 20,
      });

      const expectedWhere = { request_id: 100n, workshop_id: 201n };
      expect(mockClient.quote.count).toHaveBeenCalledWith({
        where: expectedWhere,
      });
      expect(mockClient.quote.findMany).toHaveBeenCalledWith({
        where: expectedWhere,
        include: {
          workshop: {
            select: {
              id: true,
              name: true,
              status: true,
            },
          },
        },
        orderBy: { id: 'asc' },
        skip: 0,
        take: 20,
      });
      expect(res).toEqual({ rows: [], totalRecords: 1 });
    });

    it('falls back to txRunner.run when neither tx nor PrismaService is provided', async () => {
      const mockClient = {
        quote: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };

      const mockPrisma = {
        $transaction: vi.fn(
          async (fn: (tx: unknown) => Promise<unknown>) => await fn(mockClient),
        ),
      } as unknown as PrismaService;

      const prismaTxRunner = new PrismaTransactionRunner(mockPrisma);
      const repo = new PrismaQuoteRepository(prismaTxRunner);

      const res = await repo.findQuotesWithDetails({
        requestId: '100',
        workshopId: '201',
      });

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockClient.quote.count).toHaveBeenCalledWith({
        where: { request_id: 100n, workshop_id: 201n },
      });
      expect(res).toEqual({ rows: [], totalRecords: 0 });
    });
  });
});
