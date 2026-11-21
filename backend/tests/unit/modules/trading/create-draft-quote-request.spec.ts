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
import { BuyerQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/buyer-quote-request.controller';
import {
  QuoteRequest,
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

const artisanActor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '200',
  authVersion: 1,
  sessionId: 'session-artisan-1',
  sessionLevel: 'normal',
});

const identityMock = new MockIdentityContract();
const createdQuoteRequests: QuoteRequest[] = [];

const mockRepo = {
  createDraft: vi.fn().mockImplementation(async ({ request }: { request: QuoteRequest }) => {
    createdQuoteRequests.push(request);
    return request;
  }),
};

class TestIdentityModule {}
Module({
  providers: [
    { provide: IDENTITY_CONTRACT, useValue: identityMock },
  ],
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
  ],
})(TestTradingModule);

describe('Task 4: Create Draft Quote Request (UC-14, BR-11)', () => {
  describe('CreateDraftQuoteRequestUseCase (Clean Architecture Domain & Application)', () => {
    it('creates a draft quote request with empty payload and defaults to version=1 and status=draft_request', async () => {
      const txRunner = new MockTransactionRunner();
      let capturedRequest: QuoteRequest | null = null;
      let capturedStatusLog: any = null;

      const singleMockRepo = {
        createDraft: vi.fn().mockImplementation(async ({ request, statusLog }) => {
          capturedRequest = request;
          capturedStatusLog = statusLog;
          return request;
        }),
      };

      const useCase = new CreateDraftQuoteRequestUseCase(
        txRunner as any,
        singleMockRepo as any,
      );

      const result = await useCase.execute({
        actor: buyerActor,
        draft: {},
      });

      expect(singleMockRepo.createDraft).toHaveBeenCalled();
      expect(result.status).toBe('draft_request');
      expect(result.version).toBe(1);
      expect(result.buyer_id).toBe('10');
      expect(result.spec).toBeNull();
      expect(result.quantity).toBeNull();
      expect(result.unit).toBeNull();
      expect(result.bidding_closed_at).toBeNull();

      expect(capturedRequest).toBeDefined();
      expect(capturedStatusLog).toMatchObject({
        event_type: 'created',
        new_status: 'draft_request',
        prev_status: null,
        performed_by: '10',
      });
    });

    it('creates a draft with partial initial data and normalizes piece / at_workshop fields', async () => {
      const txRunner = new MockTransactionRunner();
      const singleMockRepo = {
        createDraft: vi.fn().mockImplementation(async ({ request }) => request),
      };

      const useCase = new CreateDraftQuoteRequestUseCase(
        txRunner as any,
        singleMockRepo as any,
      );

      const result = await useCase.execute({
        actor: buyerActor,
        draft: {
          category_id: '3',
          spec: 'Bat Trang Ceramic Cups',
          quantity: 200,
          unit: 'piece',
          unit_set_description: 'ignored for piece',
          delivery_mode: 'at_workshop',
          delivery_region: 'HN',
          delivery_address: 'ignore address',
          bidding_deadline: '2026-12-01T10:00:00.000Z',
          delivery_deadline: '2026-12-15T10:00:00.000Z',
        },
      });

      expect(result.category_id).toBe('3');
      expect(result.spec).toBe('Bat Trang Ceramic Cups');
      expect(result.quantity).toBe(200);
      expect(result.unit).toBe('piece');
      expect(result.unit_set_description).toBeNull();
      expect(result.delivery_mode).toBe('at_workshop');
      expect(result.delivery_region).toBeNull();
      expect(result.delivery_address).toBeNull();
      expect(result.version).toBe(1);
    });

    it('rejects execution if actor is not a buyer', async () => {
      const txRunner = new MockTransactionRunner();
      const singleMockRepo = { createDraft: vi.fn() };
      const useCase = new CreateDraftQuoteRequestUseCase(
        txRunner as any,
        singleMockRepo as any,
      );

      await expect(
        useCase.execute({
          actor: artisanActor,
          draft: {},
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(singleMockRepo.createDraft).not.toHaveBeenCalled();
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

    it('POST /buyer/quote-requests succeeds with 201 Created and enveloped response for Buyer', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          spec: 'Ceramic Flower Vase',
          quantity: 50,
          unit: 'piece',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toMatchObject({
        status: 'draft_request',
        version: 1,
        buyer_id: '10',
        spec: 'Ceramic Flower Vase',
        quantity: 50,
        unit: 'piece',
        is_bidding_open: false,
      });
      expect(json.data.created_at).toBeDefined();
    });

    it('POST /buyer/quote-requests succeeds with empty body {}', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests`, {
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
      expect(json.data.buyer_id).toBe('10');
      expect(json.data.spec).toBeNull();
      expect(json.data.quantity).toBeNull();
    });

    it('POST /buyer/quote-requests rejects invalid fields with 400 Bad Request', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          quantity: -10,
          unit: 'invalid_unit',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors.map((e: any) => e.field)).toEqual(
        expect.arrayContaining(['/quantity', '/unit']),
      );
    });

    it('POST /buyer/quote-requests rejects unexpected extra properties with 400 Bad Request', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          unrecognized_property: 'injected',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors[0].field).toBe('/unrecognized_property');
    });

    it('POST /buyer/quote-requests rejects unauthenticated requests with 401 AUTHENTICATION_REQUIRED', async () => {
      const res = await fetch(`${base}/buyer/quote-requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('POST /buyer/quote-requests rejects non-buyer role with 403 PERMISSION_DENIED', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);

      const res = await fetch(`${base}/buyer/quote-requests`, {
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
