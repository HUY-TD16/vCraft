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
import { BuyerQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/buyer-quote-request.controller';
import {
  ConcurrencyConflictError,
  InvalidStateTransitionError,
  QuoteRequest,
  type QuoteRequestProps,
  TradingPermissionDeniedError,
  TradingResourceNotFoundError,
  InvalidTradingInputError,
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

function createSampleDraftQuoteRequest(
  overrides: Partial<QuoteRequestProps> = {},
): QuoteRequest {
  const now = new Date('2026-11-10T10:00:00.000Z');
  return QuoteRequest.reconstitute({
    id: '100',
    buyer_id: '10',
    category_id: '1',
    spec: 'Sample Bat Trang Draft Tea Set',
    quantity: 100,
    unit: 'piece',
    unit_set_description: null,
    status: 'draft_request',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'HN',
    delivery_address: '123 Craft St',
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
let deletedRequestId: string | null = null;

const mockRepo = {
  createDraft: vi.fn(),
  update: vi.fn(),
  lockById: vi.fn().mockImplementation(async (id: string) => {
    if (currentQuoteRequest && currentQuoteRequest.id === id) {
      return currentQuoteRequest;
    }
    return null;
  }),
  deleteDraft: vi.fn().mockImplementation(async ({ requestId }: { requestId: string }) => {
    if (currentQuoteRequest && currentQuoteRequest.id === requestId) {
      deletedRequestId = requestId;
      currentQuoteRequest = null;
    }
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
    {
      provide: DeleteDraftQuoteRequestUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new DeleteDraftQuoteRequestUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
  ],
})(TestTradingModule);

describe('Task 6: Delete Draft Quote Request (DELETE /api/v1/buyer/quote-requests/:id — UC-14, BR-21)', () => {
  describe('DeleteDraftQuoteRequestUseCase (Clean Architecture Domain & Application)', () => {
    it('UT-01: successfully deletes draft quote request when owned by buyer, in draft_request status with matching version', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({ version: 1 });
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
      };

      const useCase = new DeleteDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
      });

      expect(singleRepo.lockById).toHaveBeenCalledWith('100', expect.anything());
      expect(singleRepo.deleteDraft).toHaveBeenCalledWith(
        {
          requestId: '100',
          buyerId: '10',
          expectedVersion: 1,
        },
        expect.anything(),
      );
    });

    it('UT-02: successfully deletes draft quote request when expectedRequestVersion is omitted (defaults to current version)', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({ version: 2 });
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
      };

      const useCase = new DeleteDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });

      expect(singleRepo.deleteDraft).toHaveBeenCalledWith(
        {
          requestId: '100',
          buyerId: '10',
          expectedVersion: 2,
        },
        expect.anything(),
      );
    });

    it('UT-03: throws ConcurrencyConflictError when expectedRequestVersion does not match current version', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({ version: 1 });
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        deleteDraft: vi.fn(),
      };

      const useCase = new DeleteDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 3,
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      expect(singleRepo.deleteDraft).not.toHaveBeenCalled();
    });

    it('UT-04: throws TradingPermissionDeniedError when actor is not a buyer', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        lockById: vi.fn(),
        deleteDraft: vi.fn(),
      };

      const useCase = new DeleteDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '100',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(singleRepo.lockById).not.toHaveBeenCalled();
      expect(singleRepo.deleteDraft).not.toHaveBeenCalled();
    });

    it('UT-05: throws TradingResourceNotFoundError when quote request does not exist', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(null),
        deleteDraft: vi.fn(),
      };

      const useCase = new DeleteDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '9999',
        }),
      ).rejects.toThrow(TradingResourceNotFoundError);

      expect(singleRepo.deleteDraft).not.toHaveBeenCalled();
    });

    it('UT-06: throws TradingPermissionDeniedError when quote request belongs to another buyer', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({ buyer_id: '99' }); // Belongs to otherBuyer
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        deleteDraft: vi.fn(),
      };

      const useCase = new DeleteDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor, // id '10'
          requestId: '100',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(singleRepo.deleteDraft).not.toHaveBeenCalled();
    });

    it('UT-07: throws InvalidStateTransitionError when quote request has already been sent (sent_to_artisans)', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({
        status: 'sent_to_artisans',
      });
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        deleteDraft: vi.fn(),
      };

      const useCase = new DeleteDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      expect(singleRepo.deleteDraft).not.toHaveBeenCalled();
    });

    it('UT-08: throws InvalidStateTransitionError when quote request is in non-draft statuses', async () => {
      const txRunner = new MockTransactionRunner();
      const nonDraftStatuses = [
        'artisans_bidding',
        'buyer_accepted',
        'in_production',
        'delivered',
      ] as const;

      for (const status of nonDraftStatuses) {
        const existing = createSampleDraftQuoteRequest({ status });
        const singleRepo = {
          lockById: vi.fn().mockResolvedValue(existing),
          deleteDraft: vi.fn(),
        };

        const useCase = new DeleteDraftQuoteRequestUseCase(
          txRunner as any,
          singleRepo as any,
        );

        await expect(
          useCase.execute({
            actor: buyerActor,
            requestId: '100',
          }),
        ).rejects.toThrow(InvalidStateTransitionError);

        expect(singleRepo.deleteDraft).not.toHaveBeenCalled();
      }
    });

    it('UT-09: throws InvalidTradingInputError when requestId is missing', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { lockById: vi.fn(), deleteDraft: vi.fn() };
      const useCase = new DeleteDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '',
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('UT-10: throws InvalidStateTransitionError when quote request has been cancelled', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({
        status: 'sent_to_artisans',
        cancelled_at: new Date('2026-11-11T10:00:00.000Z'),
        cancelled_by: '10',
        cancel_reason: 'Cancelled request',
      });
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        deleteDraft: vi.fn(),
      };

      const useCase = new DeleteDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      expect(singleRepo.deleteDraft).not.toHaveBeenCalled();
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

    it('HTTP-01: DELETE /buyer/quote-requests/:id succeeds with 204 No Content for Buyer owner with matching version', async () => {
      currentQuoteRequest = createSampleDraftQuoteRequest({ id: '100', version: 1 });
      deletedRequestId = null;
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
        }),
      });

      expect(res.status).toBe(204);
      const text = await res.text();
      expect(text).toBe('');
      expect(deletedRequestId).toBe('100');
    });

    it('HTTP-02: DELETE /buyer/quote-requests/:id succeeds with 204 No Content when called with empty body', async () => {
      currentQuoteRequest = createSampleDraftQuoteRequest({ id: '101', version: 1 });
      deletedRequestId = null;
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/101`, {
        method: 'DELETE',
        headers: {
          Cookie: 'vcraft-session=valid-buyer-token',
        },
      });

      expect(res.status).toBe(204);
      const text = await res.text();
      expect(text).toBe('');
      expect(deletedRequestId).toBe('101');
    });

    it('HTTP-03: DELETE /buyer/quote-requests/:id returns 401 when unauthenticated', async () => {
      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('HTTP-04: DELETE /buyer/quote-requests/:id returns 403 when called by artisan', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);

      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'DELETE',
        headers: {
          Cookie: 'vcraft-session=artisan-token',
        },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('HTTP-05: DELETE /buyer/quote-requests/:id returns 403 when called by another buyer', async () => {
      currentQuoteRequest = createSampleDraftQuoteRequest({ id: '100', buyer_id: '10' });
      identityMock.resolveSession.mockResolvedValueOnce(otherBuyerActor); // id '99'

      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'DELETE',
        headers: {
          Cookie: 'vcraft-session=other-buyer-token',
        },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('HTTP-06: DELETE /buyer/quote-requests/:id returns 404 when request does not exist', async () => {
      currentQuoteRequest = null;
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/999`, {
        method: 'DELETE',
        headers: {
          Cookie: 'vcraft-session=valid-buyer-token',
        },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('HTTP-07: DELETE /buyer/quote-requests/:id returns 422 INVALID_STATE when request has been sent to artisans (BR-21)', async () => {
      currentQuoteRequest = createSampleDraftQuoteRequest({
        id: '100',
        status: 'sent_to_artisans',
      });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
        }),
      });

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.code).toBe('INVALID_STATE');
    });

    it('HTTP-08: DELETE /buyer/quote-requests/:id returns 409 CONCURRENCY_CONFLICT when version mismatches', async () => {
      currentQuoteRequest = createSampleDraftQuoteRequest({
        id: '100',
        version: 1,
      });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 99,
        }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe('CONCURRENCY_CONFLICT');
    });

    it('HTTP-09: DELETE /buyer/quote-requests/:id returns 400 INVALID_INPUT when body contains unexpected fields (strict schema)', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          unexpected_field: 'hacker',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });
  });
});
