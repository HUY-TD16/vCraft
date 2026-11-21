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
import { DeleteDraftQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/delete-draft-quote-request.use-case';
import { CopyQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/copy-quote-request.use-case';
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

const adminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-admin-1',
  sessionLevel: 'normal',
});

function createSampleQuoteRequest(
  overrides: Partial<QuoteRequestProps> = {},
): QuoteRequest {
  const now = new Date('2026-11-10T10:00:00.000Z');
  return QuoteRequest.reconstitute({
    id: '100',
    buyer_id: '10',
    category_id: '3',
    spec: 'Ấm chén Bát Tràng men rạn bọc đồng',
    quantity: 150,
    unit: 'set',
    unit_set_description: '1 ấm + 6 chén + 7 đĩa lót',
    status: 'draft_request',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'HN',
    delivery_address: 'Số 12 phố Tràng Tiền, Hoàn Kiếm, Hà Nội',
    recipient_name: 'Nguyễn Văn An',
    recipient_phone: '0987654321',
    bidding_deadline: new Date('2026-12-01T10:00:00.000Z'),
    delivery_deadline: new Date('2026-12-15T10:00:00.000Z'),
    bidding_closed_at: null,
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
const requestsMap = new Map<string, QuoteRequest>();
let autoId = 300;

const mockRepo = {
  createDraft: vi.fn().mockImplementation(async ({ request }: { request: QuoteRequest }) => {
    const id = String(autoId++);
    const created = QuoteRequest.reconstitute({
      id,
      buyer_id: request.buyer_id,
      category_id: request.category_id,
      spec: request.spec,
      quantity: request.quantity,
      unit: request.unit,
      unit_set_description: request.unit_set_description,
      status: request.status,
      delivery_mode: request.delivery_mode,
      delivery_region: request.delivery_region,
      delivery_address: request.delivery_address,
      recipient_name: request.recipient_name,
      recipient_phone: request.recipient_phone,
      bidding_deadline: request.bidding_deadline,
      delivery_deadline: request.delivery_deadline,
      bidding_closed_at: request.bidding_closed_at,
      version: request.version,
      cancelled_at: request.cancelled_at,
      cancelled_by: request.cancelled_by,
      cancel_reason: request.cancel_reason,
      created_at: request.created_at,
      updated_at: request.updated_at,
    });
    requestsMap.set(id, created);
    return created;
  }),
  findById: vi.fn().mockImplementation(async (id: string) => {
    return requestsMap.get(id) ?? null;
  }),
  lockById: vi.fn().mockImplementation(async (id: string) => {
    return requestsMap.get(id) ?? null;
  }),
  update: vi.fn(),
  deleteDraft: vi.fn(),
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
    {
      provide: DeleteDraftQuoteRequestUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new DeleteDraftQuoteRequestUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
    {
      provide: CopyQuoteRequestUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new CopyQuoteRequestUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
  ],
})(TestTradingModule);

describe('Adversarial & Stress Verification: POST /buyer/quote-requests/:id/copy', () => {
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

  describe('1. SEC-06 IDOR Stress & Privilege Boundaries', () => {
    it('returns HTTP 404 RESOURCE_NOT_FOUND (NOT 403) when Buyer 10 tries to copy Buyer 99 draft request', async () => {
      const foreignDraft = createSampleQuoteRequest({ id: '901', buyer_id: '99', status: 'draft_request' });
      requestsMap.set('901', foreignDraft);
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/901/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({}),
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

    it('returns HTTP 404 RESOURCE_NOT_FOUND when Buyer 10 tries to copy Buyer 99 active sent request', async () => {
      const foreignSent = createSampleQuoteRequest({ id: '902', buyer_id: '99', status: 'sent_to_artisans' });
      requestsMap.set('902', foreignSent);
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/902/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns HTTP 404 RESOURCE_NOT_FOUND when Buyer 10 tries to copy Buyer 99 delivered request', async () => {
      const foreignDelivered = createSampleQuoteRequest({ id: '903', buyer_id: '99', status: 'delivered' });
      requestsMap.set('903', foreignDelivered);
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/903/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns HTTP 404 RESOURCE_NOT_FOUND when Buyer 10 tries to copy Buyer 99 cancelled request', async () => {
      const foreignCancelled = createSampleQuoteRequest({
        id: '904',
        buyer_id: '99',
        status: 'sent_to_artisans',
        cancelled_at: new Date(),
        cancelled_by: '99',
        cancel_reason: 'Budget cut',
      });
      requestsMap.set('904', foreignCancelled);
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/904/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns HTTP 404 RESOURCE_NOT_FOUND for non-existent IDs across diverse ID patterns', async () => {
      identityMock.resolveSession.mockResolvedValue(buyerActor);

      const arbitraryIds = ['9999999', 'non-existent-uuid', '-1', '0'];
      for (const arbitraryId of arbitraryIds) {
        const res = await fetch(`${base}/buyer/quote-requests/${arbitraryId}/copy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=valid-buyer-token',
          },
          body: JSON.stringify({}),
        });

        expect(res.status).toBe(404);
        const json = await res.json();
        expect(json.code).toBe('RESOURCE_NOT_FOUND');
      }
    });

    it('returns HTTP 401 AUTHENTICATION_REQUIRED for unauthenticated requests', async () => {
      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns HTTP 403 PERMISSION_DENIED for artisan role', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-artisan-token',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('returns HTTP 403 PERMISSION_DENIED for admin role accessing buyer route', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(adminActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-admin-token',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });
  });

  describe('2. Source Entity Immutability', () => {
    it('verifies source entity version, state, and timestamps remain completely unchanged after copy', async () => {
      const originalTime = new Date('2026-11-01T12:00:00.000Z');
      const source = createSampleQuoteRequest({
        id: '201',
        buyer_id: '10',
        status: 'delivered',
        version: 7,
        created_at: originalTime,
        updated_at: originalTime,
        bidding_deadline: new Date('2026-11-10T12:00:00.000Z'),
        delivery_deadline: new Date('2026-11-20T12:00:00.000Z'),
      });
      requestsMap.set('201', source);
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/201/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);

      // Verify the source in repo
      const sourceAfter = requestsMap.get('201')!;
      expect(sourceAfter.version).toBe(7);
      expect(sourceAfter.status).toBe('delivered');
      expect(sourceAfter.updated_at.getTime()).toBe(originalTime.getTime());
      expect(sourceAfter.bidding_deadline).not.toBeNull();
      expect(sourceAfter.delivery_deadline).not.toBeNull();
    });

    it('verifies cancelled source maintains cancellation marker after copy', async () => {
      const cancelDate = new Date('2026-11-05T12:00:00.000Z');
      const cancelledSource = createSampleQuoteRequest({
        id: '202',
        buyer_id: '10',
        status: 'sent_to_artisans',
        version: 3,
        cancelled_at: cancelDate,
        cancelled_by: '10',
        cancel_reason: 'Market condition change',
      });
      requestsMap.set('202', cancelledSource);
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/202/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const sourceAfter = requestsMap.get('202')!;
      expect(sourceAfter.cancelled_at).toEqual(cancelDate);
      expect(sourceAfter.cancelled_by).toBe('10');
      expect(sourceAfter.cancel_reason).toBe('Market condition change');
    });
  });

  describe('3. Replay & Concurrency Resilience', () => {
    it('creates distinct draft instances when copy endpoint is called repeatedly', async () => {
      const source = createSampleQuoteRequest({ id: '203', buyer_id: '10' });
      requestsMap.set('203', source);

      const createdIds = new Set<string>();

      for (let i = 0; i < 3; i++) {
        identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
        const res = await fetch(`${base}/buyer/quote-requests/203/copy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=valid-buyer-token',
          },
          body: JSON.stringify({}),
        });

        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.data.status).toBe('draft_request');
        expect(json.data.version).toBe(1);
        createdIds.add(json.data.id);
      }

      // 3 distinct draft entities were created
      expect(createdIds.size).toBe(3);
    });

    it('handles concurrent copy requests in parallel without concurrency conflict', async () => {
      const source = createSampleQuoteRequest({ id: '204', buyer_id: '10', version: 2 });
      requestsMap.set('204', source);

      const calls = Array.from({ length: 5 }).map(async () => {
        identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
        return fetch(`${base}/buyer/quote-requests/204/copy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=valid-buyer-token',
          },
          body: JSON.stringify({}),
        });
      });

      const responses = await Promise.all(calls);
      for (const res of responses) {
        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.data.version).toBe(1);
      }
    });
  });

  describe('4. Null & Edge-case Specification Handling', () => {
    it('successfully copies source request with all optional fields null', async () => {
      const minimalSource = createSampleQuoteRequest({
        id: '205',
        buyer_id: '10',
        category_id: null,
        spec: null,
        quantity: null,
        unit: null,
        unit_set_description: null,
        delivery_mode: null,
        delivery_region: null,
        delivery_address: null,
        recipient_name: null,
        recipient_phone: null,
      });
      requestsMap.set('205', minimalSource);
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/205/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.spec).toBeNull();
      expect(json.data.quantity).toBeNull();
      expect(json.data.unit).toBeNull();
      expect(json.data.category).toBeNull();
    });

    it('normalizes unit_set_description to null when unit is piece', async () => {
      const pieceSource = createSampleQuoteRequest({
        id: '206',
        buyer_id: '10',
        unit: 'piece',
        unit_set_description: 'stale description that should be ignored for piece',
      });
      requestsMap.set('206', pieceSource);
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/206/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.unit).toBe('piece');
      expect(json.data.unit_set_description).toBeNull();
    });

    it('normalizes delivery address and region to null when delivery_mode is at_workshop', async () => {
      const workshopSource = createSampleQuoteRequest({
        id: '207',
        buyer_id: '10',
        delivery_mode: 'at_workshop',
        delivery_region: 'HN',
        delivery_address: 'Stale address',
      });
      requestsMap.set('207', workshopSource);
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/207/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.delivery_mode).toBe('at_workshop');
      expect(json.data.delivery_region).toBeNull();
      expect(json.data.delivery_address).toBeNull();
    });

    it('preserves complex Unicode, Vietnamese diacritics, and special characters', async () => {
      const complexSpec = 'Bộ trà gốm Chu Đậu men rạn cổ dát vàng 24K ✨ 🍵 (Kèm hộp quà gỗ cao cấp & chứng thư)';
      const unicodeSource = createSampleQuoteRequest({
        id: '208',
        buyer_id: '10',
        spec: complexSpec,
      });
      requestsMap.set('208', unicodeSource);
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/208/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.spec).toBe(complexSpec);
    });
  });

  describe('5. Payload Tampering & RFC 9457 / Envelope Compliance', () => {
    it('rejects unexpected extra body fields with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          status: 'sent_to_artisans',
          buyer_id: '99',
          version: 10,
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
      expect(json.errors.some((e: any) => e.field === '/status')).toBe(true);
    });

    it('verifies strict ResponseEnvelope absence of duplicate nested envelope', async () => {
      const source = createSampleQuoteRequest({ id: '209', buyer_id: '10' });
      requestsMap.set('209', source);
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/209/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const envelope = await res.json();
      expect(envelope.success).toBe(true);
      expect(envelope.data).toBeDefined();
      expect(envelope.data.id).toBeDefined();
      expect(envelope.data.success).toBeUndefined();
      expect(envelope.data.data).toBeUndefined();
    });
  });

  describe('6. Exhaustive Payload Tampering & Strict Schema Defense', () => {
    it('succeeds with HTTP 201 when request body is completely omitted (no body option)', async () => {
      const source = createSampleQuoteRequest({ id: '301', buyer_id: '10' });
      requestsMap.set('301', source);
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/301/copy`, {
        method: 'POST',
        headers: {
          Cookie: 'vcraft-session=valid-buyer-token',
        },
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.status).toBe('draft_request');
      expect(json.data.version).toBe(1);
    });

    it('succeeds with HTTP 201 when request body is empty object {}', async () => {
      const source = createSampleQuoteRequest({ id: '302', buyer_id: '10' });
      requestsMap.set('302', source);
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/302/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.status).toBe('draft_request');
      expect(json.data.version).toBe(1);
    });

    it('rejects primitive numeric payload with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: '12345',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('rejects primitive string payload with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: '"malicious_string_payload"',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('rejects primitive boolean payload with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: 'true',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('rejects primitive null payload with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: 'null',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('rejects array payload with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify(['item1', 'item2']),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('rejects empty array [] payload with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify([]),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('rejects prototype pollution payload with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: '{"__proto__":{"admin":true}}',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('rejects constructor pollution payload with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({ constructor: { prototype: { admin: true } } }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors.some((e: any) => e.field === '/constructor')).toBe(true);
    });
  });

  describe('7. Invariant Isolation & Reset Verification', () => {
    it('proves copied draft entity does NOT inherit operational child records and resets all deadlines & cancellation markers', async () => {
      // Source QuoteRequest in complex production state with all operational markers populated
      const matureSource = createSampleQuoteRequest({
        id: '303',
        buyer_id: '10',
        status: 'in_production',
        version: 12,
        bidding_deadline: new Date('2026-11-01T10:00:00.000Z'),
        delivery_deadline: new Date('2026-11-20T10:00:00.000Z'),
        bidding_closed_at: new Date('2026-11-01T09:30:00.000Z'),
        cancelled_at: new Date('2026-11-02T10:00:00.000Z'),
        cancelled_by: '1',
        cancel_reason: 'Admin test cancellation',
      });

      let capturedPayload: any = null;
      const testRepo = {
        findById: vi.fn().mockResolvedValue(matureSource),
        createDraft: vi.fn().mockImplementation(async (payload) => {
          capturedPayload = payload;
          return payload.request;
        }),
      };

      const txRunner = new MockTransactionRunner();
      const useCase = new CopyQuoteRequestUseCase(txRunner as any, testRepo as any);

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '303',
      });

      // 1. Invariant Isolation: verify repo payload does NOT carry any child entities
      expect(capturedPayload).toBeDefined();
      expect(capturedPayload.request).toBeDefined();
      expect(capturedPayload.statusLog).toBeDefined();
      expect(capturedPayload.useEntityId).toBe(false);

      // Verify no operational child records are passed
      expect(capturedPayload.quotes).toBeUndefined();
      expect(capturedPayload.recipients).toBeUndefined();
      expect(capturedPayload.splitProposals).toBeUndefined();
      expect(capturedPayload.allocations).toBeUndefined();
      expect(capturedPayload.contactEditHistory).toBeUndefined();

      // 2. Initial StatusLog: exactly 1 record with event_type = 'created'
      expect(capturedPayload.statusLog).toMatchObject({
        event_type: 'created',
        new_status: 'draft_request',
        prev_status: null,
        performed_by: '10',
        is_admin_action: false,
        note: null,
        evidence: null,
      });

      // 3. Status and Version
      expect(result.status).toBe('draft_request');
      expect(result.version).toBe(1);

      // 4. All Deadlines strictly null
      expect(result.bidding_deadline).toBeNull();
      expect(result.delivery_deadline).toBeNull();
      expect(result.bidding_closed_at).toBeNull();

      // 5. Cancellation markers strictly null
      expect(result.cancelled_at).toBeNull();
      expect(result.cancelled_by).toBeNull();
      expect(result.cancel_reason).toBeNull();
    });
  });
});
