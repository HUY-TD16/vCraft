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
  EntityId,
  InvalidTradingInputError,
  QuoteRequest,
  QuoteRequestNotFoundError,
  RequestRecipient,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('Adversarial Verification Suite: Task 14 — GET /api/v1/quote-requests/:id/recipients (UC-18, BR-13, BR-04)', () => {
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

  const buyerActor: AuthenticatedActor = Object.freeze({
    accountId: '10',
    role: 'buyer',
    workshopId: null,
    authVersion: 1,
    sessionId: 'session-buyer-adversarial',
    sessionLevel: 'normal',
  });

  const otherBuyerActor: AuthenticatedActor = Object.freeze({
    accountId: '99',
    role: 'buyer',
    workshopId: null,
    authVersion: 1,
    sessionId: 'session-other-buyer-adversarial',
    sessionLevel: 'normal',
  });

  const adminActor: AuthenticatedActor = Object.freeze({
    accountId: '1',
    role: 'admin',
    workshopId: null,
    authVersion: 1,
    sessionId: 'session-admin-adversarial',
    sessionLevel: 'normal',
  });

  const artisanActor: AuthenticatedActor = Object.freeze({
    accountId: '20',
    role: 'artisan',
    workshopId: '200',
    authVersion: 1,
    sessionId: 'session-artisan-adversarial',
    sessionLevel: 'normal',
  });

  const tempPasswordBuyerActor: AuthenticatedActor = Object.freeze({
    accountId: '10',
    role: 'buyer',
    workshopId: null,
    authVersion: 1,
    sessionId: 'session-temp-password-adversarial',
    sessionLevel: 'temp_password',
  });

  function createValidQuoteRequest(id: string = '100', buyerId: string = '10'): QuoteRequest {
    return QuoteRequest.reconstitute({
      id,
      buyer_id: buyerId,
      category_id: '1',
      spec: 'Adversarial Test Quote Request Spec',
      quantity: 100,
      unit: 'cái',
      unit_set_description: null,
      status: 'sent_to_artisans',
      delivery_mode: 'at_buyer_address',
      delivery_region: 'Hà Nội',
      delivery_address: '123 Hoàn Kiếm, Hà Nội',
      recipient_name: 'Trần Văn B',
      recipient_phone: '0901234567',
      bidding_deadline: new Date(Date.now() + 86400000 * 2),
      delivery_deadline: new Date(Date.now() + 86400000 * 10),
      bidding_closed_at: null,
      version: 1,
      cancelled_at: null,
      cancelled_by: null,
      cancel_reason: null,
      created_at: new Date('2026-11-10T10:00:00.000Z'),
      updated_at: new Date('2026-11-10T10:00:00.000Z'),
    });
  }

  function createMockRecipients(): RequestRecipientDetailItem[] {
    return [
      {
        entity: RequestRecipient.reconstitute({
          id: '1',
          request_id: '100',
          workshop_id: '201',
          response_status: 'pending',
          decline_reason: null,
          responded_by: null,
          responded_at: null,
          sent_at: new Date('2026-11-10T10:00:00.000Z'),
          version: 1,
        }),
        workshop: {
          id: '201',
          name: 'Xưởng Gốm Thăng Long',
          status: 'active',
        },
        quote: null,
      },
    ];
  }

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
      if (token === 'session-buyer-adversarial') return buyerActor;
      if (token === 'session-other-buyer-adversarial') return otherBuyerActor;
      if (token === 'session-admin-adversarial') return adminActor;
      if (token === 'session-artisan-adversarial') return artisanActor;
      if (token === 'session-temp-password-adversarial') return tempPasswordBuyerActor;
      return null;
    });
  });

  // Helper to assert strict RFC 9457 Problem Details Envelope
  async function assertRfc9457Error(
    res: Response,
    expectedStatus: number,
    expectedCode: string,
  ): Promise<any> {
    expect(res.status).toBe(expectedStatus);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('application/problem+json');

    const json = await res.json();
    expect(json).toBeDefined();
    expect(typeof json.type).toBe('string');
    expect(json.type).toBe(`urn:vcraft:problem:${expectedCode}`);
    expect(typeof json.title).toBe('string');
    expect(json.title.length).toBeGreaterThan(0);
    expect(json.status).toBe(expectedStatus);
    expect(typeof json.detail).toBe('string');
    expect(json.detail.length).toBeGreaterThan(0);
    expect(json.code).toBe(expectedCode);
    expect(typeof json.tracking_id).toBe('string');
    expect(json.tracking_id).toMatch(UUID_V4_REGEX);

    const xRequestId = res.headers.get('x-request-id');
    if (xRequestId) {
      expect(xRequestId).toBe(json.tracking_id);
    }

    return json;
  }

  // =========================================================================
  // Section 1: Boundary Value Analysis on Path Parameter :id
  // =========================================================================
  describe('1. Path Parameter (:id) Boundary Value Analysis', () => {
    it('ADV-ID-01: Zero ("0") is rejected with 400 INVALID_INPUT and RFC 9457 envelope', async () => {
      const res = await fetch(`${base}/quote-requests/0/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      const problem = await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(problem.detail).toContain('Kiểm tra lại dữ liệu đã gửi');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('ADV-ID-02: Negative integer ("-1") is rejected with 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/-1/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('ADV-ID-03: Extreme negative integer ("-9223372036854775808") is rejected with 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/-9223372036854775808/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('ADV-ID-04: Maximum 64-bit signed integer ("9223372036854775807") is accepted at boundary', async () => {
      const maxId = '9223372036854775807';
      const request = createValidQuoteRequest(maxId, buyerActor.accountId);
      const recipients = createMockRecipients();

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: recipients,
        totalRecords: recipients.length,
      });

      const res = await fetch(`${base}/quote-requests/${maxId}/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(mockQuoteRequestRepo.findById).toHaveBeenCalledWith(maxId, expect.anything());
    });

    it('ADV-ID-05: 64-bit integer overflow ("9223372036854775808") is rejected with 400 INVALID_INPUT', async () => {
      const overflowId = '9223372036854775808';
      const res = await fetch(`${base}/quote-requests/${overflowId}/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('ADV-ID-06: Huge number overflow ("999999999999999999999999999999") is rejected with 400 INVALID_INPUT', async () => {
      const hugeId = '999999999999999999999999999999';
      const res = await fetch(`${base}/quote-requests/${hugeId}/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('ADV-ID-07: Floating point string ("123.45") is rejected with 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/123.45/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('ADV-ID-08: Leading zero string ("0123") is rejected with 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/0123/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('ADV-ID-09: Non-numeric strings ("abc", "NaN", "null", "undefined") rejected with 400 INVALID_INPUT', async () => {
      for (const nonNum of ['abc', 'NaN', 'null', 'undefined', '100a']) {
        const res = await fetch(`${base}/quote-requests/${nonNum}/recipients`, {
          headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
        });
        await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      }
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('ADV-ID-10: SQL injection payload is safely rejected with 400 INVALID_INPUT', async () => {
      const sqli = encodeURIComponent("100 OR 1=1; DROP TABLE quote_requests;--");
      const res = await fetch(`${base}/quote-requests/${sqli}/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Section 2: Boundary Value Analysis on Query Parameters (page, limit, response_status)
  // =========================================================================
  describe('2. Query Parameters Boundary Value Analysis', () => {
    it('ADV-QP-01: page=0 is rejected with 400 INVALID_INPUT and error pointer /page', async () => {
      const res = await fetch(`${base}/quote-requests/100/recipients?page=0`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      const problem = await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(Array.isArray(problem.errors)).toBe(true);
      expect(problem.errors.some((e: any) => e.field === '/page')).toBe(true);
    });

    it('ADV-QP-02: page=-1 is rejected with 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/100/recipients?page=-1`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      const problem = await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(problem.errors.some((e: any) => e.field === '/page')).toBe(true);
    });

    it('ADV-QP-03: page=string ("abc", "1.5") is rejected with 400 INVALID_INPUT', async () => {
      for (const val of ['abc', '1.5', 'one']) {
        const res = await fetch(`${base}/quote-requests/100/recipients?page=${val}`, {
          headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
        });
        const problem = await assertRfc9457Error(res, 400, 'INVALID_INPUT');
        expect(problem.errors.some((e: any) => e.field === '/page')).toBe(true);
      }
    });

    it('ADV-QP-04: limit=0 is rejected with 400 INVALID_INPUT and error pointer /limit', async () => {
      const res = await fetch(`${base}/quote-requests/100/recipients?limit=0`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      const problem = await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(problem.errors.some((e: any) => e.field === '/limit')).toBe(true);
    });

    it('ADV-QP-05: limit=-1 is rejected with 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/100/recipients?limit=-1`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      const problem = await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(problem.errors.some((e: any) => e.field === '/limit')).toBe(true);
    });

    it('ADV-QP-06: limit=100 (PAGINATION.maxLimit upper bound) is accepted with 200 OK', async () => {
      const request = createValidQuoteRequest();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const res = await fetch(`${base}/quote-requests/100/recipients?limit=100`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.pagination.limit).toBe(100);
      expect(mockRecipientRepo.findRecipientsWithDetails).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
        expect.anything(),
      );
    });

    it('ADV-QP-07: limit=101 (exceeds PAGINATION.maxLimit) is rejected with 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/100/recipients?limit=101`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      const problem = await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(problem.errors.some((e: any) => e.field === '/limit')).toBe(true);
    });

    it('ADV-QP-08: limit=string ("abc", "10.5") is rejected with 400 INVALID_INPUT', async () => {
      for (const val of ['abc', '10.5', 'max']) {
        const res = await fetch(`${base}/quote-requests/100/recipients?limit=${val}`, {
          headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
        });
        const problem = await assertRfc9457Error(res, 400, 'INVALID_INPUT');
        expect(problem.errors.some((e: any) => e.field === '/limit')).toBe(true);
      }
    });

    it('ADV-QP-09: response_status uppercase ("PENDING", "DECLINED", "QUOTED", "WITHDRAWN") rejected with 400 INVALID_INPUT', async () => {
      for (const val of ['PENDING', 'Pending', 'DECLINED', 'Declined', 'QUOTED', 'Quoted', 'WITHDRAWN', 'Withdrawn']) {
        const res = await fetch(`${base}/quote-requests/100/recipients?response_status=${val}`, {
          headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
        });
        const problem = await assertRfc9457Error(res, 400, 'INVALID_INPUT');
        expect(problem.errors.some((e: any) => e.field === '/response_status')).toBe(true);
      }
    });

    it('ADV-QP-10: response_status unknown enum values ("accepted", "cancelled", "garbage") rejected with 400 INVALID_INPUT', async () => {
      for (const val of ['accepted', 'cancelled', 'in_progress', 'draft', 'rejected', 'garbage', '123', 'true']) {
        const res = await fetch(`${base}/quote-requests/100/recipients?response_status=${val}`, {
          headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
        });
        const problem = await assertRfc9457Error(res, 400, 'INVALID_INPUT');
        expect(problem.errors.some((e: any) => e.field === '/response_status')).toBe(true);
      }
    });

    it('ADV-QP-11: Empty response_status ("?response_status=") rejected with 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/100/recipients?response_status=`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      const problem = await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(problem.errors.some((e: any) => e.field === '/response_status')).toBe(true);
    });

    it('ADV-QP-12: Unrecognized query parameters rejected with 400 INVALID_INPUT (strict schema)', async () => {
      const res = await fetch(`${base}/quote-requests/100/recipients?unexpected_filter=123`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      const problem = await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(problem.errors.some((e: any) => e.field === '/unexpected_filter')).toBe(true);
    });
  });

  // =========================================================================
  // Section 3: Error Envelope Conformance (RFC 9457 Problem Details)
  // =========================================================================
  describe('3. RFC 9457 Problem Details Envelope Conformance', () => {
    it('ADV-ENV-01: 401 AUTHENTICATION_REQUIRED has valid RFC 9457 envelope', async () => {
      const res = await fetch(`${base}/quote-requests/100/recipients`);
      await assertRfc9457Error(res, 401, 'AUTHENTICATION_REQUIRED');
    });

    it('ADV-ENV-02: 403 PERMISSION_DENIED (Artisan role) has valid RFC 9457 envelope', async () => {
      const res = await fetch(`${base}/quote-requests/100/recipients`, {
        headers: { Cookie: 'vcraft-session=session-artisan-adversarial' },
      });
      await assertRfc9457Error(res, 403, 'PERMISSION_DENIED');
    });

    it('ADV-ENV-03: 403 TEMP_PASSWORD_RESTRICTED has valid RFC 9457 envelope', async () => {
      const res = await fetch(`${base}/quote-requests/100/recipients`, {
        headers: { Cookie: 'vcraft-session=session-temp-password-adversarial' },
      });
      await assertRfc9457Error(res, 403, 'TEMP_PASSWORD_RESTRICTED');
    });

    it('ADV-ENV-04: 404 RESOURCE_NOT_FOUND (Non-existent request) has valid RFC 9457 envelope', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/quote-requests/999999/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      await assertRfc9457Error(res, 404, 'RESOURCE_NOT_FOUND');
    });

    it('ADV-ENV-05: 404 RESOURCE_NOT_FOUND (Anti-IDOR: Buyer accessing other buyer request) has valid RFC 9457 envelope', async () => {
      const request = createValidQuoteRequest('100', '999'); // Belongs to buyer 999
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);

      const res = await fetch(`${base}/quote-requests/100/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' }, // Buyer 10
      });
      await assertRfc9457Error(res, 404, 'RESOURCE_NOT_FOUND');
    });

    it('ADV-ENV-06: 400 INVALID_INPUT (Validation Pipe) contains structured errors array in RFC 9457 envelope', async () => {
      const res = await fetch(`${base}/quote-requests/100/recipients?page=0&limit=999&response_status=INVALID`, {
        headers: { Cookie: 'vcraft-session=session-buyer-adversarial' },
      });
      const problem = await assertRfc9457Error(res, 400, 'INVALID_INPUT');
      expect(Array.isArray(problem.errors)).toBe(true);
      expect(problem.errors.length).toBeGreaterThanOrEqual(3);
      const fields = problem.errors.map((e: any) => e.field);
      expect(fields).toContain('/page');
      expect(fields).toContain('/limit');
      expect(fields).toContain('/response_status');
    });
  });

  // =========================================================================
  // Section 4: Use Case & Domain EntityId Boundary Stress
  // =========================================================================
  describe('4. Direct Domain EntityId & Use Case Stress Tests', () => {
    it('ADV-DOM-01: EntityId boundaries verified', () => {
      expect(() => EntityId.of('0')).toThrow(InvalidTradingInputError);
      expect(() => EntityId.of('-1')).toThrow(InvalidTradingInputError);
      expect(() => EntityId.of('9223372036854775807')).not.toThrow();
      expect(EntityId.of('9223372036854775807').value).toBe('9223372036854775807');
      expect(() => EntityId.of('9223372036854775808')).toThrow(InvalidTradingInputError);
      expect(() => EntityId.of('abc')).toThrow(InvalidTradingInputError);
      expect(() => EntityId.of('0123')).toThrow(InvalidTradingInputError);
      expect(() => EntityId.of('1.23')).toThrow(InvalidTradingInputError);
    });

    it('ADV-DOM-02: UseCase rejects Artisan actor directly with TradingPermissionDeniedError', async () => {
      const request = createValidQuoteRequest('100', '10');
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '100',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('ADV-DOM-03: UseCase rejects temp_password actor directly with TradingDomainError', async () => {
      await expect(
        useCase.execute({
          actor: tempPasswordBuyerActor,
          requestId: '100',
        }),
      ).rejects.toThrow(TradingDomainError);
    });

    it('ADV-DOM-04: Admin actor can access quote request of any buyer', async () => {
      const request = createValidQuoteRequest('100', '999'); // Belongs to buyer 999
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const result = await useCase.execute({
        actor: adminActor,
        requestId: '100',
      });

      expect(result.data).toEqual([]);
      expect(mockQuoteRequestRepo.findById).toHaveBeenCalledWith('100', expect.anything());
    });
  });
});
