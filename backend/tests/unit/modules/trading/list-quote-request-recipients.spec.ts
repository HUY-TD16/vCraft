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
  IQuoteRequestRepository,
  IRequestRecipientRepository,
  QUOTE_REQUEST_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
  RequestRecipientDetailItem,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { GetQuoteRequestByIdUseCase } from '../../../../src/modules/trading/application/use-cases/requests/get-quote-request-by-id.use-case';
import { ListQuoteRequestRecipientsUseCase } from '../../../../src/modules/trading/application/use-cases/requests/list-quote-request-recipients.use-case';
import { QuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/quote-request.controller';
import {
  InvalidTradingInputError,
  QuoteRequest,
  QuoteRequestNotFoundError,
  RequestRecipient,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import type { RecipientDto } from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createSampleQuoteRequest(
  overrides: Partial<{
    id: string;
    buyer_id: string;
    status: any;
    cancelled_at: Date | null;
    cancelled_by: string | null;
    version: number;
  }> = {},
): QuoteRequest {
  const cancelled_at = overrides.cancelled_at ?? null;
  const cancelled_by =
    overrides.cancelled_by !== undefined
      ? overrides.cancelled_by
      : cancelled_at !== null
      ? (overrides.buyer_id ?? '10')
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
    cancelled_at,
    cancelled_by,
    cancel_reason: cancelled_at !== null ? 'Buyer đổi kế hoạch' : null,
    created_at: new Date('2026-11-10T10:00:00.000Z'),
    updated_at: new Date('2026-11-10T10:00:00.000Z'),
  });
}

