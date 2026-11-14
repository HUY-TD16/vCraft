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
import { CloseBiddingUseCase } from '../../../../src/modules/trading/application/use-cases/requests/close-bidding.use-case';
import { BuyerQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/buyer-quote-request.controller';
import {
  BiddingClosedError,
  ConcurrencyConflictError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  Quote,
  QuoteRequest,
  type QuoteRequestProps,
  RequestRecipient,
  TradingPermissionDeniedError,
  QuoteRequestNotFoundError,
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

function createSampleSentQuoteRequest(
  overrides: Partial<QuoteRequestProps> = {},
): QuoteRequest {
  const now = new Date('2026-11-10T10:00:00.000Z');
  return QuoteRequest.reconstitute({
    id: '100',
    buyer_id: '10',
    category_id: '1',
    spec: 'Bat Trang Glazed Tea Set Spec',
    quantity: 100,
    unit: 'piece',
    unit_set_description: null,
    status: 'sent_to_artisans',
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
let lastSavedStatusLogs: any[] = [];

const mockRepo = {
  createDraft: vi.fn(),
  lockById: vi.fn().mockImplementation(async (id: string) => {
    if (currentQuoteRequest && currentQuoteRequest.id === id) {
      return currentQuoteRequest;
    }
    return null;
  }),
  update: vi.fn().mockImplementation(async ({ request, statusLogs }: any) => {
    currentQuoteRequest = request;
    lastSavedStatusLogs = statusLogs ?? [];
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
      provide: CloseBiddingUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new CloseBiddingUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
  ],
})(TestTradingModule);

describe('Task 9: Đóng nhận báo giá sớm (UC-17, BR-12)', () => {
  describe('CloseBiddingUseCase (Domain & Application Logic)', () => {
    it('UT-01: successfully closes bidding early on sent_to_artisans request, increments version to 2, sets bidding_closed_at, and records StatusLog', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({
        status: 'sent_to_artisans',
        version: 1,
      });
      let savedLogs: any[] = [];

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockImplementation(async ({ request, statusLogs }) => {
          savedLogs = statusLogs ?? [];
          return request;
        }),
      };

      const useCase = new CloseBiddingUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const closeTime = new Date('2026-11-15T08:00:00.000Z');
      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
        now: closeTime,
      });

      expect(singleRepo.lockById).toHaveBeenCalledWith('100', expect.anything());
      expect(singleRepo.update).toHaveBeenCalledWith(
        {
          request: expect.any(Object),
          expectedVersion: 1,
          statusLogs: expect.any(Array),
        },
        expect.anything(),
      );

      expect(result.id).toBe('100');
      expect(result.version).toBe(2);
      expect(result.status).toBe('sent_to_artisans');
      expect(result.bidding_closed_at).toEqual(closeTime);
      expect(result.isBiddingOpenAt(closeTime)).toBe(false);

      expect(savedLogs).toHaveLength(1);
      const log = savedLogs[0];
      expect(log.request_id).toBe('100');
      expect(log.event_type).toBe('bidding_closed');
      expect(log.prev_status).toBe('sent_to_artisans');
      expect(log.new_status).toBe('sent_to_artisans');
      expect(log.performed_by).toBe('10');
      expect(log.is_admin_action).toBe(false);
      expect(log.created_at).toEqual(closeTime);
    });

    it('UT-02: successfully closes bidding early on artisans_bidding request, increments version from 2 to 3', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({
        status: 'artisans_bidding',
        version: 2,
      });

      let savedLogs: any[] = [];
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockImplementation(async ({ request, statusLogs }) => {
          savedLogs = statusLogs ?? [];
          return request;
        }),
      };

      const useCase = new CloseBiddingUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const closeTime = new Date('2026-11-20T12:00:00.000Z');
      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 2,
        now: closeTime,
      });

      expect(result.status).toBe('artisans_bidding');
      expect(result.version).toBe(3);
      expect(result.bidding_closed_at).toEqual(closeTime);
      expect(savedLogs[0].event_type).toBe('bidding_closed');
      expect(savedLogs[0].prev_status).toBe('artisans_bidding');
      expect(savedLogs[0].new_status).toBe('artisans_bidding');
    });

    it('UT-03: isBiddingOpenAt returns false after bidding is closed', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({ version: 1 });
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockImplementation(async ({ request }) => request),
      };
      const useCase = new CloseBiddingUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const closeTime = new Date('2026-11-15T08:00:00.000Z');
      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
        now: closeTime,
      });

      expect(result.isBiddingOpenAt(new Date('2026-11-16T00:00:00.000Z'))).toBe(false);
      expect(result.isBiddingOpenAt(new Date('2026-11-14T00:00:00.000Z'))).toBe(false);
    });

    it('UT-04: verifies quotes cannot be submitted or updated after bidding is closed', async () => {
      const baseNow = new Date('2026-11-15T08:00:00.000Z');
      const closedRequest = createSampleSentQuoteRequest({
        status: 'artisans_bidding',
        bidding_closed_at: baseNow,
        version: 2,
      });

      const recipient = RequestRecipient.reconstitute({
        id: '201',
        request_id: '100',
        workshop_id: '200',
        response_status: 'quoted',
        decline_reason: null,
        responded_by: '20',
        responded_at: baseNow,
        sent_at: baseNow,
        version: 2,
      });

      const existingQuote = Quote.reconstitute({
        id: '301',
        request_id: '100',
        workshop_id: '200',
        unit_price: 150_000,
        max_quantity: 50,
        bid_accept_deadline: new Date('2026-12-05T10:00:00.000Z'),
        committed_delivery_at: new Date('2026-12-10T10:00:00.000Z'),
        status: 'active',
        version: 1,
        withdraw_reason: null,
        withdrawn_by: null,
        withdrawn_at: null,
        created_at: baseNow,
        updated_at: baseNow,
      });

      expect(() =>
        existingQuote.updateOrResubmit({
          request: closedRequest,
          recipient,
          actorId: '20',
          expectedQuoteVersion: 1,
          workshopIsActive: true,
          unitPrice: 160_000,
          maxQuantity: 60,
          bidAcceptDeadline: new Date('2026-12-05T10:00:00.000Z'),
          committedDeliveryAt: new Date('2026-12-10T10:00:00.000Z'),
          now: baseNow,
        }),
      ).toThrow(BiddingClosedError);
    });

    it('UT-05: verifies quote can STILL be withdrawn after bidding is closed (BR-15)', async () => {
      const baseNow = new Date('2026-11-15T08:00:00.000Z');
      const closedRequest = createSampleSentQuoteRequest({
        status: 'artisans_bidding',
        bidding_closed_at: baseNow,
        version: 2,
      });

      const recipient = RequestRecipient.reconstitute({
        id: '201',
        request_id: '100',
        workshop_id: '200',
        response_status: 'quoted',
        decline_reason: null,
        responded_by: '20',
        responded_at: baseNow,
        sent_at: baseNow,
        version: 2,
      });

      const existingQuote = Quote.reconstitute({
        id: '301',
        request_id: '100',
        workshop_id: '200',
        unit_price: 150_000,
        max_quantity: 50,
        bid_accept_deadline: new Date('2026-12-05T10:00:00.000Z'),
        committed_delivery_at: new Date('2026-12-10T10:00:00.000Z'),
        status: 'active',
        version: 1,
        withdraw_reason: null,
        withdrawn_by: null,
        withdrawn_at: null,
        created_at: baseNow,
        updated_at: baseNow,
      });

      const { quote: withdrawnQuote, recipient: updatedRecipient } =
        existingQuote.withdraw({
          request: closedRequest,
          recipient,
          actorId: '20',
          expectedQuoteVersion: 1,
          withdrawReason: 'Xưởng gặp sự cố quá tải lò nung',
          now: baseNow,
        });

      expect(withdrawnQuote.status).toBe('withdrawn');
      expect(withdrawnQuote.withdraw_reason).toBe('Xưởng gặp sự cố quá tải lò nung');
      expect(updatedRecipient.response_status).toBe('withdrawn');
    });

    it('UT-06: throws ConcurrencyConflictError when expected_request_version does not match current version', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({ version: 5 });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new CloseBiddingUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 4, // stale
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 99, // future
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-07: throws TradingPermissionDeniedError when actor role is not buyer', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { lockById: vi.fn(), update: vi.fn() };
      const useCase = new CloseBiddingUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(singleRepo.lockById).not.toHaveBeenCalled();
    });

    it('UT-08: throws TradingPermissionDeniedError when buyer does not own the QuoteRequest', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({ buyer_id: '10', version: 1 });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new CloseBiddingUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: otherBuyerActor, // buyer_id 99
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-09: throws QuoteRequestNotFoundError when QuoteRequest is not found', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      };

      const useCase = new CloseBiddingUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '9999',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);
    });

    it('UT-10: throws InvalidTradingInputError when requestId is missing or empty', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { lockById: vi.fn(), update: vi.fn() };
      const useCase = new CloseBiddingUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          expectedRequestVersion: 1,
        } as any),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('UT-11: throws InvalidTradingInputError when expected_request_version is invalid or missing', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { lockById: vi.fn(), update: vi.fn() };
      const useCase = new CloseBiddingUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
        } as any),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 0,
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: -5,
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1.5,
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('UT-12: throws InvalidStateTransitionError when QuoteRequest is still in draft_request status', async () => {
      const txRunner = new MockTransactionRunner();
      const draft = QuoteRequest.reconstitute({
        id: '100',
        buyer_id: '10',
        category_id: null,
        spec: null,
        quantity: null,
        unit: null,
        unit_set_description: null,
        status: 'draft_request',
        delivery_mode: null,
        delivery_region: null,
        delivery_address: null,
        recipient_name: null,
        recipient_phone: null,
        bidding_deadline: null,
        delivery_deadline: null,
        bidding_closed_at: null,
        split_requested_at: null,
        version: 1,
        cancelled_at: null,
        cancelled_by: null,
        cancel_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(draft),
        update: vi.fn(),
      };

      const useCase = new CloseBiddingUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('UT-13: throws InvalidStateTransitionError when QuoteRequest is already accepted, in production, or delivered', async () => {
      const txRunner = new MockTransactionRunner();
      const terminalStatuses = ['buyer_accepted', 'in_production', 'delivered'] as const;

      for (const status of terminalStatuses) {
        const postSent = createSampleSentQuoteRequest({
          status,
          version: 2,
        });

        const singleRepo = {
          lockById: vi.fn().mockResolvedValue(postSent),
          update: vi.fn(),
        };

        const useCase = new CloseBiddingUseCase(
          txRunner as any,
          singleRepo as any,
        );

        await expect(
          useCase.execute({
            actor: buyerActor,
            requestId: '100',
            expectedRequestVersion: 2,
          }),
        ).rejects.toThrow(InvalidStateTransitionError);
      }
    });

    it('UT-14: throws InvalidStateTransitionError when QuoteRequest is cancelled', async () => {
      const txRunner = new MockTransactionRunner();
      const cancelled = createSampleSentQuoteRequest({
        status: 'sent_to_artisans',
        cancelled_at: new Date('2026-11-12T10:00:00.000Z'),
        cancelled_by: '10',
        cancel_reason: 'Buyer cancelled request',
        version: 2,
      });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(cancelled),
        update: vi.fn(),
      };

      const useCase = new CloseBiddingUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 2,
        }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('UT-15: throws BiddingClosedError when bidding has already been closed', async () => {
      const txRunner = new MockTransactionRunner();
      const alreadyClosed = createSampleSentQuoteRequest({
        status: 'sent_to_artisans',
        bidding_closed_at: new Date('2026-11-12T10:00:00.000Z'),
        version: 2,
      });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(alreadyClosed),
        update: vi.fn(),
      };

      const useCase = new CloseBiddingUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 2,
        }),
      ).rejects.toThrow(BiddingClosedError);
    });

    it('UT-16: throws BiddingClosedError when current time is at or past bidding_deadline', async () => {
      const txRunner = new MockTransactionRunner();
      const pastDeadline = createSampleSentQuoteRequest({
        status: 'sent_to_artisans',
        bidding_deadline: new Date('2026-11-12T10:00:00.000Z'),
        bidding_closed_at: null,
        version: 1,
      });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(pastDeadline),
        update: vi.fn(),
      };

      const useCase = new CloseBiddingUseCase(
        txRunner as any,
        singleRepo as any,
      );

      // Current time is past bidding_deadline
      const pastTime = new Date('2026-11-12T10:00:01.000Z');
      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          now: pastTime,
        }),
      ).rejects.toThrow(BiddingClosedError);
    });

    it('UT-17: runs within existing input.tx without opening a new transaction runner', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({ version: 1 });
      const mockTx = { id: 'mock-tx-context' } as any;

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockImplementation(async ({ request }) => request),
      };

      const useCase = new CloseBiddingUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const spyRun = vi.spyOn(txRunner, 'run');

      await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
        tx: mockTx,
      });

      expect(spyRun).not.toHaveBeenCalled();
      expect(singleRepo.lockById).toHaveBeenCalledWith('100', mockTx);
      expect(singleRepo.update).toHaveBeenCalledWith(expect.anything(), mockTx);
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

    it('HTTP-01: POST /buyer/quote-requests/:id/close-bidding succeeds with 200 OK and enveloped response for Buyer', async () => {
      currentQuoteRequest = createSampleSentQuoteRequest({ id: '100', version: 1 });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/close-bidding`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toMatchObject({
        id: '100',
        status: 'sent_to_artisans',
        version: 2,
        buyer_id: '10',
        is_bidding_open: false,
      });
      expect(json.data.bidding_closed_at).toBeDefined();
      expect(typeof json.data.bidding_closed_at).toBe('string');
      expect(lastSavedStatusLogs).toHaveLength(1);
      expect(lastSavedStatusLogs[0].event_type).toBe('bidding_closed');
    });

    it('HTTP-02: rejects unauthorized request with 401 Authentication Required', async () => {
      const res = await fetch(`${base}/buyer/quote-requests/100/close-bidding`, {
        method: 'POST',
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

    it('HTTP-03: rejects artisan actor with 403 Forbidden', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/close-bidding`, {
        method: 'POST',
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

    it('HTTP-04: rejects non-owner Buyer with 403 Forbidden', async () => {
      currentQuoteRequest = createSampleSentQuoteRequest({ id: '100', buyer_id: '10', version: 1 });
      identityMock.resolveSession.mockResolvedValueOnce(otherBuyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/close-bidding`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=other-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
        }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('HTTP-05: rejects stale expected_request_version with 409 Concurrency Conflict', async () => {
      currentQuoteRequest = createSampleSentQuoteRequest({ id: '100', version: 2 });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/close-bidding`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1, // stale
        }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe('CONCURRENCY_CONFLICT');
    });

    it('HTTP-06: rejects unrecognized extra properties with 400 Bad Request (z.strictObject)', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/close-bidding`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          unrecognized_property: 'malicious_input',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('HTTP-07: rejects invalid expected_request_version (<= 0 or non-integer) with 400 Bad Request', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/close-bidding`, {
        method: 'POST',
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
    });

    it('HTTP-08: returns 404 Resource Not Found when QuoteRequest does not exist', async () => {
      currentQuoteRequest = null;
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/9999/close-bidding`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
        }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('HTTP-09: returns 422 Invalid State when QuoteRequest is a draft', async () => {
      currentQuoteRequest = QuoteRequest.reconstitute({
        id: '100',
        buyer_id: '10',
        category_id: null,
        spec: null,
        quantity: null,
        unit: null,
        unit_set_description: null,
        status: 'draft_request',
        delivery_mode: null,
        delivery_region: null,
        delivery_address: null,
        recipient_name: null,
        recipient_phone: null,
        bidding_deadline: null,
        delivery_deadline: null,
        bidding_closed_at: null,
        split_requested_at: null,
        version: 1,
        cancelled_at: null,
        cancelled_by: null,
        cancel_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/close-bidding`, {
        method: 'POST',
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

    it('HTTP-10: returns 422 Bidding Closed when bidding is already closed', async () => {
      currentQuoteRequest = createSampleSentQuoteRequest({
        id: '100',
        bidding_closed_at: new Date('2026-11-12T10:00:00.000Z'),
        version: 2,
      });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/close-bidding`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 2,
        }),
      });

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.code).toBe('BIDDING_CLOSED');
    });
  });
});
