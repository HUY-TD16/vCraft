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
  type IContactEditHistoryRepository,
  type IAllocationRepository,
  QUOTE_REQUEST_REPOSITORY,
  CONTACT_EDIT_HISTORY_REPOSITORY,
  ALLOCATION_REPOSITORY,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { GetQuoteRequestByIdUseCase } from '../../../../src/modules/trading/application/use-cases/requests/get-quote-request-by-id.use-case';
import { GetContactHistoryUseCase } from '../../../../src/modules/trading/application/use-cases/requests/get-contact-history.use-case';
import { QuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/quote-request.controller';
import {
  InvalidTradingInputError,
  QuoteRequest,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
  Allocation,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import type { ContactEventDto } from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';

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

const artisanWithAllocation: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '200',
  authVersion: 1,
  sessionId: 'session-artisan-allocated',
  sessionLevel: 'normal',
});

const artisanWithoutAllocation: AuthenticatedActor = Object.freeze({
  accountId: '30',
  role: 'artisan',
  workshopId: '300',
  authVersion: 1,
  sessionId: 'session-artisan-no-alloc',
  sessionLevel: 'normal',
});

const artisanNotInvited: AuthenticatedActor = Object.freeze({
  accountId: '40',
  role: 'artisan',
  workshopId: '400',
  authVersion: 1,
  sessionId: 'session-artisan-uninvited',
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
          ? 'Cancelled'
          : null,
    created_at: new Date('2026-11-10T10:00:00.000Z'),
    updated_at: new Date('2026-11-10T10:00:00.000Z'),
  });
}

function createSampleContactEvents(): readonly ContactEventDto[] {
  return Object.freeze([
    Object.freeze({
      id: '501',
      prev_recipient_name: 'Nguyễn Văn A',
      prev_recipient_phone: '0912345678',
      new_recipient_name: 'Nguyễn Văn B',
      new_recipient_phone: '0912345679',
      edited_by: Object.freeze({ id: '10', display_name: 'Buyer Tester' }),
      edited_at: '2026-11-11T08:00:00.000Z',
      version: 2,
    }),
    Object.freeze({
      id: '502',
      prev_recipient_name: 'Nguyễn Văn B',
      prev_recipient_phone: '0912345679',
      new_recipient_name: 'Trần Thị C',
      new_recipient_phone: '0987654321',
      edited_by: Object.freeze({ id: '10', display_name: 'Buyer Tester' }),
      edited_at: '2026-11-12T14:30:00.000Z',
      version: 3,
    }),
  ]);
}

