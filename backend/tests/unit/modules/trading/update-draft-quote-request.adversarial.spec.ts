import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { configureHttp } from '../../../../src/bootstrap/configure-http';
import { AppLogger } from '../../../../src/common/observability/app-logger';
import { AppConfigModule } from '../../../../src/common/config/app-config';
import { SecurityModule } from '../../../../src/common/security/security.module';
import { IDENTITY_CONTRACT } from '../../../../src/modules/identity/public/contracts/identity.contract';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import { TRANSACTION_RUNNER } from '../../../../src/common/application/ports/transaction-runner';
import { QUOTE_REQUEST_REPOSITORY } from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { CreateDraftQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/create-draft-quote-request.use-case';
import { UpdateDraftQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/update-draft-quote-request.use-case';
import { BuyerQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/buyer-quote-request.controller';
import {
  QuoteRequest,
  type QuoteRequestProps,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';

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

const artisanActor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '200',
  authVersion: 1,
  sessionId: 'session-artisan-1',
  sessionLevel: 'normal',
});

function createSampleDraftQuoteRequest(
  overrides: Partial<QuoteRequestProps> = {},
): QuoteRequest {
  const now = new Date('2026-11-10T10:00:00.000Z');
  return QuoteRequest.reconstitute({
    id: '100',
    buyer_id: '10',
    category_id: '1',
    spec: 'Initial Spec',
    quantity: 100,
    unit: 'piece',
    unit_set_description: null,
    status: 'draft_request',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'HN',
    delivery_address: '123 Street',
    recipient_name: 'Nguyen Van An',
    recipient_phone: '0987654321',
    bidding_deadline: new Date('2026-12-01T10:00:00.000Z'),
    delivery_deadline: new Date('2026-12-15T10:00:00.000Z'),
    bidding_closed_at: null,
    split_requested_at: null,
    version: 1,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

const identityMock = new MockIdentityContract();
let currentQuoteRequest: QuoteRequest | null = null;

const mockRepo = {
  createDraft: vi.fn(),
  lockById: vi.fn().mockImplementation(async (id: string) => {
    if (currentQuoteRequest && currentQuoteRequest.id === id) {
      return currentQuoteRequest;
    }
    return null;
  }),
  update: vi.fn().mockImplementation(async ({ request }: { request: QuoteRequest }) => {
    currentQuoteRequest = request;
    return request;
  }),
};

class TestIdentityModule {}
Module({
  providers: [{ provide: IDENTITY_CONTRACT, useValue: identityMock }],
  exports: [IDENTITY_CONTRACT],
})(TestIdentityModule);

class TestTradingModule {}
Module({
  imports: [AppConfigModule, SecurityModule.register([TestIdentityModule])],
  controllers: [BuyerQuoteRequestController],
  providers: [
    { provide: TRANSACTION_RUNNER, useClass: MockTransactionRunner },
    { provide: QUOTE_REQUEST_REPOSITORY, useValue: mockRepo },
    {
      provide: CreateDraftQuoteRequestUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new CreateDraftQuoteRequestUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
    {
      provide: UpdateDraftQuoteRequestUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new UpdateDraftQuoteRequestUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
  ],
})(TestTradingModule);

describe('Adversarial Verification: PUT /buyer/quote-requests/:id', () => {
  let app: NestExpressApplication;
  let base: string;

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/test');
    vi.stubEnv('SESSION_SECRET', 'test_secret_32_chars_for_development_purposes');
    vi.stubEnv('NODE_ENV', 'development');

    app = await NestFactory.create<NestExpressApplication>(TestTradingModule, {
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

  describe('1. Zod strictObject & Input Validation Attacks', () => {
    it('rejects unexpected extra field { unexpected_field: "exploit" } with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          unexpected_field: 'exploit',
        }),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const json = await res.json();
      expect(json).toMatchObject({
        type: 'urn:vcraft:problem:INVALID_INPUT',
        status: 400,
        code: 'INVALID_INPUT',
      });
      expect(json.tracking_id).toBeDefined();
      expect(json.errors.some((e: any) => e.field === '/unexpected_field')).toBe(true);
    });

    it('rejects expected_request_version = 0 with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 0,
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors.some((e: any) => e.field === '/expected_request_version')).toBe(true);
    });

    it('rejects expected_request_version = -1 with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: -1,
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors.some((e: any) => e.field === '/expected_request_version')).toBe(true);
    });

    it('rejects non-integer expected_request_version (1.5) with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1.5,
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors.some((e: any) => e.field === '/expected_request_version')).toBe(true);
    });

    it('rejects invalid date format for bidding_deadline ("invalid-date") with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          bidding_deadline: 'invalid-date',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors.some((e: any) => e.field === '/bidding_deadline')).toBe(true);
    });

    it('rejects date format without timezone offset ("2026-12-01T10:00:00") with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          bidding_deadline: '2026-12-01T10:00:00', // Missing offset
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors.some((e: any) => e.field === '/bidding_deadline')).toBe(true);
    });

    it('rejects invalid date format for delivery_deadline ("2026/12/15 10:00") with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          delivery_deadline: '2026/12/15 10:00',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors.some((e: any) => e.field === '/delivery_deadline')).toBe(true);
    });

    it('rejects quantity = 0 with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          quantity: 0,
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors.some((e: any) => e.field === '/quantity')).toBe(true);
    });

    it('rejects quantity = -5 with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          quantity: -5,
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors.some((e: any) => e.field === '/quantity')).toBe(true);
    });

    it('rejects invalid unit ("box") with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          unit: 'box',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors.some((e: any) => e.field === '/unit')).toBe(true);
    });

    it('rejects invalid unit ("kg") with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          unit: 'kg',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors.some((e: any) => e.field === '/unit')).toBe(true);
    });

    it('rejects invalid delivery_mode ("express") with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          delivery_mode: 'express',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors.some((e: any) => e.field === '/delivery_mode')).toBe(true);
    });

    it('rejects invalid category_id ("abc" non-numeric) with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          category_id: 'abc',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors.some((e: any) => e.field === '/category_id')).toBe(true);
    });
  });

  describe('2. Security & Authentication Checks', () => {
    it('returns HTTP 401 AUTHENTICATION_REQUIRED for unauthenticated requests', async () => {
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expected_request_version: 1,
        }),
      });

      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const json = await res.json();
      expect(json).toMatchObject({
        type: 'urn:vcraft:problem:AUTHENTICATION_REQUIRED',
        status: 401,
        code: 'AUTHENTICATION_REQUIRED',
      });
      expect(json.tracking_id).toBeDefined();
    });

    it('returns HTTP 403 PERMISSION_DENIED when authenticated as artisan role', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-artisan-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
        }),
      });

      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const json = await res.json();
      expect(json).toMatchObject({
        type: 'urn:vcraft:problem:PERMISSION_DENIED',
        status: 403,
        code: 'PERMISSION_DENIED',
      });
      expect(json.tracking_id).toBeDefined();
    });

    it('returns HTTP 403 PERMISSION_DENIED when authenticated as buyer but accessing another buyer request', async () => {
      currentQuoteRequest = createSampleDraftQuoteRequest({ id: '100', buyer_id: '10', version: 1 });
      identityMock.resolveSession.mockResolvedValueOnce(otherBuyerActor); // accountId: '99'

      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-other-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          spec: 'Malicious modification attempt',
        }),
      });

      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const json = await res.json();
      expect(json).toMatchObject({
        type: 'urn:vcraft:problem:PERMISSION_DENIED',
        status: 403,
        code: 'PERMISSION_DENIED',
      });
      expect(json.tracking_id).toBeDefined();
    });

    it('returns HTTP 404 RESOURCE_NOT_FOUND when quote request id does not exist', async () => {
      currentQuoteRequest = null;
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/non-existent-id`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          spec: 'Valid spec',
        }),
      });

      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const json = await res.json();
      expect(json).toMatchObject({
        type: 'urn:vcraft:problem:RESOURCE_NOT_FOUND',
        status: 404,
        code: 'RESOURCE_NOT_FOUND',
      });
      expect(json.tracking_id).toBeDefined();
    });
  });

  describe('3. Response Envelope & RFC 9457 / RFC 7807 Compliance', () => {
    it('returns HTTP 200 with { success: true, data: { ... } } without double wrapping', async () => {
      currentQuoteRequest = createSampleDraftQuoteRequest({ id: '100', version: 1 });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          spec: 'Updated spec without double envelope',
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toBeDefined();
      expect(json.data.id).toBe('100');
      expect(json.data.spec).toBe('Updated spec without double envelope');
      expect(json.data.version).toBe(2);

      // Verify STRICT absence of double wrapping
      expect(json.data.data).toBeUndefined();
      expect(json.data.success).toBeUndefined();
    });

    it('problem details response contains all RFC 9457 fields and application/problem+json header', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          quantity: -10, // Invalid quantity
        }),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect(res.headers.get('x-request-id')).toBeTruthy();

      const problem = await res.json();
      expect(problem.type).toBe('urn:vcraft:problem:INVALID_INPUT');
      expect(problem.title).toBe('Dữ liệu không hợp lệ');
      expect(problem.status).toBe(400);
      expect(problem.detail).toBe('Kiểm tra lại dữ liệu đã gửi.');
      expect(problem.code).toBe('INVALID_INPUT');
      expect(problem.tracking_id).toBeDefined();
      expect(Array.isArray(problem.errors)).toBe(true);
      expect(problem.errors.length).toBeGreaterThan(0);
      expect(problem.errors[0]).toHaveProperty('field');
      expect(problem.errors[0]).toHaveProperty('message');
    });
  });
});