function createSampleRecipients(): RequestRecipientDetailItem[] {
  const sentAt = new Date('2026-11-10T10:05:00.000Z');

  // 1. Pending
  const item1: RequestRecipientDetailItem = {
    entity: RequestRecipient.reconstitute({
      id: '1',
      request_id: '100',
      workshop_id: '201',
      response_status: 'pending',
      decline_reason: null,
      responded_by: null,
      responded_at: null,
      sent_at: sentAt,
      version: 1,
    }),
    workshop: {
      id: '201',
      name: 'Xưởng Gốm Hưng Thịnh',
      status: 'active',
    },
    quote: null,
  };

  // 2. Declined
  const item2: RequestRecipientDetailItem = {
    entity: RequestRecipient.reconstitute({
      id: '2',
      request_id: '100',
      workshop_id: '202',
      response_status: 'declined',
      decline_reason: 'Xưởng đang đầy tải lò nung tháng 11',
      responded_by: '22',
      responded_at: new Date('2026-11-10T14:30:00.000Z'),
      sent_at: sentAt,
      version: 2,
    }),
    workshop: {
      id: '202',
      name: 'Xưởng Gốm Bát Tràng Mỹ Nghệ',
      status: 'active',
    },
    quote: null,
  };

  // 3. Quoted
  const item3: RequestRecipientDetailItem = {
    entity: RequestRecipient.reconstitute({
      id: '3',
      request_id: '100',
      workshop_id: '203',
      response_status: 'quoted',
      decline_reason: null,
      responded_by: '23',
      responded_at: new Date('2026-11-11T09:00:00.000Z'),
      sent_at: sentAt,
      version: 2,
    }),
    workshop: {
      id: '203',
      name: 'Xưởng Gốm Bát Tràng Truyền Thống',
      status: 'active',
    },
    quote: {
      id: '303',
      status: 'active',
      bid_accept_deadline: new Date(Date.now() + 86400000),
    },
  };

  // 4. Withdrawn
  const item4: RequestRecipientDetailItem = {
    entity: RequestRecipient.reconstitute({
      id: '4',
      request_id: '100',
      workshop_id: '204',
      response_status: 'withdrawn',
      decline_reason: null,
      responded_by: '24',
      responded_at: new Date('2026-11-11T16:00:00.000Z'),
      sent_at: sentAt,
      version: 2,
    }),
    workshop: {
      id: '204',
      name: 'Xưởng Gốm Tân Thịnh',
      status: 'active',
    },
    quote: {
      id: '304',
      status: 'withdrawn',
      bid_accept_deadline: new Date(Date.now() + 86400000),
    },
  };

  return [item1, item2, item3, item4];
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
describe('API GET /api/v1/quote-requests/:id/recipients (Task 14, UC-18, BR-13, BR-04) — Comprehensive Test Suite', () => {
  const identityMock = new MockIdentityContract();
  const txRunner = new MockTransactionRunner();

  const mockQuoteRequestRepo = {
    findById: vi.fn(),
    findDetailById: vi.fn(),
  };

  const mockRecipientRepo = {
    findRecipientsWithDetails: vi.fn(),
  };

  let useCase: ListQuoteRequestRecipientsUseCase;
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
        provide: GetQuoteRequestByIdUseCase,
        useFactory: (runner: any, repo: any) =>
          new GetQuoteRequestByIdUseCase(runner, repo),
        inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
      },
      {
        provide: ListQuoteRequestRecipientsUseCase,
        useFactory: (runner: any, qRepo: any, rRepo: any) =>
          new ListQuoteRequestRecipientsUseCase(runner, qRepo, rRepo),
        inject: [
          TRANSACTION_RUNNER,
          QUOTE_REQUEST_REPOSITORY,
          REQUEST_RECIPIENT_REPOSITORY,
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

    useCase = new ListQuoteRequestRecipientsUseCase(
      txRunner,
      mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
      mockRecipientRepo as unknown as IRequestRecipientRepository,
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
      return null;
    });
  });

  // =========================================================================
  // Suite A: Use Case Unit Tests
  // =========================================================================
  describe('Suite A: ListQuoteRequestRecipientsUseCase (Domain Logic & Invariants)', () => {
    it('TC-UC-01: Buyer owner retrieves recipients successfully (happy path)', async () => {
      const request = createSampleQuoteRequest();
      const recipients = createSampleRecipients();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: recipients,
        totalRecords: recipients.length,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        query: { page: 1, limit: 20 },
      });

      expect(mockQuoteRequestRepo.findById).toHaveBeenCalledWith('100', expect.anything());
      expect(mockRecipientRepo.findRecipientsWithDetails).toHaveBeenCalledWith(
        {
          requestId: '100',
          responseStatus: undefined,
          page: 1,
          limit: 20,
        },
        expect.anything(),
      );

      expect(result).toBeInstanceOf(HttpResult);
      expect(result.data.length).toBe(4);
      expect(result.metadata.pagination?.total_records).toBe(4);
      expect(result.metadata.pagination?.total_pages).toBe(1);
      expect(result.metadata.pagination?.page).toBe(1);
      expect(result.metadata.pagination?.limit).toBe(20);

      // Data masking verification: workshop only has { id, name }
      for (const item of result.data) {
        expect(item.workshop).toHaveProperty('id');
        expect(item.workshop).toHaveProperty('name');
        expect((item.workshop as any).address).toBeUndefined();
        expect((item.workshop as any).phone).toBeUndefined();
      }
    });

    it('TC-UC-02: Admin retrieves recipients successfully (admin happy path)', async () => {
      const request = createSampleQuoteRequest({ buyer_id: '99' }); // Belongs to different buyer
      const recipients = createSampleRecipients();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: recipients,
        totalRecords: recipients.length,
      });

      const result = await useCase.execute({
        actor: adminActor,
        requestId: '100',
      });

      expect(result.data.length).toBe(4);
      expect(result.metadata.pagination?.total_records).toBe(4);
      expect(result.metadata.pagination?.total_pages).toBe(1);
    });

    it('TC-UC-03: Non-owner Buyer receives 404 QuoteRequestNotFoundError (SEC-06 anti-IDOR)', async () => {
      const request = createSampleQuoteRequest({ buyer_id: '10' }); // Belongs to buyer 10
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);

      await expect(
        useCase.execute({
          actor: otherBuyerActor, // buyer 99
          requestId: '100',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(mockRecipientRepo.findRecipientsWithDetails).not.toHaveBeenCalled();
    });

    it('TC-UC-04: Artisan receives 403 TradingPermissionDeniedError (BR-04, UC-18)', async () => {
      const request = createSampleQuoteRequest();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);

      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '100',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(mockRecipientRepo.findRecipientsWithDetails).not.toHaveBeenCalled();
    });

    it('TC-UC-05: Temp password session receives 403 TEMP_PASSWORD_RESTRICTED (SEC-05)', async () => {
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

    it('TC-UC-06: Invalid requestId format throws InvalidTradingInputError (400)', async () => {
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

    it('TC-UC-07: Non-existent QuoteRequest throws QuoteRequestNotFoundError (404)', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(null);

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '999999',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(mockRecipientRepo.findRecipientsWithDetails).not.toHaveBeenCalled();
    });

    it('TC-UC-08: Status filter is passed to repository correctly', async () => {
      const request = createSampleQuoteRequest();
      const allRecipients = createSampleRecipients();
      const quotedOnly = allRecipients.filter(
        (r) => r.entity.response_status === 'quoted',
      );

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: quotedOnly,
        totalRecords: 1,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        query: { response_status: 'quoted' },
      });

      expect(mockRecipientRepo.findRecipientsWithDetails).toHaveBeenCalledWith(
        expect.objectContaining({ responseStatus: 'quoted' }),
        expect.anything(),
      );
      expect(result.data.length).toBe(1);
      expect(result.data[0].response_status).toBe('quoted');
    });

    it('TC-UC-09: Empty recipient list returns empty array with totalRecords = 0', async () => {
      const request = createSampleQuoteRequest({ status: 'draft_request' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });

      expect(result.data).toEqual([]);
      expect(result.metadata.pagination?.total_records).toBe(0);
      expect(result.metadata.pagination?.total_pages).toBe(0);
    });

    it('TC-UC-10: Eligibility labels calculation covers all documented scenarios', async () => {
      const request = createSampleQuoteRequest({
        cancelled_at: new Date('2026-11-12T10:00:00.000Z'),
        status: 'buyer_accepted',
      });

      const suspendedWorkshopItem: RequestRecipientDetailItem = {
        entity: RequestRecipient.reconstitute({
          id: '10',
          request_id: '100',
          workshop_id: '210',
          response_status: 'quoted',
          decline_reason: null,
          responded_by: '25',
          responded_at: new Date('2026-11-10T12:00:00.000Z'),
          sent_at: new Date('2026-11-10T10:00:00.000Z'),
          version: 1,
        }),
        workshop: {
          id: '210',
          name: 'Xưởng Gốm Tạm Ngừng',
          status: 'suspended',
        },
        quote: {
          id: '310',
          status: 'active',
          bid_accept_deadline: new Date('2026-11-01T00:00:00.000Z'), // Expired
        },
      };

      const withdrawnItem: RequestRecipientDetailItem = {
        entity: RequestRecipient.reconstitute({
          id: '11',
          request_id: '100',
          workshop_id: '211',
          response_status: 'withdrawn',
          decline_reason: null,
          responded_by: '26',
          responded_at: new Date('2026-11-11T12:00:00.000Z'),
          sent_at: new Date('2026-11-10T10:00:00.000Z'),
          version: 2,
        }),
        workshop: {
          id: '211',
          name: 'Xưởng Gốm Bình An',
          status: 'active',
        },
        quote: {
          id: '311',
          status: 'withdrawn',
          bid_accept_deadline: new Date(Date.now() + 86400000),
        },
      };

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: [suspendedWorkshopItem, withdrawnItem],
        totalRecords: 2,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });

      const firstLabels = result.data[0].eligibility_labels;
      expect(firstLabels).toContain('REQUEST_CANCELLED');
      expect(firstLabels).toContain('REQUEST_ACCEPTED');
      expect(firstLabels).toContain('WORKSHOP_SUSPENDED');
      expect(firstLabels).toContain('QUOTE_EXPIRED');

      const secondLabels = result.data[1].eligibility_labels;
      expect(secondLabels).toContain('REQUEST_CANCELLED');
      expect(secondLabels).toContain('REQUEST_ACCEPTED');
      expect(secondLabels).toContain('QUOTE_WITHDRAWN');
    });
  });

  // =========================================================================
  // Suite B: Controller HTTP Pipeline Integration Tests
  // =========================================================================
  describe('Suite B: Controller HTTP Pipeline Integration Tests (Real fetch & Cookies)', () => {
    it('TC-HTTP-01: Happy Path: Buyer owner gets recipient list with 200 OK and enveloped response', async () => {
      const request = createSampleQuoteRequest();
      const recipients = createSampleRecipients();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: recipients,
        totalRecords: recipients.length,
      });

      const res = await fetch(`${base}/quote-requests/100/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data.length).toBe(4);
      expect(json.pagination).toBeDefined();
      expect(json.pagination.page).toBe(1);
      expect(json.pagination.limit).toBe(20);
      expect(json.pagination.total_records).toBe(4);
      expect(json.pagination.total_pages).toBe(1);
    });

    it('TC-HTTP-02: Happy Path: Admin gets recipient list for any request with 200 OK', async () => {
      const request = createSampleQuoteRequest({ buyer_id: '999' });
      const recipients = createSampleRecipients();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: recipients,
        totalRecords: recipients.length,
      });

      const res = await fetch(`${base}/quote-requests/100/recipients`, {
        headers: { Cookie: 'vcraft-session=session-admin-1' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.length).toBe(4);
    });

    it('TC-HTTP-03: Authorization: Non-owner Buyer rejected with 404 RESOURCE_NOT_FOUND (SEC-06 anti-IDOR)', async () => {
      const request = createSampleQuoteRequest({ buyer_id: '10' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);

      const res = await fetch(`${base}/quote-requests/100/recipients`, {
        headers: { Cookie: 'vcraft-session=session-other-buyer' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
      expect(json.status).toBe(404);
      expect(json.type).toContain('RESOURCE_NOT_FOUND');
    });

    it('TC-HTTP-04: Authorization: Artisan rejected with 403 PERMISSION_DENIED via RolesGuard', async () => {
      const res = await fetch(`${base}/quote-requests/100/recipients`, {
        headers: { Cookie: 'vcraft-session=session-artisan-1' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
      expect(json.status).toBe(403);
    });

    it('TC-HTTP-05: Unauthenticated request rejected with 401 AUTHENTICATION_REQUIRED', async () => {
      const res = await fetch(`${base}/quote-requests/100/recipients`);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
      expect(json.status).toBe(401);
    });

    it('TC-HTTP-06: Non-existent QuoteRequest returns 404 RESOURCE_NOT_FOUND', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/quote-requests/999999/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
      expect(json.status).toBe(404);
    });

    it('TC-HTTP-07: Malformed path parameter returns 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/not-a-number/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.status).toBe(400);
    });

    it('TC-HTTP-08: Temp password session rejected with 403 TEMP_PASSWORD_RESTRICTED', async () => {
      const res = await fetch(`${base}/quote-requests/100/recipients`, {
        headers: { Cookie: 'vcraft-session=session-temp-buyer' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
      expect(json.status).toBe(403);
    });

    it('TC-HTTP-09: All 4 recipient response statuses verified in response payload', async () => {
      const request = createSampleQuoteRequest();
      const recipients = createSampleRecipients();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: recipients,
        totalRecords: recipients.length,
      });

      const res = await fetch(`${base}/quote-requests/100/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      const items: RecipientDto[] = json.data;

      // 1. Pending verification
      const pendingItem = items.find((i) => i.response_status === 'pending');
      expect(pendingItem).toBeDefined();
      expect(pendingItem?.responded_at).toBeNull();
      expect(pendingItem?.decline_reason).toBeNull();

      // 2. Declined verification
      const declinedItem = items.find((i) => i.response_status === 'declined');
      expect(declinedItem).toBeDefined();
      expect(declinedItem?.decline_reason).toBe('Xưởng đang đầy tải lò nung tháng 11');
      expect(declinedItem?.responded_at).not.toBeNull();

      // 3. Quoted verification
      const quotedItem = items.find((i) => i.response_status === 'quoted');
      expect(quotedItem).toBeDefined();
      expect(quotedItem?.responded_at).not.toBeNull();
      expect(quotedItem?.decline_reason).toBeNull();

      // 4. Withdrawn verification
      const withdrawnItem = items.find((i) => i.response_status === 'withdrawn');
      expect(withdrawnItem).toBeDefined();
      expect(withdrawnItem?.eligibility_labels).toContain('QUOTE_WITHDRAWN');

      // Strict data masking check across all items
      for (const item of items) {
        expect(item.workshop).toEqual({
          id: expect.any(String),
          name: expect.any(String),
        });
        expect((item as any).unit_price).toBeUndefined();
        expect((item as any).recipient_phone).toBeUndefined();
      }
    });

    it('TC-HTTP-10: Query filter ?response_status=declined returns filtered recipients', async () => {
      const request = createSampleQuoteRequest();
      const allRecipients = createSampleRecipients();
      const declinedOnly = allRecipients.filter(
        (r) => r.entity.response_status === 'declined',
      );

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: declinedOnly,
        totalRecords: 1,
      });

      const res = await fetch(
        `${base}/quote-requests/100/recipients?response_status=declined`,
        {
          headers: { Cookie: 'vcraft-session=session-buyer-1' },
        },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.length).toBe(1);
      expect(json.data[0].response_status).toBe('declined');
      expect(mockRecipientRepo.findRecipientsWithDetails).toHaveBeenCalledWith(
        expect.objectContaining({ responseStatus: 'declined' }),
        expect.anything(),
      );
    });

    it('TC-HTTP-11: Pagination metadata verified with page=2&limit=2', async () => {
      const request = createSampleQuoteRequest();
      const allRecipients = createSampleRecipients();
      const pagedRecipients = allRecipients.slice(2, 4);

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: pagedRecipients,
        totalRecords: 4,
      });

      const res = await fetch(
        `${base}/quote-requests/100/recipients?page=2&limit=2`,
        {
          headers: { Cookie: 'vcraft-session=session-buyer-1' },
        },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.length).toBe(2);
      expect(json.pagination.page).toBe(2);
      expect(json.pagination.limit).toBe(2);
      expect(json.pagination.total_records).toBe(4);
      expect(json.pagination.total_pages).toBe(2);
    });

    it('TC-HTTP-12: Invalid response_status query parameter returns 400 INVALID_INPUT', async () => {
      const res = await fetch(
        `${base}/quote-requests/100/recipients?response_status=invalid_status`,
        {
          headers: { Cookie: 'vcraft-session=session-buyer-1' },
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.status).toBe(400);
    });
  });
});