function createSampleAllocation(): Allocation {
  return Allocation.reconstitute({
    id: '600',
    request_id: '100',
    workshop_id: '200',
    quote_id: '300',
    quantity: 50,
    unit_price: 150000,
    committed_delivery_at: new Date(Date.now() + 86400000 * 7),
    status: 'confirmed',
    version: 1,
    started_at: null,
    started_by: null,
    handed_over_at: null,
    handed_over_by: null,
    delivery_note: null,
    admin_handed_over: false,
    admin_delivery_evidence: null,
    admin_handover_reason: null,
    admin_handover_actual_at: null,
    batch_links: [],
    created_at: new Date('2026-11-10T12:00:00.000Z'),
    updated_at: new Date('2026-11-10T12:00:00.000Z'),
  });
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
describe('API GET /api/v1/quote-requests/:id/contact-history (Task 15, UC-14, BR-11) — Comprehensive Test Suite', () => {
  const identityMock = new MockIdentityContract();
  const txRunner = new MockTransactionRunner();

  const mockQuoteRequestRepo = {
    findById: vi.fn(),
    findDetailById: vi.fn(),
  };

  const mockContactEditHistoryRepo = {
    listEventsByRequestId: vi.fn(),
    findEventsWithPagination: vi.fn(),
  };

  const mockAllocationRepo = {
    findByRequestAndWorkshop: vi.fn(),
  };

  let useCase: GetContactHistoryUseCase;
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
      {
        provide: CONTACT_EDIT_HISTORY_REPOSITORY,
        useValue: mockContactEditHistoryRepo,
      },
      { provide: ALLOCATION_REPOSITORY, useValue: mockAllocationRepo },
      {
        provide: GetQuoteRequestByIdUseCase,
        useFactory: (runner: any, repo: any) =>
          new GetQuoteRequestByIdUseCase(runner, repo),
        inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
      },
      {
        provide: GetContactHistoryUseCase,
        useFactory: (
          runner: any,
          qRepo: any,
          cRepo: any,
          aRepo: any,
        ) => new GetContactHistoryUseCase(runner, qRepo, cRepo, aRepo),
        inject: [
          TRANSACTION_RUNNER,
          QUOTE_REQUEST_REPOSITORY,
          CONTACT_EDIT_HISTORY_REPOSITORY,
          ALLOCATION_REPOSITORY,
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

    useCase = new GetContactHistoryUseCase(
      txRunner,
      mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
      mockContactEditHistoryRepo as unknown as IContactEditHistoryRepository,
      mockAllocationRepo as unknown as IAllocationRepository,
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
      if (token === 'session-artisan-allocated') return artisanWithAllocation;
      if (token === 'session-artisan-no-alloc') return artisanWithoutAllocation;
      if (token === 'session-artisan-uninvited') return artisanNotInvited;
      if (token === 'session-temp-buyer') return tempPasswordBuyerActor;
      return null;
    });
  });

  // =========================================================================
  // Suite A: Use Case Unit Tests
  // =========================================================================
  describe('Suite A: GetContactHistoryUseCase (Domain Logic & Invariants)', () => {
    it('TC-UC-01: Buyer owner retrieves contact history successfully (happy path)', async () => {
      const request = createSampleQuoteRequest();
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });

      expect(mockQuoteRequestRepo.findById).toHaveBeenCalledWith('100', expect.anything());
      expect(mockContactEditHistoryRepo.findEventsWithPagination).toHaveBeenCalledWith(
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
          id: '501',
          prev_recipient_name: 'Nguyễn Văn A',
          prev_recipient_phone: '0912345678',
          new_recipient_name: 'Nguyễn Văn B',
          new_recipient_phone: '0912345679',
          version: 2,
        }),
      );
      expect(result.data[0].edited_by).toEqual(
        expect.objectContaining({
          id: '10',
          display_name: 'Buyer Tester',
        }),
      );
      expect(result.data[1].id).toBe('502');
      expect(result.data[1].version).toBe(3);
    });

    it('TC-UC-02: Admin retrieves contact history successfully', async () => {
      const request = createSampleQuoteRequest({ buyer_id: '99' });
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const result = await useCase.execute({
        actor: adminActor,
        requestId: '100',
      });

      expect(result.data).toHaveLength(2);
      expect(result.metadata.pagination?.total_records).toBe(2);
    });

    it('TC-UC-03: Artisan with Allocation retrieves contact history successfully (BR-04)', async () => {
      const request = createSampleQuoteRequest();
      const allocation = createSampleAllocation();
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(allocation);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const result = await useCase.execute({
        actor: artisanWithAllocation,
        requestId: '100',
      });

      expect(mockAllocationRepo.findByRequestAndWorkshop).toHaveBeenCalledWith(
        '100',
        '200',
        expect.anything(),
      );
      expect(result.data).toHaveLength(2);
      expect(result.metadata.pagination?.total_records).toBe(2);
    });

    it('TC-UC-04: Artisan without Allocation receives 404 (SEC-06, BR-04 anti-IDOR)', async () => {
      const request = createSampleQuoteRequest();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(null);

      await expect(
        useCase.execute({
          actor: artisanWithoutAllocation,
          requestId: '100',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('TC-UC-05: Uninvited Artisan (no allocation) receives 404 (SEC-06 anti-IDOR)', async () => {
      const request = createSampleQuoteRequest();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(null);

      await expect(
        useCase.execute({
          actor: artisanNotInvited,
          requestId: '100',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('TC-UC-06: Non-owner Buyer receives 404 QuoteRequestNotFoundError (SEC-06 anti-IDOR)', async () => {
      const request = createSampleQuoteRequest({ buyer_id: '10' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);

      await expect(
        useCase.execute({
          actor: otherBuyerActor,
          requestId: '100',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('TC-UC-07: Temp password session receives 403 TEMP_PASSWORD_RESTRICTED (SEC-05)', async () => {
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

    it('TC-UC-08: Invalid requestId format throws InvalidTradingInputError (400)', async () => {
      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: 'invalid-id',
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

      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('TC-UC-09: Non-existent QuoteRequest throws QuoteRequestNotFoundError (404)', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(null);

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '999999',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('TC-UC-10: Empty history returns empty array with pagination', async () => {
      const request = createSampleQuoteRequest();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });

      expect(result.data).toEqual([]);
      expect(result.data).toHaveLength(0);
      expect(result.metadata.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 0,
        total_pages: 0,
      });
    });

    it('TC-UC-11: ContactEventDto fields match specification (api-dtos.md §2.3)', async () => {
      const request = createSampleQuoteRequest();
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });

      for (const event of result.data) {
        // Required fields per ContactEventDto
        expect(event).toHaveProperty('id');
        expect(event).toHaveProperty('prev_recipient_name');
        expect(event).toHaveProperty('prev_recipient_phone');
        expect(event).toHaveProperty('new_recipient_name');
        expect(event).toHaveProperty('new_recipient_phone');
        expect(event).toHaveProperty('edited_by');
        expect(event).toHaveProperty('edited_at');
        expect(event).toHaveProperty('version');

        // edited_by is ActorDto with { id, display_name }
        expect(event.edited_by).toHaveProperty('id');
        expect(event.edited_by).toHaveProperty('display_name');

        // Types check
        expect(typeof event.id).toBe('string');
        expect(typeof event.prev_recipient_name).toBe('string');
        expect(typeof event.prev_recipient_phone).toBe('string');
        expect(typeof event.new_recipient_name).toBe('string');
        expect(typeof event.new_recipient_phone).toBe('string');
        expect(typeof event.edited_at).toBe('string');
        expect(typeof event.version).toBe('number');
      }
    });

    it('TC-UC-12: Artisan without workshopId receives TradingPermissionDeniedError', async () => {
      const artisanNoWorkshop: AuthenticatedActor = Object.freeze({
        accountId: '50',
        role: 'artisan',
        workshopId: null,
        authVersion: 1,
        sessionId: 'session-artisan-no-ws',
        sessionLevel: 'normal',
      });

      const request = createSampleQuoteRequest();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);

      await expect(
        useCase.execute({
          actor: artisanNoWorkshop,
          requestId: '100',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('TC-UC-13: Lifecycle retention: Buyer owner retrieves contact history when request is cancelled', async () => {
      const cancelledDate = new Date('2026-11-13T10:00:00.000Z');
      const request = createSampleQuoteRequest({
        status: 'cancelled',
        cancelled_at: cancelledDate,
        cancelled_by: '10',
        cancel_reason: 'Buyer cancelled the request',
      });
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });

      expect(result.data).toHaveLength(2);
      expect(result.metadata.pagination?.total_records).toBe(2);
    });

    it('TC-UC-14: Lifecycle retention: Admin retrieves contact history when request is cancelled', async () => {
      const cancelledDate = new Date('2026-11-13T10:00:00.000Z');
      const request = createSampleQuoteRequest({
        buyer_id: '99',
        status: 'cancelled',
        cancelled_at: cancelledDate,
      });
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const result = await useCase.execute({
        actor: adminActor,
        requestId: '100',
      });

      expect(result.data).toHaveLength(2);
    });

    it('TC-UC-15: Lifecycle retention: Won Artisan retrieves contact history when request is cancelled', async () => {
      const cancelledDate = new Date('2026-11-13T10:00:00.000Z');
      const request = createSampleQuoteRequest({
        status: 'cancelled',
        cancelled_at: cancelledDate,
      });
      const allocation = createSampleAllocation();
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(allocation);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const result = await useCase.execute({
        actor: artisanWithAllocation,
        requestId: '100',
      });

      expect(result.data).toHaveLength(2);
    });

    it('TC-UC-16: Lifecycle retention: Buyer owner retrieves contact history when request is delivered', async () => {
      const request = createSampleQuoteRequest({
        status: 'delivered',
      });
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });

      expect(result.data).toHaveLength(2);
    });

    it('TC-UC-17: Lifecycle retention: Admin retrieves contact history when request is delivered', async () => {
      const request = createSampleQuoteRequest({
        buyer_id: '99',
        status: 'delivered',
      });
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const result = await useCase.execute({
        actor: adminActor,
        requestId: '100',
      });

      expect(result.data).toHaveLength(2);
    });

    it('TC-UC-18: Lifecycle retention: Won Artisan retrieves contact history when request is delivered', async () => {
      const request = createSampleQuoteRequest({
        status: 'delivered',
      });
      const allocation = createSampleAllocation();
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(allocation);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const result = await useCase.execute({
        actor: artisanWithAllocation,
        requestId: '100',
      });

      expect(result.data).toHaveLength(2);
    });

    it('TC-UC-19: Custom pagination parameters in use case', async () => {
      const request = createSampleQuoteRequest();
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [events[1]],
        totalRecords: 12,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        query: { page: 2, limit: 5 },
      });

      expect(mockContactEditHistoryRepo.findEventsWithPagination).toHaveBeenCalledWith(
        { requestId: '100', page: 2, limit: 5 },
        expect.anything(),
      );
      expect(result.metadata.pagination).toEqual({
        page: 2,
        limit: 5,
        total_records: 12,
        total_pages: 3,
      });
      expect(result.data).toHaveLength(1);
    });
  });

  // =========================================================================
  // Suite B: HTTP Integration Tests
  // =========================================================================
  describe('Suite B: HTTP GET /api/v1/quote-requests/:id/contact-history (Integration)', () => {
    it('TC-HTTP-01: Buyer owner → 200 with ContactEventDto[] in enveloped pagination', async () => {
      const request = createSampleQuoteRequest();
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 2,
        total_pages: 1,
      });
      expect(body.data[0].id).toBe('501');
      expect(body.data[0].prev_recipient_name).toBe('Nguyễn Văn A');
      expect(body.data[0].new_recipient_name).toBe('Nguyễn Văn B');
      expect(body.data[0].edited_by.id).toBe('10');
      expect(body.data[0].edited_by.display_name).toBe('Buyer Tester');
      expect(body.data[0].version).toBe(2);
    });

    it('TC-HTTP-02: Admin → 200 with ContactEventDto[]', async () => {
      const request = createSampleQuoteRequest({ buyer_id: '99' });
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-admin-1' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.pagination).toBeDefined();
    });

    it('TC-HTTP-03: Artisan with Allocation → 200', async () => {
      const request = createSampleQuoteRequest();
      const allocation = createSampleAllocation();
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(allocation);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-allocated' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.pagination).toBeDefined();
    });

    it('TC-HTTP-04: Artisan without Allocation → 404 RESOURCE_NOT_FOUND', async () => {
      const request = createSampleQuoteRequest();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-no-alloc' },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('TC-HTTP-05: Non-owner Buyer → 404 RESOURCE_NOT_FOUND', async () => {
      const request = createSampleQuoteRequest({ buyer_id: '10' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);

      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-other-buyer' },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('TC-HTTP-06: Non-existent request → 404 RESOURCE_NOT_FOUND', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/quote-requests/999999/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('TC-HTTP-07: Temp password session → 403 TEMP_PASSWORD_RESTRICTED', async () => {
      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-temp-buyer' },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe('TEMP_PASSWORD_RESTRICTED');
    });

    it('TC-HTTP-08: Empty history → 200 with empty data array and pagination', async () => {
      const request = createSampleQuoteRequest();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 0,
        total_pages: 0,
      });
    });

    it('TC-HTTP-09: No auth token → 401 Unauthorized', async () => {
      const res = await fetch(`${base}/quote-requests/100/contact-history`);

      expect(res.status).toBe(401);
    });

    it('TC-HTTP-10: Invalid token → 401 Unauthorized', async () => {
      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=invalid-token' },
      });

      expect(res.status).toBe(401);
    });

    it('TC-HTTP-11: Invalid ID format → 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/abc/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      expect(res.status).toBe(400);
    });

    it('TC-HTTP-12: Response envelope matches { success, data, pagination } structure', async () => {
      const request = createSampleQuoteRequest();
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      const body = await res.json();
      expect(body).toHaveProperty('success', true);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('pagination');
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 2,
        total_pages: 1,
      });

      // Verify ContactEventDto schema for each item
      for (const item of body.data) {
        expect(Object.keys(item).sort()).toEqual(
          [
            'id',
            'prev_recipient_name',
            'prev_recipient_phone',
            'new_recipient_name',
            'new_recipient_phone',
            'edited_by',
            'edited_at',
            'version',
          ].sort(),
        );
        expect(Object.keys(item.edited_by).sort()).toEqual(
          ['id', 'display_name'].sort(),
        );
      }
    });

    it('TC-HTTP-13: Lifecycle retention HTTP: Buyer owner gets 200 for cancelled QuoteRequest', async () => {
      const request = createSampleQuoteRequest({
        status: 'cancelled',
        cancelled_at: new Date('2026-11-13T10:00:00.000Z'),
        cancelled_by: '10',
        cancel_reason: 'Buyer cancelled',
      });
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
    });

    it('TC-HTTP-14: Lifecycle retention HTTP: Admin gets 200 for cancelled QuoteRequest', async () => {
      const request = createSampleQuoteRequest({
        buyer_id: '99',
        status: 'cancelled',
        cancelled_at: new Date('2026-11-13T10:00:00.000Z'),
      });
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-admin-1' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
    });

    it('TC-HTTP-15: Lifecycle retention HTTP: Won Artisan gets 200 for cancelled QuoteRequest', async () => {
      const request = createSampleQuoteRequest({
        status: 'cancelled',
        cancelled_at: new Date('2026-11-13T10:00:00.000Z'),
      });
      const allocation = createSampleAllocation();
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(allocation);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-allocated' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
    });

    it('TC-HTTP-16: Lifecycle retention HTTP: Buyer owner gets 200 for delivered QuoteRequest', async () => {
      const request = createSampleQuoteRequest({
        status: 'delivered',
      });
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
    });

    it('TC-HTTP-17: Lifecycle retention HTTP: Admin gets 200 for delivered QuoteRequest', async () => {
      const request = createSampleQuoteRequest({
        buyer_id: '99',
        status: 'delivered',
      });
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-admin-1' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
    });

    it('TC-HTTP-18: Lifecycle retention HTTP: Won Artisan gets 200 for delivered QuoteRequest', async () => {
      const request = createSampleQuoteRequest({
        status: 'delivered',
      });
      const allocation = createSampleAllocation();
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(allocation);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-allocated' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
    });

    it('TC-HTTP-19: Pagination query params HTTP: default ?page=1&limit=20', async () => {
      const request = createSampleQuoteRequest();
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: 2,
      });

      const res = await fetch(`${base}/quote-requests/100/contact-history?page=1&limit=20`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 2,
        total_pages: 1,
      });
      expect(mockContactEditHistoryRepo.findEventsWithPagination).toHaveBeenCalledWith(
        { requestId: '100', page: 1, limit: 20 },
        expect.anything(),
      );
    });

    it('TC-HTTP-20: Pagination query params HTTP: custom ?page=2&limit=5', async () => {
      const request = createSampleQuoteRequest();
      const events = createSampleContactEvents();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [events[0]],
        totalRecords: 12,
      });

      const res = await fetch(`${base}/quote-requests/100/contact-history?page=2&limit=5`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination).toEqual({
        page: 2,
        limit: 5,
        total_records: 12,
        total_pages: 3,
      });
      expect(mockContactEditHistoryRepo.findEventsWithPagination).toHaveBeenCalledWith(
        { requestId: '100', page: 2, limit: 5 },
        expect.anything(),
      );
    });

    it('TC-HTTP-21: Validation HTTP: Invalid ?page=0 returns 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/100/contact-history?page=0`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('INVALID_INPUT');
    });

    it('TC-HTTP-22: Validation HTTP: Invalid ?limit=101 returns 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/100/contact-history?limit=101`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('INVALID_INPUT');
    });
  });
});
