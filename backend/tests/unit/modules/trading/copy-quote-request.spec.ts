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
  QuoteRequestNotFoundError,
  TradingPermissionDeniedError,
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
let currentQuoteRequest: QuoteRequest | null = null;
let nextCreatedId = 200;

const mockRepo = {
  createDraft: vi.fn().mockImplementation(async ({ request }: { request: QuoteRequest }) => {
    const created = QuoteRequest.reconstitute({
      id: String(nextCreatedId++),
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
    return created;
  }),
  findById: vi.fn().mockImplementation(async (id: string) => {
    if (currentQuoteRequest && currentQuoteRequest.id === id) {
      return currentQuoteRequest;
    }
    return null;
  }),
  lockById: vi.fn().mockImplementation(async (id: string) => {
    if (currentQuoteRequest && currentQuoteRequest.id === id) {
      return currentQuoteRequest;
    }
    return null;
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

describe('Task 7: Copy Quote Request (UC-14, BR-11, SEC-06)', () => {
  describe('CopyQuoteRequestUseCase (Clean Architecture Domain & Application)', () => {
    it('1. successfully copies quote request from draft status (draft_request)', async () => {
      const txRunner = new MockTransactionRunner();
      const source = createSampleQuoteRequest({ id: '100', status: 'draft_request', version: 1 });
      const repo = {
        findById: vi.fn().mockResolvedValue(source),
        createDraft: vi.fn().mockImplementation(async ({ request }) => request),
      };
      const useCase = new CopyQuoteRequestUseCase(txRunner as any, repo as any);

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });

      expect(repo.findById).toHaveBeenCalledWith('100', expect.anything());
      expect(repo.createDraft).toHaveBeenCalled();
      expect(result.status).toBe('draft_request');
      expect(result.version).toBe(1);
      expect(result.buyer_id).toBe('10');
    });

    it('2. successfully copies quote request from sent status (sent_to_artisans)', async () => {
      const txRunner = new MockTransactionRunner();
      const source = createSampleQuoteRequest({
        id: '101',
        status: 'sent_to_artisans',
        version: 2,
        bidding_deadline: new Date('2026-12-01T10:00:00.000Z'),
        delivery_deadline: new Date('2026-12-15T10:00:00.000Z'),
      });
      const repo = {
        findById: vi.fn().mockResolvedValue(source),
        createDraft: vi.fn().mockImplementation(async ({ request }) => request),
      };
      const useCase = new CopyQuoteRequestUseCase(txRunner as any, repo as any);

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '101',
      });

      expect(result.status).toBe('draft_request');
      expect(result.version).toBe(1);
    });

    it('3. successfully copies quote request from completed status (delivered)', async () => {
      const txRunner = new MockTransactionRunner();
      const source = createSampleQuoteRequest({
        id: '102',
        status: 'delivered',
        version: 5,
        bidding_closed_at: new Date('2026-11-20T10:00:00.000Z'),
      });
      const repo = {
        findById: vi.fn().mockResolvedValue(source),
        createDraft: vi.fn().mockImplementation(async ({ request }) => request),
      };
      const useCase = new CopyQuoteRequestUseCase(txRunner as any, repo as any);

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '102',
      });

      expect(result.status).toBe('draft_request');
      expect(result.version).toBe(1);
    });

    it('4. successfully copies quote request from cancelled status (cancelled)', async () => {
      const txRunner = new MockTransactionRunner();
      const source = createSampleQuoteRequest({
        id: '103',
        status: 'sent_to_artisans',
        cancelled_at: new Date('2026-11-15T10:00:00.000Z'),
        cancelled_by: '10',
        cancel_reason: 'Buyer decided to postpone',
        version: 2,
      });
      const repo = {
        findById: vi.fn().mockResolvedValue(source),
        createDraft: vi.fn().mockImplementation(async ({ request }) => request),
      };
      const useCase = new CopyQuoteRequestUseCase(txRunner as any, repo as any);

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '103',
      });

      expect(result.status).toBe('draft_request');
      expect(result.version).toBe(1);
    });

    it('5. verifies all 10 specification and delivery fields are identical to source', async () => {
      const txRunner = new MockTransactionRunner();
      const source = createSampleQuoteRequest({
        id: '104',
        category_id: '5',
        spec: 'Bình hoa gốm vuốt tay men rạn thủ công',
        quantity: 80,
        unit: 'set',
        unit_set_description: '1 bình + chân đế gỗ',
        delivery_mode: 'at_buyer_address',
        delivery_region: 'Đà Nẵng',
        delivery_address: '789 Đường Bạch Đằng, Hải Châu',
        recipient_name: 'Lê Văn C',
        recipient_phone: '0905123456',
      });
      const repo = {
        findById: vi.fn().mockResolvedValue(source),
        createDraft: vi.fn().mockImplementation(async ({ request }) => request),
      };
      const useCase = new CopyQuoteRequestUseCase(txRunner as any, repo as any);

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '104',
      });

      expect(result.category_id).toBe('5');
      expect(result.spec).toBe('Bình hoa gốm vuốt tay men rạn thủ công');
      expect(result.quantity).toBe(80);
      expect(result.unit).toBe('set');
      expect(result.unit_set_description).toBe('1 bình + chân đế gỗ');
      expect(result.delivery_mode).toBe('at_buyer_address');
      expect(result.delivery_region).toBe('Đà Nẵng');
      expect(result.delivery_address).toBe('789 Đường Bạch Đằng, Hải Châu');
      expect(result.recipient_name).toBe('Lê Văn C');
      expect(result.recipient_phone).toBe('0905123456');
    });

    it('6. verifies all deadlines are reset to null', async () => {
      const txRunner = new MockTransactionRunner();
      const source = createSampleQuoteRequest({
        id: '105',
        bidding_deadline: new Date('2026-12-01T10:00:00.000Z'),
        delivery_deadline: new Date('2026-12-15T10:00:00.000Z'),
        bidding_closed_at: new Date('2026-12-01T09:00:00.000Z'),
      });
      const repo = {
        findById: vi.fn().mockResolvedValue(source),
        createDraft: vi.fn().mockImplementation(async ({ request }) => request),
      };
      const useCase = new CopyQuoteRequestUseCase(txRunner as any, repo as any);

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '105',
      });

      expect(result.bidding_deadline).toBeNull();
      expect(result.delivery_deadline).toBeNull();
      expect(result.bidding_closed_at).toBeNull();
    });

    it('7. verifies cancellation fields are reset to null', async () => {
      const txRunner = new MockTransactionRunner();
      const source = createSampleQuoteRequest({
        id: '106',
        status: 'sent_to_artisans',
        cancelled_at: new Date('2026-11-20T10:00:00.000Z'),
        cancelled_by: '10',
        cancel_reason: 'Previous project cancelled by client',
      });
      const repo = {
        findById: vi.fn().mockResolvedValue(source),
        createDraft: vi.fn().mockImplementation(async ({ request }) => request),
      };
      const useCase = new CopyQuoteRequestUseCase(txRunner as any, repo as any);

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '106',
      });

      expect(result.cancelled_at).toBeNull();
      expect(result.cancelled_by).toBeNull();
      expect(result.cancel_reason).toBeNull();
    });

    it('8. verifies status is draft_request and version is 1', async () => {
      const txRunner = new MockTransactionRunner();
      const source = createSampleQuoteRequest({
        id: '107',
        status: 'delivered',
        version: 9,
      });
      const repo = {
        findById: vi.fn().mockResolvedValue(source),
        createDraft: vi.fn().mockImplementation(async ({ request }) => request),
      };
      const useCase = new CopyQuoteRequestUseCase(txRunner as any, repo as any);

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '107',
      });

      expect(result.status).toBe('draft_request');
      expect(result.version).toBe(1);
    });

    it('9. verifies isolation: no quote, recipient, allocation, or split proposal records are attached', async () => {
      const txRunner = new MockTransactionRunner();
      const source = createSampleQuoteRequest({ id: '108', version: 3 });
      let capturedPayload: any = null;
      const repo = {
        findById: vi.fn().mockResolvedValue(source),
        createDraft: vi.fn().mockImplementation(async (payload) => {
          capturedPayload = payload;
          return payload.request;
        }),
      };
      const useCase = new CopyQuoteRequestUseCase(txRunner as any, repo as any);

      await useCase.execute({
        actor: buyerActor,
        requestId: '108',
      });

      expect(capturedPayload).toBeDefined();
      expect(capturedPayload.useEntityId).toBe(false);
      expect(Object.keys(capturedPayload)).toEqual(
        expect.arrayContaining(['request', 'statusLog', 'useEntityId']),
      );
      expect(capturedPayload.quotes).toBeUndefined();
      expect(capturedPayload.recipients).toBeUndefined();
      expect(capturedPayload.allocations).toBeUndefined();
      expect(capturedPayload.splitProposals).toBeUndefined();
    });

    it('10. verifies initial StatusLog record has event_type = "created"', async () => {
      const txRunner = new MockTransactionRunner();
      const source = createSampleQuoteRequest({ id: '109' });
      let capturedStatusLog: any = null;
      const repo = {
        findById: vi.fn().mockResolvedValue(source),
        createDraft: vi.fn().mockImplementation(async ({ request, statusLog }) => {
          capturedStatusLog = statusLog;
          return request;
        }),
      };
      const useCase = new CopyQuoteRequestUseCase(txRunner as any, repo as any);

      await useCase.execute({
        actor: buyerActor,
        requestId: '109',
      });

      expect(capturedStatusLog).toMatchObject({
        event_type: 'created',
        new_status: 'draft_request',
        prev_status: null,
        performed_by: '10',
        is_admin_action: false,
      });
    });

    it('11. SEC-06 error case: throws QuoteRequestNotFoundError when source request does not exist', async () => {
      const txRunner = new MockTransactionRunner();
      const repo = {
        findById: vi.fn().mockResolvedValue(null),
        createDraft: vi.fn(),
      };
      const useCase = new CopyQuoteRequestUseCase(txRunner as any, repo as any);

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '999999',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(repo.createDraft).not.toHaveBeenCalled();
    });

    it('12. SEC-06 error case: throws QuoteRequestNotFoundError (NOT 403) when source request belongs to another buyer', async () => {
      const txRunner = new MockTransactionRunner();
      const foreignSource = createSampleQuoteRequest({
        id: '110',
        buyer_id: '99', // Owned by buyer 99
      });
      const repo = {
        findById: vi.fn().mockResolvedValue(foreignSource),
        createDraft: vi.fn(),
      };
      const useCase = new CopyQuoteRequestUseCase(txRunner as any, repo as any);

      await expect(
        useCase.execute({
          actor: buyerActor, // accountId 10
          requestId: '110',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(repo.createDraft).not.toHaveBeenCalled();
    });
  });

  describe('BuyerQuoteRequestController (HTTP Endpoints & Guards)', () => {
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

    it('13. calls copyQuoteRequest endpoint and returns 201 Created with mapped BuyerRequestDto', async () => {
      currentQuoteRequest = createSampleQuoteRequest({ id: '100', buyer_id: '10' });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
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
      expect(json.data).toMatchObject({
        status: 'draft_request',
        version: 1,
        buyer_id: '10',
        category: { id: '3', name: '' },
        spec: 'Ấm chén Bát Tràng men rạn bọc đồng',
        quantity: 150,
        unit: 'set',
        delivery_mode: 'at_buyer_address',
        delivery_region: 'HN',
        bidding_deadline: null,
        delivery_deadline: null,
        bidding_closed_at: null,
        is_bidding_open: false,
        cancelled_at: null,
      });
      expect(json.data.id).toBeDefined();
    });

    it('14. verifies ResponseEnvelope wraps data in { success: true, data: BuyerRequestDto } without double wrapping', async () => {
      currentQuoteRequest = createSampleQuoteRequest({ id: '100', buyer_id: '10' });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json).toHaveProperty('success', true);
      expect(json).toHaveProperty('data');
      expect(json.data.data).toBeUndefined();
      expect(json.data.success).toBeUndefined();
    });

    it('15. verifies empty body {} succeeds', async () => {
      currentQuoteRequest = createSampleQuoteRequest({ id: '100', buyer_id: '10' });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
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
    });

    it('16. verifies non-empty body or unrecognized keys rejected with HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          unexpected_key: 'malicious_input',
        }),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors[0].field).toBe('/unexpected_key');
    });

    it('17. verifies non-buyer actor rejected by @Roles("buyer") with HTTP 403', async () => {
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
  });
});
