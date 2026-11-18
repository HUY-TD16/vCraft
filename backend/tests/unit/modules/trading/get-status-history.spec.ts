import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureHttp } from '../../../../src/bootstrap/configure-http';
import { AppLogger } from '../../../../src/common/observability/app-logger';
import { AppConfigModule } from '../../../../src/common/config/app-config';
import { SecurityModule } from '../../../../src/common/security/security.module';
import { IDENTITY_CONTRACT } from '../../../../src/modules/identity/public/contracts/identity.contract';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../../../src/common/application/ports/transaction-runner';
import {
  type IQuoteRequestRepository,
  type IStatusLogRepository,
  QUOTE_REQUEST_REPOSITORY,
  STATUS_LOG_REPOSITORY,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { PrismaStatusLogRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/status-log.repository';
import { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import { GetQuoteRequestByIdUseCase } from '../../../../src/modules/trading/application/use-cases/requests/get-quote-request-by-id.use-case';
import { GetStatusHistoryUseCase } from '../../../../src/modules/trading/application/use-cases/requests/get-status-history.use-case';
import { QuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/quote-request.controller';
import {
  InvalidTradingInputError,
  QuoteRequest,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import type { RequestEventDto } from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';

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

const artisanActor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '200',
  authVersion: 1,
  sessionId: 'session-artisan-1',
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

const tempPasswordAdminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-temp-admin',
  sessionLevel: 'temp_password',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createSampleQuoteRequest(
  overrides: Partial<{
    id: string;
    buyer_id: string;
    status: any;
    version: number;
    cancelled_at: Date | null;
    cancelled_by: string | null;
    cancel_reason: string | null;
  }> = {},
): QuoteRequest {
  const cancelledAt =
    overrides.cancelled_at !== undefined
      ? overrides.cancelled_at
      : overrides.status === 'cancelled'
        ? new Date('2026-11-13T10:00:00.000Z')
        : null;
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
    status: overrides.status ?? 'sent_to_artisans',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội',
    delivery_address: '123 Phố Huế, Hai Bà Trưng, Hà Nội',
    recipient_name: 'Nguyễn Văn A',
    recipient_phone: '0912345678',
    bidding_deadline: new Date(Date.now() + 86400000 * 2),
    delivery_deadline: new Date(Date.now() + 86400000 * 10),
    bidding_closed_at: null,
    version: overrides.version ?? 1,
    cancelled_at: cancelledAt,
    cancelled_by: cancelledBy,
    cancel_reason:
      overrides.cancel_reason !== undefined
        ? overrides.cancel_reason
        : cancelledAt
          ? 'Cancelled by buyer'
          : null,
    created_at: new Date('2026-11-10T10:00:00.000Z'),
    updated_at: new Date('2026-11-10T10:00:00.000Z'),
  });
}

function createSampleStatusEvents(): readonly RequestEventDto[] {
  return Object.freeze([
    Object.freeze({
      id: '502',
      event_type: 'sent',
      prev_status: 'draft',
      new_status: 'sent_to_artisans',
      performed_by: Object.freeze({
        id: '10',
        display_name: 'Buyer Tester',
      }),
      is_admin_action: false,
      note: 'Gửi yêu cầu tới các làng nghề',
      evidence: null,
      created_at: '2026-11-11T09:00:00.000Z',
    }),
    Object.freeze({
      id: '501',
      event_type: 'created',
      prev_status: null,
      new_status: 'draft',
      performed_by: Object.freeze({
        id: '10',
        display_name: 'Buyer Tester',
      }),
      is_admin_action: false,
      note: 'Tạo bản nháp yêu cầu',
      evidence: null,
      created_at: '2026-11-10T08:00:00.000Z',
    }),
  ]);
}

function createSampleAdminActionEvent(): RequestEventDto {
  return Object.freeze({
    id: '503',
    event_type: 'received_by_admin',
    prev_status: 'production_started',
    new_status: 'delivered',
    performed_by: Object.freeze({
      id: '1',
      display_name: 'Admin Supervisor',
    }),
    is_admin_action: true,
    note: 'Admin xác nhận giao hàng thay người mua',
    evidence: 'https://vcraft.vn/evidence/delivery-503.pdf',
    created_at: '2026-11-14T15:30:00.000Z',
  });
}

function createSampleSystemEvent(): RequestEventDto {
  return Object.freeze({
    id: '504',
    event_type: 'bidding_closed',
    prev_status: 'artisans_bidding',
    new_status: 'bidding_closed',
    performed_by: null,
    is_admin_action: false,
    note: 'Hết hạn nhận báo giá tự động',
    evidence: null,
    created_at: '2026-11-15T00:00:00.000Z',
  });
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
describe('API GET /api/v1/quote-requests/:id/history (Task 16, UC-18, BR-26, SEC-06) — Comprehensive Test Suite', () => {
  const identityMock = new MockIdentityContract();
  const txRunner = new MockTransactionRunner();

  const mockQuoteRequestRepo = {
    findById: vi.fn(),
    findDetailById: vi.fn(),
  };

  const mockStatusLogRepo = {
    listEventsByRequestId: vi.fn(),
    findEventsWithPagination: vi.fn(),
  };

  let useCase: GetStatusHistoryUseCase;
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
      { provide: STATUS_LOG_REPOSITORY, useValue: mockStatusLogRepo },
      {
        provide: GetQuoteRequestByIdUseCase,
        useFactory: (runner: any, repo: any) =>
          new GetQuoteRequestByIdUseCase(runner, repo),
        inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
      },
      {
        provide: GetStatusHistoryUseCase,
        useFactory: (runner: any, qRepo: any, sRepo: any) =>
          new GetStatusHistoryUseCase(runner, qRepo, sRepo),
        inject: [
          TRANSACTION_RUNNER,
          QUOTE_REQUEST_REPOSITORY,
          STATUS_LOG_REPOSITORY,
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

    app = await NestFactory.create<NestExpressApplication>(TestAppModule, {
      bodyParser: false,
      logger: false,
      abortOnError: false,
    });
    configureHttp(app, new AppLogger('error', (_line, done) => done()));
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()) + '/api/v1';

    useCase = new GetStatusHistoryUseCase(
      txRunner,
      mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
      mockStatusLogRepo as unknown as IStatusLogRepository,
    );
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
      if (token === 'session-artisan-1') return artisanActor;
      if (token === 'session-temp-buyer') return tempPasswordBuyerActor;
      if (token === 'session-temp-admin') return tempPasswordAdminActor;
      return null;
    });
  });

  // =========================================================================
  // Suite A: Use Case Unit Tests (Domain Logic & Invariants)
  // =========================================================================
  describe('Suite A: GetStatusHistoryUseCase (Domain Logic & Invariants)', () => {
    it('TC-UC-01: Buyer owner retrieves status history successfully with default pagination (happy path)', async () => {
      const request = createSampleQuoteRequest();
      const events = createSampleStatusEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockStatusLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
        items: events,
        total: events.length,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });

      expect(mockQuoteRequestRepo.findById).toHaveBeenCalledWith('100', expect.anything());
      expect(mockStatusLogRepo.findEventsWithPagination).toHaveBeenCalledWith(
        { requestId: '100', page: 1, limit: 20 },
        expect.anything(),
      );

      expect(result.data).toHaveLength(2);
      expect(result.metadata.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 2,
        total_pages: 1,
      });
      expect(result.data[0]).toEqual(
        expect.objectContaining({
          id: '502',
          event_type: 'sent',
          prev_status: 'draft',
          new_status: 'sent_to_artisans',
          is_admin_action: false,
          note: 'Gửi yêu cầu tới các làng nghề',
          evidence: null,
          created_at: '2026-11-11T09:00:00.000Z',
        }),
      );
      expect(result.data[0].performed_by).toEqual(
        expect.objectContaining({
          id: '10',
          display_name: 'Buyer Tester',
        }),
      );
      expect(result.data[1].id).toBe('501');
      expect(result.data[1].new_status).toBe('draft');
    });

    it('TC-UC-02: Admin retrieves status history successfully for any quote request', async () => {
      const request = createSampleQuoteRequest({ buyer_id: '99' });
      const events = createSampleStatusEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockStatusLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
        items: events,
        total: events.length,
      });

      const result = await useCase.execute({
        actor: adminActor,
        requestId: '100',
      });

      expect(result.data).toHaveLength(2);
      expect(result.metadata.pagination?.total_records).toBe(2);
    });

    it('TC-UC-03: Non-owner Buyer receives QuoteRequestNotFoundError (SEC-06 Anti-IDOR)', async () => {
      const request = createSampleQuoteRequest({ buyer_id: '10' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);

      await expect(
        useCase.execute({
          actor: otherBuyerActor,
          requestId: '100',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(mockStatusLogRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('TC-UC-04: Non-existent QuoteRequest throws QuoteRequestNotFoundError', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(null);

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '999999',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(mockStatusLogRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('TC-UC-05: Temp password session throws TradingDomainError(TEMP_PASSWORD_RESTRICTED)', async () => {
      await expect(
        useCase.execute({
          actor: tempPasswordBuyerActor,
          requestId: '100',
        }),
      ).rejects.toThrow(TradingDomainError);

      try {
        await useCase.execute({
          actor: tempPasswordBuyerActor,
          requestId: '100',
        });
      } catch (err: any) {
        expect(err.code).toBe('TEMP_PASSWORD_RESTRICTED');
      }

      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('TC-UC-06: Artisan role throws TradingPermissionDeniedError', async () => {
      const request = createSampleQuoteRequest();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);

      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '100',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('TC-UC-07: Malformed or non-positive requestId throws InvalidTradingInputError', async () => {
      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: 'not-a-number',
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '-5',
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '0',
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('TC-UC-08: Empty status history returns HTTP 200 with empty array and pagination', async () => {
      const request = createSampleQuoteRequest();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockStatusLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
        items: [],
        total: 0,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });

      expect(result.data).toEqual([]);
      expect(result.metadata.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 0,
        total_pages: 0,
      });
    });

    it('TC-UC-09: RequestEventDto schema validation: verifies all 9 fields', async () => {
      const request = createSampleQuoteRequest();
      const adminEvent = createSampleAdminActionEvent();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockStatusLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [adminEvent],
        totalRecords: 1,
        items: [adminEvent],
        total: 1,
      });

      const result = await useCase.execute({
        actor: adminActor,
        requestId: '100',
      });

      expect(result.data).toHaveLength(1);
      const item = result.data[0];
      expect(item.id).toBe('503');
      expect(item.event_type).toBe('received_by_admin');
      expect(item.prev_status).toBe('production_started');
      expect(item.new_status).toBe('delivered');
      expect(item.is_admin_action).toBe(true);
      expect(item.note).toBe('Admin xác nhận giao hàng thay người mua');
      expect(item.evidence).toBe('https://vcraft.vn/evidence/delivery-503.pdf');
      expect(item.performed_by).toEqual({
        id: '1',
        display_name: 'Admin Supervisor',
      });
      expect(item.created_at).toBe('2026-11-14T15:30:00.000Z');
    });

    it('TC-UC-10: System automated event correctly sets performed_by to null', async () => {
      const request = createSampleQuoteRequest();
      const systemEvent = createSampleSystemEvent();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockStatusLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [systemEvent],
        totalRecords: 1,
        items: [systemEvent],
        total: 1,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });

      expect(result.data[0].performed_by).toBeNull();
      expect(result.data[0].event_type).toBe('bidding_closed');
    });

    it('TC-UC-11: Lifecycle retention: Buyer owner can view history of cancelled quote request', async () => {
      const request = createSampleQuoteRequest({
        status: 'cancelled',
        cancelled_at: new Date('2026-11-13T10:00:00.000Z'),
        cancelled_by: '10',
        cancel_reason: 'Buyer no longer needs products',
      });
      const events = createSampleStatusEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockStatusLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
        items: events,
        total: events.length,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });

      expect(result.data).toHaveLength(2);
      expect(result.metadata.pagination?.total_records).toBe(2);
    });
  });

  // =========================================================================
  // Suite B: Controller HTTP Pipeline Integration Tests
  // =========================================================================
  describe('Suite B: Controller HTTP Pipeline Integration Tests', () => {
    it('TC-HTTP-01: Happy Path — GET /api/v1/quote-requests/:id/history by Buyer owner returns 200 with envelope', async () => {
      const request = createSampleQuoteRequest();
      const events = createSampleStatusEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockStatusLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
        items: events,
        total: events.length,
      });

      const res = await fetch(`${base}/quote-requests/100/history`, {
        headers: {
          cookie: 'vcraft-session=session-buyer-1',
        },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 2,
        total_pages: 1,
      });
      expect(json.data[0].id).toBe('502');
      expect(json.data[0].performed_by).toEqual({
        id: '10',
        display_name: 'Buyer Tester',
      });
    });

    it('TC-HTTP-02: Happy Path — GET /api/v1/quote-requests/:id/history by Admin returns 200', async () => {
      const request = createSampleQuoteRequest({ buyer_id: '99' });
      const events = createSampleStatusEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockStatusLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
        items: events,
        total: events.length,
      });

      const res = await fetch(`${base}/quote-requests/100/history`, {
        headers: {
          cookie: 'vcraft-session=session-admin-1',
        },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
    });

    it('TC-HTTP-03: Anti-IDOR — GET by non-owner Buyer returns HTTP 404 RESOURCE_NOT_FOUND', async () => {
      const request = createSampleQuoteRequest({ buyer_id: '10' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);

      const res = await fetch(`${base}/quote-requests/100/history`, {
        headers: {
          cookie: 'vcraft-session=session-other-buyer',
        },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('TC-HTTP-04: Non-existent QuoteRequest returns HTTP 404 RESOURCE_NOT_FOUND', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/quote-requests/999999/history`, {
        headers: {
          cookie: 'vcraft-session=session-buyer-1',
        },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('TC-HTTP-05: Artisan actor rejected with HTTP 403 PERMISSION_DENIED', async () => {
      const res = await fetch(`${base}/quote-requests/100/history`, {
        headers: {
          cookie: 'vcraft-session=session-artisan-1',
        },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('TC-HTTP-06: Session with temp_password rejected with HTTP 403 TEMP_PASSWORD_RESTRICTED', async () => {
      const res = await fetch(`${base}/quote-requests/100/history`, {
        headers: {
          cookie: 'vcraft-session=session-temp-buyer',
        },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
    });

    it('TC-HTTP-07: Missing auth cookie returns HTTP 401 AUTHENTICATION_REQUIRED', async () => {
      const res = await fetch(`${base}/quote-requests/100/history`);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('TC-HTTP-08: Invalid session token returns HTTP 401', async () => {
      const res = await fetch(`${base}/quote-requests/100/history`, {
        headers: {
          cookie: 'vcraft-session=invalid-session-token',
        },
      });

      expect(res.status).toBe(401);
    });

    it('TC-HTTP-09: Malformed path parameter :id returns HTTP 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/abc/history`, {
        headers: {
          cookie: 'vcraft-session=session-buyer-1',
        },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('TC-HTTP-10: Empty history returns HTTP 200 with data: [] and pagination metadata', async () => {
      const request = createSampleQuoteRequest();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockStatusLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
        items: [],
        total: 0,
      });

      const res = await fetch(`${base}/quote-requests/100/history`, {
        headers: {
          cookie: 'vcraft-session=session-buyer-1',
        },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toEqual([]);
      expect(json.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 0,
        total_pages: 0,
      });
    });

    it('TC-HTTP-11: Status history on cancelled QuoteRequest returns HTTP 200 with full history', async () => {
      const request = createSampleQuoteRequest({
        status: 'cancelled',
        cancelled_at: new Date('2026-11-13T10:00:00.000Z'),
        cancelled_by: '10',
        cancel_reason: 'Buyer cancelled request',
      });
      const events = createSampleStatusEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockStatusLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
        items: events,
        total: events.length,
      });

      const res = await fetch(`${base}/quote-requests/100/history`, {
        headers: {
          cookie: 'vcraft-session=session-buyer-1',
        },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
    });
  });

  // =========================================================================
  // Suite C: Pagination & Query Parameter Boundaries
  // =========================================================================
  describe('Suite C: Pagination & Query Parameter Boundaries', () => {
    it('TC-PAGE-01: Default pagination when query omitted (?page=1&limit=20)', async () => {
      const request = createSampleQuoteRequest();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockStatusLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
        items: [],
        total: 0,
      });

      const res = await fetch(`${base}/quote-requests/100/history`, {
        headers: {
          cookie: 'vcraft-session=session-buyer-1',
        },
      });

      expect(res.status).toBe(200);
      expect(mockStatusLogRepo.findEventsWithPagination).toHaveBeenCalledWith(
        { requestId: '100', page: 1, limit: 20 },
        expect.anything(),
      );
    });

    it('TC-PAGE-02: Custom pagination parameters (?page=3&limit=10)', async () => {
      const request = createSampleQuoteRequest();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockStatusLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 25,
        items: [],
        total: 25,
      });

      const res = await fetch(`${base}/quote-requests/100/history?page=3&limit=10`, {
        headers: {
          cookie: 'vcraft-session=session-buyer-1',
        },
      });

      expect(res.status).toBe(200);
      expect(mockStatusLogRepo.findEventsWithPagination).toHaveBeenCalledWith(
        { requestId: '100', page: 3, limit: 10 },
        expect.anything(),
      );
      const json = await res.json();
      expect(json.pagination).toEqual({
        page: 3,
        limit: 10,
        total_records: 25,
        total_pages: 3,
      });
    });

    it('TC-PAGE-03: Max limit boundary (limit=100) succeeds', async () => {
      const request = createSampleQuoteRequest();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockStatusLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
        items: [],
        total: 0,
      });

      const res = await fetch(`${base}/quote-requests/100/history?limit=100`, {
        headers: {
          cookie: 'vcraft-session=session-buyer-1',
        },
      });

      expect(res.status).toBe(200);
      expect(mockStatusLogRepo.findEventsWithPagination).toHaveBeenCalledWith(
        { requestId: '100', page: 1, limit: 100 },
        expect.anything(),
      );
    });

    it('TC-PAGE-04: Limit overflow (limit=101) returns HTTP 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/100/history?limit=101`, {
        headers: {
          cookie: 'vcraft-session=session-buyer-1',
        },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('TC-PAGE-05: Non-positive page (page=0) returns HTTP 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/100/history?page=0`, {
        headers: {
          cookie: 'vcraft-session=session-buyer-1',
        },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('TC-PAGE-06: Strict query validation rejects unknown query parameter (?unexpected=123)', async () => {
      const res = await fetch(`${base}/quote-requests/100/history?unexpected=123`, {
        headers: {
          cookie: 'vcraft-session=session-buyer-1',
        },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });
  });

  // =========================================================================
  // Suite D: PrismaStatusLogRepository (Persistence & Sorting Implementation)
  // =========================================================================
  describe('Suite D: PrismaStatusLogRepository.findEventsWithPagination', () => {
    it('TC-REPO-01: executes count and findMany with descending order and include performedBy', async () => {
      const mockRows = [
        {
          id: 502n,
          request_id: 100n,
          event_type: 'sent',
          evidence: null,
          prev_status: 'draft_request',
          new_status: 'sent_to_artisans',
          performed_by: 10n,
          note: 'Sent',
          is_admin_action: false,
          created_at: new Date('2026-11-11T09:00:00.000Z'),
          performedBy: {
            id: 10n,
            display_name: 'Buyer Tester',
          },
        },
        {
          id: 501n,
          request_id: 100n,
          event_type: 'created',
          evidence: null,
          prev_status: null,
          new_status: 'draft_request',
          performed_by: 10n,
          note: 'Created',
          is_admin_action: false,
          created_at: new Date('2026-11-10T08:00:00.000Z'),
          performedBy: {
            id: 10n,
            display_name: 'Buyer Tester',
          },
        },
      ];

      const mockPrismaClient = {
        statusLog: {
          count: vi.fn().mockResolvedValue(2),
          findMany: vi.fn().mockResolvedValue(mockRows),
        },
      };

      const mockTxRunner = {
        getClient: vi.fn().mockReturnValue(mockPrismaClient),
        run: vi.fn().mockImplementation(async (cb: any) => cb({} as any)),
      } as unknown as PrismaTransactionRunner;

      const repo = new PrismaStatusLogRepository(mockTxRunner);

      const result = await repo.findEventsWithPagination({
        requestId: '100',
        page: 1,
        limit: 20,
      });

      expect(mockPrismaClient.statusLog.count).toHaveBeenCalledWith({
        where: { request_id: 100n },
      });
      expect(mockPrismaClient.statusLog.findMany).toHaveBeenCalledWith({
        where: { request_id: 100n },
        include: {
          performedBy: {
            select: {
              id: true,
              display_name: true,
            },
          },
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 20,
      });

      expect(result.totalRecords).toBe(2);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].id).toBe('502');
      expect(result.rows[0].event_type).toBe('sent');
      expect(result.rows[0].performed_by).toEqual({
        id: '10',
        display_name: 'Buyer Tester',
      });
      expect(result.rows[1].id).toBe('501');
    });

    it('TC-REPO-02: executes within existing transaction context when tx is passed', async () => {
      const mockPrismaClient = {
        statusLog: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };

      const mockTxRunner = {
        getClient: vi.fn().mockReturnValue(mockPrismaClient),
        run: vi.fn(),
      } as unknown as PrismaTransactionRunner;

      const repo = new PrismaStatusLogRepository(mockTxRunner);
      const fakeTx = {} as any;

      const result = await repo.findEventsWithPagination(
        {
          requestId: '100',
          page: 2,
          limit: 10,
        },
        fakeTx,
      );

      expect(mockTxRunner.getClient).toHaveBeenCalledWith(fakeTx);
      expect(mockTxRunner.run).not.toHaveBeenCalled();
      expect(mockPrismaClient.statusLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
        }),
      );
      expect(result.totalRecords).toBe(0);
      expect(result.rows).toEqual([]);
    });
  });
});
