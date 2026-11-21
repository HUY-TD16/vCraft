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
import { UpdateRecipientContactUseCase } from '../../../../src/modules/trading/application/use-cases/requests/update-recipient-contact.use-case';
import { BuyerQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/buyer-quote-request.controller';
import {
  ConcurrencyConflictError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  QuoteRequest,
  type QuoteRequestProps,
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
let lastSavedContactEditHistory: any = null;

const mockRepo = {
  createDraft: vi.fn(),
  lockById: vi.fn().mockImplementation(async (id: string) => {
    if (currentQuoteRequest && currentQuoteRequest.id === id) {
      return currentQuoteRequest;
    }
    return null;
  }),
  update: vi.fn().mockImplementation(async ({ request, contactEditHistory }: any) => {
    currentQuoteRequest = request;
    lastSavedContactEditHistory = contactEditHistory;
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
      provide: UpdateRecipientContactUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new UpdateRecipientContactUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
  ],
})(TestTradingModule);

describe('Task 8: Sửa thông tin người nhận hàng (UC-14, BR-11, BR-27)', () => {
  describe('UpdateRecipientContactUseCase (Domain & Application Logic)', () => {
    it('UT-01: successfully updates recipient name and phone on sent request, increments version to 2, and records ContactEditHistory', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({ version: 1 });
      let savedHistory: any = null;

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockImplementation(async ({ request, contactEditHistory }) => {
          savedHistory = contactEditHistory;
          return request;
        }),
      };

      const useCase = new UpdateRecipientContactUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
        recipientName: 'Trần Văn Nhận',
        recipientPhone: '0988776655',
      });

      expect(singleRepo.lockById).toHaveBeenCalledWith('100', expect.anything());
      expect(singleRepo.update).toHaveBeenCalledWith(
        {
          request: expect.any(Object),
          expectedVersion: 1,
          contactEditHistory: expect.any(Object),
        },
        expect.anything(),
      );

      expect(result.id).toBe('100');
      expect(result.version).toBe(2);
      expect(result.recipient_name).toBe('Trần Văn Nhận');
      expect(result.recipient_phone).toBe('0988776655');

      expect(savedHistory).toBeDefined();
      expect(savedHistory.request_id).toBe('100');
      expect(savedHistory.edited_by).toBe('10');
      expect(savedHistory.prev_recipient_name).toBe('Nguyen Van An');
      expect(savedHistory.prev_recipient_phone).toBe('0987654321');
      expect(savedHistory.new_recipient_name).toBe('Trần Văn Nhận');
      expect(savedHistory.new_recipient_phone).toBe('0988776655');
      expect(savedHistory.version).toBe(2);
      expect(savedHistory.edited_at).toBeInstanceOf(Date);
    });

    it('UT-02: successfully updates contact on other active post-sent statuses (artisans_bidding, buyer_accepted, in_production)', async () => {
      const txRunner = new MockTransactionRunner();
      const allowedStatuses = [
        'artisans_bidding',
        'buyer_accepted',
        'in_production',
      ] as const;

      for (const status of allowedStatuses) {
        const existing = createSampleSentQuoteRequest({ status, version: 3 });
        let capturedUpdate: any = null;

        const singleRepo = {
          lockById: vi.fn().mockResolvedValue(existing),
          update: vi.fn().mockImplementation(async ({ request, contactEditHistory }) => {
            capturedUpdate = { request, contactEditHistory };
            return request;
          }),
        };

        const useCase = new UpdateRecipientContactUseCase(
          txRunner as any,
          singleRepo as any,
        );

        const result = await useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 3,
          recipientName: `Updated For ${status}`,
          recipientPhone: '0911223344',
        });

        expect(result.status).toBe(status);
        expect(result.version).toBe(4);
        expect(result.recipient_name).toBe(`Updated For ${status}`);
        expect(capturedUpdate.contactEditHistory.prev_recipient_name).toBe('Nguyen Van An');
        expect(capturedUpdate.contactEditHistory.new_recipient_name).toBe(`Updated For ${status}`);
        expect(capturedUpdate.contactEditHistory.version).toBe(4);
      }
    });

    it('UT-03: successfully updates ONLY recipient_name while preserving recipient_phone', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({
        recipient_name: 'Nguyen Van An',
        recipient_phone: '0987654321',
        version: 1,
      });

      let savedHistory: any = null;
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockImplementation(async ({ request, contactEditHistory }) => {
          savedHistory = contactEditHistory;
          return request;
        }),
      };

      const useCase = new UpdateRecipientContactUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
        recipientName: 'Lê Hoàng Nam',
      });

      expect(result.recipient_name).toBe('Lê Hoàng Nam');
      expect(result.recipient_phone).toBe('0987654321');
      expect(result.version).toBe(2);

      expect(savedHistory.prev_recipient_name).toBe('Nguyen Van An');
      expect(savedHistory.new_recipient_name).toBe('Lê Hoàng Nam');
      expect(savedHistory.prev_recipient_phone).toBe('0987654321');
      expect(savedHistory.new_recipient_phone).toBe('0987654321');
    });

    it('UT-04: successfully updates ONLY recipient_phone while preserving recipient_name', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({
        recipient_name: 'Nguyen Van An',
        recipient_phone: '0987654321',
        version: 1,
      });

      let savedHistory: any = null;
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockImplementation(async ({ request, contactEditHistory }) => {
          savedHistory = contactEditHistory;
          return request;
        }),
      };

      const useCase = new UpdateRecipientContactUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
        recipientPhone: '0933445566',
      });

      expect(result.recipient_name).toBe('Nguyen Van An');
      expect(result.recipient_phone).toBe('0933445566');
      expect(result.version).toBe(2);

      expect(savedHistory.prev_recipient_name).toBe('Nguyen Van An');
      expect(savedHistory.new_recipient_name).toBe('Nguyen Van An');
      expect(savedHistory.prev_recipient_phone).toBe('0987654321');
      expect(savedHistory.new_recipient_phone).toBe('0933445566');
    });

    it('UT-05: throws ConcurrencyConflictError when expected_request_version is stale or does not match', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({ version: 5 });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateRecipientContactUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 4, // stale version
          recipientName: 'New Contact Name',
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 99, // future version
          recipientName: 'New Contact Name',
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-06: throws TradingPermissionDeniedError when actor role is not buyer', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { lockById: vi.fn(), update: vi.fn() };
      const useCase = new UpdateRecipientContactUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '100',
          expectedRequestVersion: 1,
          recipientName: 'Hacker Name',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(singleRepo.lockById).not.toHaveBeenCalled();
      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-07: throws TradingPermissionDeniedError when buyer does not own the QuoteRequest', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({ buyer_id: '10', version: 1 });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateRecipientContactUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: otherBuyerActor, // accountId 99
          requestId: '100',
          expectedRequestVersion: 1,
          recipientName: 'Other Buyer Attempt',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-08: throws QuoteRequestNotFoundError when requestId does not exist', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      };

      const useCase = new UpdateRecipientContactUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '999999',
          expectedRequestVersion: 1,
          recipientName: 'Ghost Request',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-09: throws InvalidStateTransitionError when QuoteRequest is in draft_request status (BR-11)', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({
        status: 'draft_request',
        version: 1,
      });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateRecipientContactUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          recipientName: 'Should Fail On Draft',
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-10: throws InvalidStateTransitionError when QuoteRequest is in delivered status', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({
        status: 'delivered',
        version: 1,
      });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateRecipientContactUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          recipientName: 'Should Fail On Delivered',
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-11: throws InvalidStateTransitionError when QuoteRequest is cancelled', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({
        cancelled_at: new Date('2026-11-10T12:00:00.000Z'),
        cancelled_by: '10',
        cancel_reason: 'Buyer cancelled',
        version: 1,
      });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateRecipientContactUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          recipientName: 'Should Fail On Cancelled',
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-12: throws InvalidTradingInputError when both recipient_name and recipient_phone are unchanged', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({
        recipient_name: 'Nguyen Van An',
        recipient_phone: '0987654321',
        version: 1,
      });

      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateRecipientContactUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          recipientName: 'Nguyen Van An',
          recipientPhone: '0987654321',
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      expect(singleRepo.update).not.toHaveBeenCalled();
    });

    it('UT-13: throws InvalidTradingInputError when neither recipient_name nor recipient_phone is provided', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { lockById: vi.fn(), update: vi.fn() };
      const useCase = new UpdateRecipientContactUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      expect(singleRepo.lockById).not.toHaveBeenCalled();
    });

    it('UT-14: throws InvalidTradingInputError when recipient_name is empty or whitespace only', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({ version: 1 });
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateRecipientContactUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          recipientName: '   ',
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('UT-15: throws InvalidTradingInputError when recipient_phone is empty or whitespace only', async () => {
      const txRunner = new MockTransactionRunner();
      const existing = createSampleSentQuoteRequest({ version: 1 });
      const singleRepo = {
        lockById: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
      };

      const useCase = new UpdateRecipientContactUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          recipientPhone: '   ',
        }),
      ).rejects.toThrow(InvalidTradingInputError);
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

    it('HTTP-01: PATCH /buyer/quote-requests/:id/contact succeeds with 200 OK and enveloped response for Buyer', async () => {
      currentQuoteRequest = createSampleSentQuoteRequest({ id: '100', version: 1 });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/contact`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          recipient_name: 'Trần Văn Mới',
          recipient_phone: '0977889900',
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
        recipient_name: 'Trần Văn Mới',
        recipient_phone: '0977889900',
      });
      expect(lastSavedContactEditHistory).toBeDefined();
      expect(lastSavedContactEditHistory.version).toBe(2);
      expect(lastSavedContactEditHistory.new_recipient_name).toBe('Trần Văn Mới');
    });

    it('HTTP-02: rejects unauthorized request with 401 Authentication Required', async () => {
      const res = await fetch(`${base}/buyer/quote-requests/100/contact`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          recipient_name: 'Unauthorized Test',
        }),
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('HTTP-03: rejects artisan actor with 403 Forbidden', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/contact`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-artisan-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          recipient_name: 'Artisan Attempt',
        }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('HTTP-04: rejects non-owner Buyer with 403 Forbidden', async () => {
      currentQuoteRequest = createSampleSentQuoteRequest({ id: '100', buyer_id: '10', version: 1 });
      identityMock.resolveSession.mockResolvedValueOnce(otherBuyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/contact`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=other-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          recipient_name: 'Other Buyer Injected',
        }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('HTTP-05: rejects stale expected_request_version with 409 Concurrency Conflict', async () => {
      currentQuoteRequest = createSampleSentQuoteRequest({ id: '100', version: 2 });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/contact`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1, // stale
          recipient_name: 'Stale Version Test',
        }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe('CONCURRENCY_CONFLICT');
    });

    it('HTTP-06: rejects unrecognized extra properties with 400 Bad Request (z.strictObject)', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/contact`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          recipient_name: 'Valid Name',
          unrecognized_property: 'malicious_input',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors[0].field).toBe('/unrecognized_property');
    });

    it('HTTP-07: rejects empty or invalid expected_request_version with 400 Bad Request', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/contact`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: -1, // non-positive
          recipient_name: 'Invalid Version',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors[0].field).toBe('/expected_request_version');
    });

    it('HTTP-08: rejects when neither recipient_name nor recipient_phone is provided with 400 Bad Request', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/contact`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors[0].field).toBe('/recipient_name');
    });

    it('HTTP-09: rejects when quote request is in draft_request status with 422 InvalidStateTransition', async () => {
      currentQuoteRequest = createSampleSentQuoteRequest({
        id: '100',
        status: 'draft_request',
        version: 1,
      });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/contact`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          recipient_name: 'Draft Status Update',
        }),
      });

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.code).toBe('INVALID_STATE');
    });

    it('HTTP-10: rejects when quote request is delivered with 422 InvalidStateTransition', async () => {
      currentQuoteRequest = createSampleSentQuoteRequest({
        id: '100',
        status: 'delivered',
        version: 1,
      });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/contact`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          recipient_name: 'Delivered Status Update',
        }),
      });

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.code).toBe('INVALID_STATE');
    });

    it('HTTP-11: rejects when quote request is cancelled with 422 InvalidStateTransition', async () => {
      currentQuoteRequest = createSampleSentQuoteRequest({
        id: '100',
        status: 'sent_to_artisans',
        cancelled_at: new Date('2026-11-10T12:00:00.000Z'),
        cancelled_by: '10',
        cancel_reason: 'Cancelled by Buyer',
        version: 1,
      });
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/contact`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
          recipient_name: 'Cancelled Status Update',
        }),
      });

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.code).toBe('INVALID_STATE');
    });
  });
});
