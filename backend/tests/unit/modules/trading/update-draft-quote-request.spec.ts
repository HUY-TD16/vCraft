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
  ConcurrencyConflictError,
  DeadlineViolationError,
  InvalidStateTransitionError,
  QuoteRequest,
  type QuoteRequestProps,
  TradingPermissionDeniedError,
  TradingResourceNotFoundError,
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
    spec: 'Initial Bat Trang Tea Set Spec',
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

describe('Task 5: Update Draft Quote Request (UC-14, BR-11, BR-12, BR-27)', () => {
  describe('UpdateDraftQuoteRequestUseCase (Clean Architecture Domain & Application)', () => {
    it('UT-01: successfully updates draft quote request with valid fields and increments version to 2', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({ version: 1 });
      let savedRequest: QuoteRequest | null = null;

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockImplementation(async ({ request }) => {
          savedRequest = request;
          return request;
        }),
      };

      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
        draft: {
          category_id: '2',
          spec: 'Updated Bat Trang Glazed Vases',
          quantity: 250,
          unit: 'set',
          unit_set_description: '2 vases and 1 decorative plate',
          delivery_mode: 'at_buyer_address',
          delivery_region: 'HN',
          delivery_address: '456 Pottery Lane',
          recipient_name: 'Tran Thi B',
          recipient_phone: '0912345678',
          bidding_deadline: '2026-12-05T10:00:00.000Z',
          delivery_deadline: '2026-12-20T10:00:00.000Z',
        },
      });

      expect(singleRepo.lockById).toHaveBeenCalledWith('100', expect.anything());
      expect(singleRepo.update).toHaveBeenCalledWith(
        { request: expect.any(Object), expectedVersion: 1 },
        expect.anything(),
      );
      expect(result.id).toBe('100');
      expect(result.version).toBe(2);
      expect(result.category_id).toBe('2');
      expect(result.spec).toBe('Updated Bat Trang Glazed Vases');
      expect(result.quantity).toBe(250);
      expect(result.unit).toBe('set');
      expect(result.unit_set_description).toBe('2 vases and 1 decorative plate');
      expect(result.recipient_name).toBe('Tran Thi B');
      expect(result.recipient_phone).toBe('0912345678');
      expect(savedRequest).toBe(result);
    });

    it('UT-02: throws ConcurrencyConflictError when expected_request_version does not match current version', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({ version: 2 });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1, // Stale version
          draft: { spec: 'Should be rejected' },
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-02b: throws ConcurrencyConflictError when expected_request_version is higher than DB version (BR-27)', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({ version: 2 });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 5, // Higher than DB version (2)
          draft: { spec: 'Should be rejected' },
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-02c: succeeds and increments version when expected_request_version matches DB version exactly (BR-27)', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({ version: 3 });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockImplementation(async ({ request }) => request),
      };

      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 3, // Matches DB version (3)
        draft: { spec: 'Matching version update' },
      });

      expect(result.version).toBe(4);
      expect(singleRepo.update).toHaveBeenCalledWith(
        { request: expect.any(Object), expectedVersion: 3 },
        expect.anything(),
      );
    });

    it('UT-03: throws InvalidStateTransitionError when quote request status is not draft_request', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({
        status: 'sent_to_artisans',
        version: 1,
      });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          draft: { spec: 'Cannot edit sent request' },
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-03b: throws InvalidStateTransitionError when status is artisans_bidding or buyer_accepted (BR-11, UC-14)', async () => {
      const txRunner = new MockTransactionRunner();
      const forbiddenStatuses = ['artisans_bidding', 'buyer_accepted', 'in_production', 'delivered'] as const;

      for (const forbiddenStatus of forbiddenStatuses) {
        const existing = createSampleDraftQuoteRequest({
          status: forbiddenStatus,
          version: 1,
        });

        const singleRepo = {
          lockById: vi.fn().mockResolvedValue(existing),
          update: vi.fn(),
        };

        const useCase = new UpdateDraftQuoteRequestUseCase(
          txRunner as any,
          singleRepo as any,
        );

        await expect(
          useCase.execute({
            actor: buyerActor,
            requestId: '100',
            expectedRequestVersion: 1,
            draft: { spec: `Cannot edit status ${forbiddenStatus}` },
          }),
        ).rejects.toThrow(InvalidStateTransitionError);

        expect(singleRepo.update).not.toHaveBeenCalled();
      }
    });

    it('UT-04: throws InvalidStateTransitionError when quote request has been cancelled', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({
        status: 'sent_to_artisans',
        cancelled_at: new Date('2026-11-10T12:00:00.000Z'),
        cancelled_by: '10',
        cancel_reason: 'Buyer changed mind',
        version: 1,
      });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          draft: { spec: 'Cannot edit cancelled request' },
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-04b: assertNotCancelled explicitly triggers and rejects update with cancellation error message (BR-11)', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({
        status: 'sent_to_artisans',
        cancelled_at: new Date('2026-11-10T12:00:00.000Z'),
        cancelled_by: '10',
        cancel_reason: 'Buyer cancelled request',
        version: 1,
      });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          draft: { spec: 'Cannot edit cancelled request' },
        }),
      ).rejects.toThrow('Operation is not allowed because the QuoteRequest has been cancelled.');

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-05: throws DeadlineViolationError when delivery_deadline <= bidding_deadline + 24h (INV-02, BR-12)', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({ version: 1 });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      // Bidding deadline at 10:00, delivery deadline at 20:00 same day (10 hours gap, < 24 hours)
      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          draft: {
            bidding_deadline: '2026-12-01T10:00:00.000Z',
            delivery_deadline: '2026-12-01T20:00:00.000Z',
          },
        }),
      ).rejects.toThrow(DeadlineViolationError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-06: throws DeadlineViolationError when delivery_deadline exactly equals bidding_deadline + 24h', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({ version: 1 });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      // Exactly 24 hours gap (boundary condition: must be strictly greater than 24h)
      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          draft: {
            bidding_deadline: '2026-12-01T10:00:00.000Z',
            delivery_deadline: '2026-12-02T10:00:00.000Z',
          },
        }),
      ).rejects.toThrow(DeadlineViolationError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-06a: throws DeadlineViolationError when delivery_deadline equals bidding_deadline + 24h - 1ms (BR-12 boundary)', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({ version: 1 });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      // 2026-12-01T10:00:00.000Z + 24h - 1ms = 2026-12-02T09:59:59.999Z
      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          draft: {
            bidding_deadline: '2026-12-01T10:00:00.000Z',
            delivery_deadline: '2026-12-02T09:59:59.999Z',
          },
        }),
      ).rejects.toThrow(DeadlineViolationError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-06b: succeeds when delivery_deadline equals bidding_deadline + 24h + 1ms (BR-12 boundary)', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({ version: 1 });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockImplementation(async ({ request }) => request),
      };

      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      // 2026-12-01T10:00:00.000Z + 24h + 1ms = 2026-12-02T10:00:00.001Z
      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
        draft: {
          bidding_deadline: '2026-12-01T10:00:00.000Z',
          delivery_deadline: '2026-12-02T10:00:00.001Z',
        },
      });

      expect(result.version).toBe(2);
      expect(result.bidding_deadline?.toISOString()).toBe('2026-12-01T10:00:00.000Z');
      expect(result.delivery_deadline?.toISOString()).toBe('2026-12-02T10:00:00.001Z');
      expect(singleRepo.update).toHaveBeenCalled();
    });

    it('UT-07: throws TradingPermissionDeniedError when actor is not the buyer who created the quote request', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({ buyer_id: '10', version: 1 });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: otherBuyerActor, // accountId: '99'
          requestId: '100',
          expectedRequestVersion: 1,
          draft: { spec: 'Unauthorized update attempt' },
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-08: throws TradingResourceNotFoundError when quote request does not exist', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      };

      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '9999',
          expectedRequestVersion: 1,
          draft: { spec: 'Non-existent quote request' },
        }),
      ).rejects.toThrow(TradingResourceNotFoundError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-09: field sanitization clears unit_set_description to null when unit === "piece"', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({
        unit: 'set',
        unit_set_description: 'Previous set description',
        version: 1,
      });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockImplementation(async ({ request }) => request),
      };

      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
        draft: {
          unit: 'piece',
          unit_set_description: 'Ignored because unit is piece',
        },
      });

      expect(result.unit).toBe('piece');
      expect(result.unit_set_description).toBeNull();
    });

    it('UT-10: field sanitization clears delivery_region and delivery_address to null when delivery_mode === "at_workshop"', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleDraftQuoteRequest({
        delivery_mode: 'at_buyer_address',
        delivery_region: 'HN',
        delivery_address: '123 Old St',
        version: 1,
      });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockImplementation(async ({ request }) => request),
      };

      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
        draft: {
          delivery_mode: 'at_workshop',
          delivery_region: 'HCM',
          delivery_address: 'Should be cleared',
        },
      });

      expect(result.delivery_mode).toBe('at_workshop');
      expect(result.delivery_region).toBeNull();
      expect(result.delivery_address).toBeNull();
    });

    it('UT-11: rejects execution immediately if actor role is not buyer', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { lockById: vi.fn(), update: vi.fn() };
      const useCase = new UpdateDraftQuoteRequestUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '100',
          expectedRequestVersion: 1,
          draft: {},
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(singleRepo.lockById).not.toHaveBeenCalled();
      expect(singleRepo.update).not.toHaveBeenCalled();
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

    it('HTTP-01: PUT /buyer/quote-requests/:id succeeds with 200 OK and enveloped response for Buyer', async () => {
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
          category_id: '3',
          spec: 'High Quality Ceramic Teapots',
          quantity: 300,
          unit: 'piece',
          delivery_mode: 'at_buyer_address',
          delivery_region: 'HN',
          delivery_address: '789 Craft Blvd',
          recipient_name: 'Le Van C',
          recipient_phone: '0933221100',
          bidding_deadline: '2026-12-01T10:00:00.000Z',
          delivery_deadline: '2026-12-15T10:00:00.000Z',
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toMatchObject({
        id: '100',
        status: 'draft_request',
        version: 2,
        buyer_id: '10',
        spec: 'High Quality Ceramic Teapots',
        quantity: 300,
        unit: 'piece',
        is_bidding_open: false,
      });
      expect(json.data.updated_at).toBeDefined();
    });

    it('HTTP-02: PUT /buyer/quote-requests/:id rejects unexpected extra properties with 400 Bad Request', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          unrecognized_property: 'injected_attack_field',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors[0].field).toBe('/unrecognized_property');
    });

    it('HTTP-03: PUT /buyer/quote-requests/:id rejects missing or non-positive expected_request_version with 400', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 0, // Invalid: must be positive
          spec: 'Valid spec',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors.some((e: any) => e.field === '/expected_request_version')).toBe(true);
    });

    it('HTTP-04: PUT /buyer/quote-requests/:id rejects unauthenticated request with 401 AUTHENTICATION_REQUIRED', async () => {
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
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('HTTP-05: PUT /buyer/quote-requests/:id rejects artisan actor with 403 PERMISSION_DENIED', async () => {
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
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('HTTP-06: PUT /buyer/quote-requests/:id returns 403 PERMISSION_DENIED when buyer is not the owner', async () => {
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
          spec: 'Attempting to hijack quote request',
        }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('HTTP-07: PUT /buyer/quote-requests/:id returns 404 RESOURCE_NOT_FOUND when quote request does not exist', async () => {
      currentQuoteRequest = null;
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/9999`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          spec: 'Updated spec',
        }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('HTTP-08: PUT /buyer/quote-requests/:id returns 409 CONCURRENCY_CONFLICT on stale expected_request_version', async () => {
      currentQuoteRequest = createSampleDraftQuoteRequest({ id: '100', version: 2 });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1, // Stale
          spec: 'Updated spec with stale version',
        }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe('CONCURRENCY_CONFLICT');
    });

    it('HTTP-09: PUT /buyer/quote-requests/:id returns 422 DEADLINE_VIOLATION when delivery_deadline <= bidding_deadline + 24h', async () => {
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
          bidding_deadline: '2026-12-01T10:00:00.000Z',
          delivery_deadline: '2026-12-01T18:00:00.000Z', // 8 hours gap
        }),
      });

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.code).toBe('DEADLINE_VIOLATION');
    });

    it('HTTP-10: PUT /buyer/quote-requests/:id returns 422 INVALID_STATE when quote request is not in draft status', async () => {
      currentQuoteRequest = createSampleDraftQuoteRequest({
        id: '100',
        status: 'sent_to_artisans',
        version: 1,
      });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          spec: 'Attempting to edit sent request',
        }),
      });

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.code).toBe('INVALID_STATE');
    });

    it('HTTP-08b: PUT /buyer/quote-requests/:id returns 409 CONCURRENCY_CONFLICT when expected_request_version is higher than DB version', async () => {
      currentQuoteRequest = createSampleDraftQuoteRequest({ id: '100', version: 2 });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 5, // Higher than DB version (2)
          spec: 'Updated spec with future version',
        }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe('CONCURRENCY_CONFLICT');
    });

    it('HTTP-09a: PUT /buyer/quote-requests/:id returns 422 DEADLINE_VIOLATION when delivery_deadline is bidding_deadline + 24h - 1ms', async () => {
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
          bidding_deadline: '2026-12-01T10:00:00.000Z',
          delivery_deadline: '2026-12-02T09:59:59.999Z', // 24h - 1ms
        }),
      });

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.code).toBe('DEADLINE_VIOLATION');
    });

    it('HTTP-09b: PUT /buyer/quote-requests/:id returns 422 DEADLINE_VIOLATION when delivery_deadline exactly equals bidding_deadline + 24h', async () => {
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
          bidding_deadline: '2026-12-01T10:00:00.000Z',
          delivery_deadline: '2026-12-02T10:00:00.000Z', // Exactly 24h
        }),
      });

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.code).toBe('DEADLINE_VIOLATION');
    });

    it('HTTP-09c: PUT /buyer/quote-requests/:id returns 200 OK when delivery_deadline is bidding_deadline + 24h + 1ms', async () => {
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
          bidding_deadline: '2026-12-01T10:00:00.000Z',
          delivery_deadline: '2026-12-02T10:00:00.001Z', // 24h + 1ms
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.version).toBe(2);
      expect(json.data.delivery_deadline).toBe('2026-12-02T10:00:00.001Z');
    });

    it('HTTP-10b: PUT /buyer/quote-requests/:id returns 422 INVALID_STATE when quote request is in artisans_bidding or buyer_accepted', async () => {
      const nonDraftStatuses = ['artisans_bidding', 'buyer_accepted'] as const;

      for (const status of nonDraftStatuses) {
        currentQuoteRequest = createSampleDraftQuoteRequest({
          id: '100',
          status,
          version: 1,
        });
        identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

        const res = await fetch(`${base}/buyer/quote-requests/100`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=valid-buyer-token',
          },
          body: JSON.stringify({
            expected_request_version: 1,
            spec: `Attempting to edit ${status} request`,
          }),
        });

        expect(res.status).toBe(422);
        const json = await res.json();
        expect(json.code).toBe('INVALID_STATE');
      }
    });

    it('HTTP-10c: PUT /buyer/quote-requests/:id returns 422 INVALID_STATE when quote request is cancelled', async () => {
      currentQuoteRequest = createSampleDraftQuoteRequest({
        id: '100',
        status: 'sent_to_artisans',
        cancelled_at: new Date('2026-11-10T15:00:00.000Z'),
        cancelled_by: '10',
        cancel_reason: 'Buyer cancelled request',
        version: 1,
      });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          spec: 'Attempting to edit cancelled draft',
        }),
      });

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.code).toBe('INVALID_STATE');
    });
  });
});
