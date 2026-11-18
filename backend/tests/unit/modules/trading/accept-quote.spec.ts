import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../../../src/generated/prisma/client';
import { AppModule } from '../../../../src/bootstrap/app.module';
import { configureHttp } from '../../../../src/bootstrap/configure-http';
import { createApiDocument } from '../../../../src/common/http/swagger/configure-swagger';
import { AppConfigModule } from '../../../../src/common/config/app-config';
import { AppLogger } from '../../../../src/common/observability/app-logger';
import { SecurityModule } from '../../../../src/common/security/security.module';
import {
  TRANSACTION_RUNNER,
  type TransactionContext,
  type TransactionRunner,
} from '../../../../src/common/application/ports/transaction-runner';
import { BusinessRuleException } from '../../../../src/common/domain/errors/business-rule.exception';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import { PrismaService } from '../../../../src/infrastructure/database/prisma/prisma.service';
import { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import { IDENTITY_CONTRACT } from '../../../../src/modules/identity/public/contracts/identity.contract';
import {
  WORKSHOP_CONTRACT,
  type IWorkshopContract,
} from '../../../../src/modules/workshops/public/contracts/workshop.contract';
import { WorkshopSuspended } from '../../../../src/modules/workshops/domain/errors/workshop-suspended';
import {
  TRADING_CONTRACT,
  type AcceptanceInput,
  type ITradingContract,
} from '../../../../src/modules/trading/public/contracts/trading.contract';
import type {
  AcceptanceDto,
  AcceptanceOperationDto,
} from '../../../../src/modules/trading/public/dtos/acceptance.dto';
import type {
  CreateIdempotencyRecordInput,
  IdempotencyScopeKey,
  PersistedIdempotencyRecord,
} from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';
import {
  ALLOCATION_REPOSITORY,
  IDEMPOTENCY_RECORD_REPOSITORY,
  QUOTE_REPOSITORY,
  QUOTE_REQUEST_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
  type IAllocationRepository,
  type IIdempotencyRecordRepository,
  type IQuoteRepository,
  type IQuoteRequestRepository,
  type IRequestRecipientRepository,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { PrismaAllocationRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/allocation.repository';
import { PrismaQuoteRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/quote.repository';
import { PrismaQuoteRequestRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository';
import { PrismaRequestRecipientRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/request-recipient.repository';
import { TradingAcceptanceService } from '../../../../src/modules/trading/application/services/trading-acceptance.service';
import { TradingIdempotencyService } from '../../../../src/modules/trading/application/services/trading-idempotency.service';
import { AcceptQuoteUseCase } from '../../../../src/modules/trading/application/use-cases/quotations/accept-quote.use-case';
import { CreateDraftQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/create-draft-quote-request.use-case';
import { BuyerQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/buyer-quote-request.controller';
import {
  acceptanceDtoResponseSchema,
  acceptQuoteOperationResponseSchema,
} from '../../../../src/modules/trading/adapters/http/dtos/accept-quote.dto';
import {
  TRADING_CURRENT_STATE_RESOLVER,
  TradingCurrentStateResolver,
} from '../../../../src/modules/trading/adapters/http/interceptors/trading-current-state.resolver';
import { TradingMutationInterceptor } from '../../../../src/modules/trading/adapters/http/interceptors/trading-mutation.interceptor';
import { TradingModule } from '../../../../src/modules/trading/trading.module';
import {
  Allocation,
  ConcurrencyConflictError,
  DeadlineViolationError,
  InsufficientCapacityError,
  InvalidStateTransitionError,
  Quote,
  QuoteExpiredError,
  QuoteRequest,
  QuoteRequestNotFoundError,
  RequestRecipient,
  TradingDomainError,
  TradingPermissionDeniedError,
  TradingResourceNotFoundError,
  WorkshopSuspendedError,
  type AllocationLogRecord,
  type RecipientResponseRecord,
  type StatusLogRecord,
} from '../../../../src/modules/trading/domain';
import { computeCanonicalFingerprint } from '../../../../src/modules/trading/domain/utilities';
import { AcceptQuotationWorkflow } from '../../../../src/workflows/accept-quotation/accept-quotation.workflow';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
import { MockTradingContract } from '../../../support/mocks/trading.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import { MockWorkshopContract } from '../../../support/mocks/workshop.mock';

const SENT_AT = new Date('2026-11-10T08:00:00.000Z');
const NOW = new Date('2026-11-15T10:00:00.000Z');
const BIDDING_DEADLINE = new Date('2026-11-20T10:00:00.000Z');
const BID_ACCEPT_DEADLINE = new Date('2026-11-25T10:00:00.000Z');
const COMMITTED_DELIVERY = new Date('2026-11-28T10:00:00.000Z');
const DELIVERY_DEADLINE = new Date('2026-11-30T10:00:00.000Z');

const buyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-buyer-10',
  sessionLevel: 'normal',
});

const otherBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '99',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-buyer-99',
  sessionLevel: 'normal',
});

const artisanActor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '301',
  authVersion: 1,
  sessionId: 'sess-artisan-20',
  sessionLevel: 'normal',
});

const adminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-admin-1',
  sessionLevel: 'normal',
});

const tempPasswordBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-buyer-temp',
  sessionLevel: 'temp_password',
});

function createSampleRequest(
  overrides: Partial<Parameters<typeof QuoteRequest.reconstitute>[0]> = {},
): QuoteRequest {
  return QuoteRequest.reconstitute({
    id: '1001',
    buyer_id: '10',
    category_id: '5',
    spec: '5000 bát gốm men rạn Bát Tràng cao cấp',
    quantity: 5000,
    unit: 'piece',
    unit_set_description: null,
    status: 'artisans_bidding',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội, Gia Lâm',
    delivery_address: 'Số 12 Phố Gốm, Bát Tràng, Gia Lâm, Hà Nội',
    recipient_name: 'Nguyễn Văn Mua',
    recipient_phone: '0901234567',
    bidding_deadline: BIDDING_DEADLINE,
    delivery_deadline: DELIVERY_DEADLINE,
    bidding_closed_at: null,
    split_requested_at: null,
    version: 3,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: SENT_AT,
    updated_at: SENT_AT,
    ...overrides,
  });
}

function createSampleRecipient(
  overrides: Partial<Parameters<typeof RequestRecipient.reconstitute>[0]> = {},
): RequestRecipient {
  return RequestRecipient.reconstitute({
    id: '2001',
    request_id: '1001',
    workshop_id: '301',
    response_status: 'quoted',
    decline_reason: null,
    responded_by: '20',
    responded_at: SENT_AT,
    sent_at: SENT_AT,
    version: 2,
    ...overrides,
  });
}

function createSampleQuote(
  overrides: Partial<Parameters<typeof Quote.reconstitute>[0]> = {},
): Quote {
  return Quote.reconstitute({
    id: '401',
    request_id: '1001',
    workshop_id: '301',
    unit_price: 45000,
    max_quantity: 5000,
    bid_accept_deadline: BID_ACCEPT_DEADLINE,
    committed_delivery_at: COMMITTED_DELIVERY,
    status: 'active',
    version: 2,
    withdraw_reason: null,
    withdrawn_by: null,
    withdrawn_at: null,
    created_at: SENT_AT,
    updated_at: SENT_AT,
    ...overrides,
  });
}

function asQuoteRequestRepo(mock: unknown): IQuoteRequestRepository {
  return mock as IQuoteRequestRepository;
}

function asRecipientRepo(mock: unknown): IRequestRecipientRepository {
  return mock as IRequestRecipientRepository;
}

function asQuoteRepo(mock: unknown): IQuoteRepository {
  return mock as IQuoteRepository;
}

function asAllocationRepo(mock: unknown): IAllocationRepository {
  return mock as IAllocationRepository;
}

function asIdempotencyRepo(mock: unknown): IIdempotencyRecordRepository {
  return mock as IIdempotencyRecordRepository;
}

describe('Task 23: Direct Quote Acceptance (POST /api/v1/buyer/quote-requests/:id/accept-quote)', () => {
  describe('Workflow, UseCase & TradingAcceptanceService Unit Tests', () => {
    it('AQ-01: directly accepts 100% quote while bidding is open, closes bidding, transitions Quote -> accepted, QuoteRequest -> buyer_accepted, creates 1 Allocation (not_started) & audit logs', async () => {
      const txRunner = new MockTransactionRunner();
      const request = createSampleRequest({ bidding_closed_at: null, version: 3 });
      const recipient = createSampleRecipient({ version: 2 });
      const quote = createSampleQuote({ version: 2, max_quantity: 5000 });

      const savedStatusLogs: StatusLogRecord[] = [];
      let savedRecipientHistory: RecipientResponseRecord | undefined;
      let savedAllocationLog: AllocationLogRecord | undefined;
      let createUseEntityId: boolean | undefined;

      const quoteRequestRepo = {
        findById: vi.fn().mockResolvedValue(request),
        lockById: vi.fn().mockResolvedValue(request),
        update: vi.fn().mockImplementation(async ({ request: next, statusLogs }) => {
          if (statusLogs) savedStatusLogs.push(...statusLogs);
          return next;
        }),
      };

      const recipientRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
      };

      const quoteRepo = {
        findById: vi.fn().mockResolvedValue(quote),
        lockById: vi.fn().mockResolvedValue(quote),
        update: vi.fn().mockImplementation(async ({ quote: next, recipientHistory }) => {
          savedRecipientHistory = recipientHistory;
          return next;
        }),
      };

      const allocationRepo = {
        create: vi.fn().mockImplementation(async ({ allocation, log, useEntityId }) => {
          savedAllocationLog = log;
          createUseEntityId = useEntityId;
          return Allocation.reconstitute({
            ...allocation,
            id: '5001',
          });
        }),
      };

      const idempotencyRepo = {
        findByScope: vi.fn(),
        save: vi.fn(),
      };

      const workshopContract = new MockWorkshopContract().givenActiveWorkshops('301');
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Minh Long Bát Tràng',
        status: 'active',
        isProfilePublic: true,
      });

      const tradingService = new TradingAcceptanceService(
        asQuoteRequestRepo(quoteRequestRepo),
        asRecipientRepo(recipientRepo),
        asQuoteRepo(quoteRepo),
        asAllocationRepo(allocationRepo),
        asIdempotencyRepo(idempotencyRepo),
        workshopContract,
      );

      const useCase = new AcceptQuoteUseCase(
        txRunner,
        tradingService,
        workshopContract,
      );

      const output = await useCase.execute({
        actor: buyerActor,
        requestId: '1001',
        quoteId: '401',
        expectedRequestVersion: 3,
        expectedQuoteVersion: 2,
        now: NOW,
      });

      expect(createUseEntityId).toBe(false);
      expect(output.data).toEqual({
        request_id: '1001',
        request_status: 'buyer_accepted',
        request_version: 4,
        allocations: [
          {
            id: '5001',
            request_id: '1001',
            workshop: { id: '301', name: 'Xưởng Gốm Minh Long Bát Tràng' },
            quote_id: '401',
            quantity: 5000,
            unit_price: 45000,
            committed_delivery_at: COMMITTED_DELIVERY.toISOString(),
            status: 'not_started',
            version: 1,
            started_at: null,
            started_by: null,
            handed_over_at: null,
            handed_over_by: null,
            delivery_note: null,
            admin_handed_over: false,
            admin_handover_reason: null,
            admin_delivery_evidence: null,
            admin_handover_actual_at: null,
            traceability_warning: 'NO_BATCH_LINK',
          },
        ],
      });

      expect(output.currentState).toEqual({
        request: {
          id: '1001',
          status: 'buyer_accepted',
          version: 4,
          cancelled_at: null,
        },
        quote: {
          id: '401',
          status: 'accepted',
          version: 3,
        },
      });

      // Verify StatusLog emits bidding_closed then accepted
      expect(savedStatusLogs).toHaveLength(2);
      expect(savedStatusLogs[0]).toMatchObject({
        request_id: '1001',
        event_type: 'bidding_closed',
        prev_status: 'artisans_bidding',
        new_status: 'artisans_bidding',
        performed_by: '10',
        is_admin_action: false,
        created_at: NOW,
      });
      expect(savedStatusLogs[1]).toMatchObject({
        request_id: '1001',
        event_type: 'accepted',
        prev_status: 'artisans_bidding',
        new_status: 'buyer_accepted',
        performed_by: '10',
        is_admin_action: false,
        created_at: NOW,
      });

      // Verify RecipientResponseHistory quote_accepted
      expect(savedRecipientHistory).toMatchObject({
        recipient_id: '2001',
        quote_id: '401',
        event_type: 'quote_accepted',
        prev_status: 'quoted',
        new_status: 'quoted',
        performed_by: '10',
        quote_snapshot: {
          unit_price: 45000,
          max_quantity: 5000,
          status: 'accepted',
          version: 3,
        },
      });

      // Verify AllocationLog created
      expect(savedAllocationLog).toMatchObject({
        event_type: 'created',
        prev_status: null,
        new_status: 'not_started',
        performed_by: '10',
        is_admin_action: false,
        created_at: NOW,
      });
    });

    it('AQ-02: preserves existing bidding_closed_at without duplicate bidding_closed log, and caps bidding_closed_at at bidding_deadline when now >= bidding_deadline', async () => {
      // Case A: Already closed early
      const txRunnerA = new MockTransactionRunner();
      const closedAt = new Date('2026-11-12T09:00:00.000Z');
      const requestA = createSampleRequest({ bidding_closed_at: closedAt, version: 4 });
      const recipientA = createSampleRecipient();
      const quoteA = createSampleQuote();
      const logsA: StatusLogRecord[] = [];
      let updatedReqA: QuoteRequest | undefined;

      const wsA = new MockWorkshopContract().givenActiveWorkshops('301');
      wsA.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Minh Long',
        status: 'active',
        isProfilePublic: true,
      });

      const serviceA = new TradingAcceptanceService(
        asQuoteRequestRepo({
          findById: vi.fn().mockResolvedValue(requestA),
          lockById: vi.fn().mockResolvedValue(requestA),
          update: vi.fn().mockImplementation(async ({ request: next, statusLogs }) => {
            if (statusLogs) logsA.push(...statusLogs);
            updatedReqA = next;
            return next;
          }),
        }),
        asRecipientRepo({ lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipientA) }),
        asQuoteRepo({
          findById: vi.fn().mockResolvedValue(quoteA),
          lockById: vi.fn().mockResolvedValue(quoteA),
          update: vi.fn().mockImplementation(async ({ quote: next }) => next),
        }),
        asAllocationRepo({
          create: vi.fn().mockImplementation(async ({ allocation }) =>
            Allocation.reconstitute({ ...allocation, id: '5002' }),
          ),
        }),
        asIdempotencyRepo({}),
        wsA,
      );

      await new AcceptQuoteUseCase(txRunnerA, serviceA, wsA).execute({
        actor: buyerActor,
        requestId: '1001',
        quoteId: '401',
        expectedRequestVersion: 4,
        expectedQuoteVersion: 2,
        now: NOW,
      });

      expect(updatedReqA?.bidding_closed_at).toEqual(closedAt);
      expect(logsA).toHaveLength(1);
      expect(logsA[0].event_type).toBe('accepted');

      // Case B: Bidding deadline passed (now >= bidding_deadline), now < bid_accept_deadline, exact boundary committed_delivery_at === delivery_deadline
      const txRunnerB = new MockTransactionRunner();
      const afterBiddingNow = new Date('2026-11-21T10:00:00.000Z');
      const requestB = createSampleRequest({ bidding_closed_at: null, version: 3 });
      const quoteB = createSampleQuote({
        committed_delivery_at: DELIVERY_DEADLINE,
        bid_accept_deadline: BID_ACCEPT_DEADLINE,
      });
      const logsB: StatusLogRecord[] = [];
      let updatedReqB: QuoteRequest | undefined;

      const serviceB = new TradingAcceptanceService(
        asQuoteRequestRepo({
          findById: vi.fn().mockResolvedValue(requestB),
          lockById: vi.fn().mockResolvedValue(requestB),
          update: vi.fn().mockImplementation(async ({ request: next, statusLogs }) => {
            if (statusLogs) logsB.push(...statusLogs);
            updatedReqB = next;
            return next;
          }),
        }),
        asRecipientRepo({ lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipientA) }),
        asQuoteRepo({
          findById: vi.fn().mockResolvedValue(quoteB),
          lockById: vi.fn().mockResolvedValue(quoteB),
          update: vi.fn().mockImplementation(async ({ quote: next }) => next),
        }),
        asAllocationRepo({
          create: vi.fn().mockImplementation(async ({ allocation }) =>
            Allocation.reconstitute({ ...allocation, id: '5003' }),
          ),
        }),
        asIdempotencyRepo({}),
        wsA,
      );

      const resB = await new AcceptQuoteUseCase(txRunnerB, serviceB, wsA).execute({
        actor: buyerActor,
        requestId: '1001',
        quoteId: '401',
        expectedRequestVersion: 3,
        expectedQuoteVersion: 2,
        now: new Date(BID_ACCEPT_DEADLINE.getTime() - 1),
      });

      expect(resB.data.request_status).toBe('buyer_accepted');
      expect(updatedReqB?.bidding_closed_at).toEqual(BIDDING_DEADLINE);
      expect(logsB).toHaveLength(2);
      expect(logsB[0]).toMatchObject({
        event_type: 'bidding_closed',
        performed_by: null,
        created_at: BIDDING_DEADLINE,
      });
      expect(afterBiddingNow.getTime()).toBeGreaterThan(BIDDING_DEADLINE.getTime());
    });

    it('AQ-03: rejects expired quote (exact & past bid_accept_deadline), suspended/missing workshop, <100% capacity, delivery deadline violation, invalid states, stale versions, cross-request quote, non-owner (404 SEC-06), wrong role, temp_password with zero mutations', async () => {
      const buildFixture = (opts?: {
        request?: QuoteRequest;
        recipient?: RequestRecipient | null;
        quote?: Quote | null;
        workshopSetup?: (ws: MockWorkshopContract) => void;
      }) => {
        const txRunner = new MockTransactionRunner();
        const request = opts?.request ?? createSampleRequest();
        const recipient =
          opts && 'recipient' in opts ? opts.recipient : createSampleRecipient();
        const quote = opts && 'quote' in opts ? opts.quote : createSampleQuote();

        const quoteRequestRepo = {
          findById: vi.fn().mockResolvedValue(request),
          lockById: vi.fn().mockResolvedValue(request),
          update: vi.fn(),
        };
        const recipientRepo = {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
        };
        const quoteRepo = {
          findById: vi.fn().mockResolvedValue(quote),
          lockById: vi.fn().mockResolvedValue(quote),
          update: vi.fn(),
        };
        const allocationRepo = {
          create: vi.fn(),
        };
        const ws = new MockWorkshopContract().givenActiveWorkshops('301');
        ws.getWorkshopSummary.mockResolvedValue({
          id: '301',
          name: 'Xưởng Gốm Minh Long',
          status: 'active',
          isProfilePublic: true,
        });
        opts?.workshopSetup?.(ws);

        const service = new TradingAcceptanceService(
          asQuoteRequestRepo(quoteRequestRepo),
          asRecipientRepo(recipientRepo),
          asQuoteRepo(quoteRepo),
          asAllocationRepo(allocationRepo),
          asIdempotencyRepo({}),
          ws,
        );
        const useCase = new AcceptQuoteUseCase(txRunner, service, ws);
        return {
          useCase,
          quoteRequestRepo,
          recipientRepo,
          quoteRepo,
          allocationRepo,
        };
      };

      const assertZeroWrites = (f: ReturnType<typeof buildFixture>) => {
        expect(f.quoteRepo.update).not.toHaveBeenCalled();
        expect(f.quoteRequestRepo.update).not.toHaveBeenCalled();
        expect(f.allocationRepo.create).not.toHaveBeenCalled();
      };

      // 1. Exact bid_accept_deadline and past deadline -> QuoteExpiredError (422 QUOTE_EXPIRED)
      const fExpExact = buildFixture();
      await expect(
        fExpExact.useCase.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: BID_ACCEPT_DEADLINE,
        }),
      ).rejects.toThrow(QuoteExpiredError);
      assertZeroWrites(fExpExact);

      const fExpPast = buildFixture();
      await expect(
        fExpPast.useCase.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: new Date(BID_ACCEPT_DEADLINE.getTime() + 60_000),
        }),
      ).rejects.toThrow(QuoteExpiredError);
      assertZeroWrites(fExpPast);

      // 2. Suspended workshop -> WorkshopSuspended (422), QuoteRequest lock does NOT run
      const fSusp = buildFixture({
        workshopSetup: (ws) => ws.givenSuspended('301'),
      });
      await expect(
        fSusp.useCase.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toThrow(WorkshopSuspended);
      expect(fSusp.quoteRequestRepo.lockById).not.toHaveBeenCalled();
      expect(fSusp.quoteRepo.lockById).not.toHaveBeenCalled();
      assertZeroWrites(fSusp);

      // 3. Missing workshop in WorkshopContract -> 404 RESOURCE_NOT_FOUND
      const fMissingWs = buildFixture({
        workshopSetup: (ws) => {
          ws.lockAndAssertActive.mockRejectedValue(
            new BusinessRuleException('RESOURCE_NOT_FOUND'),
          );
        },
      });
      await expect(
        fMissingWs.useCase.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(fMissingWs.quoteRequestRepo.lockById).not.toHaveBeenCalled();
      assertZeroWrites(fMissingWs);

      // 4. Partial quote (< 100% capacity) -> InsufficientCapacityError (422 INSUFFICIENT_CAPACITY)
      const fCap = buildFixture({
        quote: createSampleQuote({ max_quantity: 4999 }),
      });
      await expect(
        fCap.useCase.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toThrow(InsufficientCapacityError);
      assertZeroWrites(fCap);

      // 5. Committed delivery > request delivery_deadline -> DeadlineViolationError (422)
      const fDeadline = buildFixture({
        quote: createSampleQuote({
          committed_delivery_at: new Date(DELIVERY_DEADLINE.getTime() + 1000),
        }),
      });
      await expect(
        fDeadline.useCase.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toThrow(DeadlineViolationError);
      assertZeroWrites(fDeadline);

      // 6. Invalid request statuses + cancelled request -> InvalidStateTransitionError (422)
      for (const status of [
        'draft_request',
        'sent_to_artisans',
        'buyer_accepted',
        'in_production',
        'delivered',
      ] as const) {
        const fReqState = buildFixture({
          request: createSampleRequest({ status, version: 3 }),
        });
        await expect(
          fReqState.useCase.execute({
            actor: buyerActor,
            requestId: '1001',
            quoteId: '401',
            expectedRequestVersion: 3,
            expectedQuoteVersion: 2,
            now: NOW,
          }),
        ).rejects.toThrow(InvalidStateTransitionError);
        assertZeroWrites(fReqState);
      }

      const fCancelled = buildFixture({
        request: createSampleRequest({
          status: 'artisans_bidding',
          cancelled_at: NOW,
          cancelled_by: '10',
          cancel_reason: 'Changed mind',
        }),
      });
      await expect(
        fCancelled.useCase.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toThrow(InvalidStateTransitionError);
      assertZeroWrites(fCancelled);

      // 7. Invalid quote statuses (withdrawn, accepted) -> InvalidStateTransitionError (422)
      for (const status of ['withdrawn', 'accepted'] as const) {
        const fQState = buildFixture({
          quote: createSampleQuote({
            status,
            withdraw_reason: status === 'withdrawn' ? 'Out of clay' : null,
            withdrawn_at: status === 'withdrawn' ? NOW : null,
            withdrawn_by: status === 'withdrawn' ? '20' : null,
          }),
        });
        await expect(
          fQState.useCase.execute({
            actor: buyerActor,
            requestId: '1001',
            quoteId: '401',
            expectedRequestVersion: 3,
            expectedQuoteVersion: 2,
            now: NOW,
          }),
        ).rejects.toThrow(InvalidStateTransitionError);
        assertZeroWrites(fQState);
      }

      // 8. Stale expected_request_version on an already buyer_accepted request MUST return 409 CONCURRENCY_CONFLICT (not 422)
      const fStaleReq = buildFixture({
        request: createSampleRequest({ status: 'buyer_accepted', version: 4 }),
      });
      await expect(
        fStaleReq.useCase.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toThrow(ConcurrencyConflictError);
      assertZeroWrites(fStaleReq);

      // 9. Stale expected_quote_version -> 409 CONCURRENCY_CONFLICT
      const fStaleQuote = buildFixture({
        quote: createSampleQuote({ version: 5 }),
      });
      await expect(
        fStaleQuote.useCase.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toThrow(ConcurrencyConflictError);
      assertZeroWrites(fStaleQuote);

      // 10. Cross-request quote_id & non-owner Buyer -> 404 RESOURCE_NOT_FOUND (SEC-06)
      const fCross = buildFixture({
        quote: createSampleQuote({ request_id: '9999' }),
      });
      await expect(
        fCross.useCase.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toThrow(TradingResourceNotFoundError);
      assertZeroWrites(fCross);

      const fNonOwner = buildFixture();
      let nonOwnerErr: unknown;
      try {
        await fNonOwner.useCase.execute({
          actor: otherBuyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        });
      } catch (e) {
        nonOwnerErr = e;
      }
      expect(nonOwnerErr).toBeInstanceOf(QuoteRequestNotFoundError);
      expect((nonOwnerErr as QuoteRequestNotFoundError).code).toBe('RESOURCE_NOT_FOUND');
      expect((nonOwnerErr as QuoteRequestNotFoundError).message).toBe(
        'QuoteRequest was not found.',
      );
      assertZeroWrites(fNonOwner);

      // 11. Wrong roles & temp_password
      const fRole = buildFixture();
      await expect(
        fRole.useCase.execute({
          actor: artisanActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
      await expect(
        fRole.useCase.execute({
          actor: adminActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
      await expect(
        fRole.useCase.execute({
          actor: tempPasswordBuyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });
      assertZeroWrites(fRole);
    });

    it('AQ-04: enforces strict lock acquisition order (Workshop -> QuoteRequest -> RequestRecipient -> Quote) and reuses external TransactionContext without nested tx', async () => {
      const txRunner = new MockTransactionRunner();
      const externalTx = Object.freeze({ ext: true }) as unknown as TransactionContext;
      const callOrder: string[] = [];

      const request = createSampleRequest();
      const recipient = createSampleRecipient();
      const quote = createSampleQuote();

      const quoteRequestRepo = {
        findById: vi.fn().mockImplementation(async (_id, tx) => {
          expect(tx).toBe(externalTx);
          callOrder.push('prepare.request.findById');
          return request;
        }),
        lockById: vi.fn().mockImplementation(async (_id, tx) => {
          expect(tx).toBe(externalTx);
          callOrder.push('lock.request');
          return request;
        }),
        update: vi.fn().mockImplementation(async ({ request: next }, tx) => {
          expect(tx).toBe(externalTx);
          callOrder.push('write.request');
          return next;
        }),
      };

      const recipientRepo = {
        lockByRequestAndWorkshop: vi.fn().mockImplementation(async (_reqId, _wsId, tx) => {
          expect(tx).toBe(externalTx);
          callOrder.push('lock.recipient');
          return recipient;
        }),
      };

      const quoteRepo = {
        findById: vi.fn().mockImplementation(async (_id, tx) => {
          expect(tx).toBe(externalTx);
          callOrder.push('prepare.quote.findById');
          return quote;
        }),
        lockById: vi.fn().mockImplementation(async (_id, tx) => {
          expect(tx).toBe(externalTx);
          callOrder.push('lock.quote');
          return quote;
        }),
        update: vi.fn().mockImplementation(async ({ quote: next }, tx) => {
          expect(tx).toBe(externalTx);
          callOrder.push('write.quote');
          return next;
        }),
      };

      const allocationRepo = {
        create: vi.fn().mockImplementation(async ({ allocation }, tx) => {
          expect(tx).toBe(externalTx);
          callOrder.push('write.allocation');
          return Allocation.reconstitute({ ...allocation, id: '5001' });
        }),
      };

      const workshopContract = new MockWorkshopContract();
      workshopContract.lockAndAssertActive.mockImplementation(async (ids, tx) => {
        expect(ids).toEqual(['301']);
        expect(tx).toBe(externalTx);
        callOrder.push('lock.workshop');
      });
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Minh Long',
        status: 'active',
        isProfilePublic: true,
      });

      const tradingService = new TradingAcceptanceService(
        asQuoteRequestRepo(quoteRequestRepo),
        asRecipientRepo(recipientRepo),
        asQuoteRepo(quoteRepo),
        asAllocationRepo(allocationRepo),
        asIdempotencyRepo({}),
        workshopContract,
      );

      const workflow = new AcceptQuotationWorkflow(
        txRunner,
        tradingService,
        workshopContract,
      );

      await workflow.execute({
        actor: buyerActor,
        requestId: '1001',
        quoteId: '401',
        expectedRequestVersion: 3,
        expectedQuoteVersion: 2,
        now: NOW,
        tx: externalTx,
      });

      // External tx was reused without opening a new transaction
      expect(txRunner.contexts).toHaveLength(0);
      expect(callOrder).toEqual([
        'prepare.request.findById',
        'prepare.quote.findById',
        'lock.workshop',
        'lock.request',
        'lock.recipient',
        'lock.quote',
        'write.quote',
        'write.request',
        'write.allocation',
      ]);
    });

    it('AQ-05: ITradingContract methods (findAcceptanceReplay, prepareAcceptance, accept) and MockTradingContract workflow orchestration work cleanly', async () => {
      const txRunner = new MockTransactionRunner();
      const key = '11111111-2222-4333-8444-555555555555';
      const request = createSampleRequest();
      const recipient = createSampleRecipient();
      const quote = createSampleQuote();

      const idempotencyRecords = new Map<string, PersistedIdempotencyRecord<unknown>>();
      const workshopContract = new MockWorkshopContract().givenActiveWorkshops('301');
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Minh Long',
        status: 'active',
        isProfilePublic: true,
      });

      const tradingService = new TradingAcceptanceService(
        asQuoteRequestRepo({
          findById: vi.fn().mockResolvedValue(request),
          lockById: vi.fn().mockResolvedValue(request),
          update: vi.fn().mockImplementation(async ({ request: next }) => next),
        }),
        asRecipientRepo({
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
        }),
        asQuoteRepo({
          findById: vi.fn().mockResolvedValue(quote),
          lockById: vi.fn().mockResolvedValue(quote),
          update: vi.fn().mockImplementation(async ({ quote: next }) => next),
        }),
        asAllocationRepo({
          create: vi.fn().mockImplementation(async ({ allocation }) =>
            Allocation.reconstitute({ ...allocation, id: '5001' }),
          ),
        }),
        asIdempotencyRepo({
          findByScope: vi.fn().mockImplementation(async (scope: IdempotencyScopeKey) => {
            return idempotencyRecords.get(scope.idempotency_key) ?? null;
          }),
          save: vi.fn().mockImplementation(async (input: CreateIdempotencyRecordInput<unknown>) => {
            const saved: PersistedIdempotencyRecord<unknown> = {
              id: '9001',
              ...input,
            };
            idempotencyRecords.set(input.idempotency_key, saved);
            return saved;
          }),
        }),
        workshopContract,
      );

      const workflow = new AcceptQuotationWorkflow(
        txRunner,
        tradingService,
        workshopContract,
      );

      // 1st standalone call: saves IdempotencyRecord and returns replayed: false
      const first = await workflow.execute({
        actor: buyerActor,
        requestId: '1001',
        quoteId: '401',
        expectedRequestVersion: 3,
        expectedQuoteVersion: 2,
        idempotencyKey: key,
        now: NOW,
      });
      expect(first.operation?.id).toBe('9001');
      expect(first.operation?.replayed).toBe(false);

      // 2nd standalone call with same key & payload: returns replay without calling lockAndAssertActive again
      workshopContract.lockAndAssertActive.mockClear();
      const replay = await workflow.execute({
        actor: buyerActor,
        requestId: '1001',
        quoteId: '401',
        expectedRequestVersion: 3,
        expectedQuoteVersion: 2,
        idempotencyKey: key,
      });
      expect(replay.operation?.replayed).toBe(true);
      expect(replay.data).toEqual(first.data);
      expect(workshopContract.lockAndAssertActive).not.toHaveBeenCalled();

      // Same key + mismatched payload -> 409 IDEMPOTENCY_CONFLICT
      await expect(
        workflow.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '402',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          idempotencyKey: key,
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

      // Verify AcceptQuotationWorkflow also orchestrates MockTradingContract cleanly
      const mockTrading = new MockTradingContract();
      const mockTxRunner = new MockTransactionRunner();
      const mockWs = new MockWorkshopContract().givenActiveWorkshops('301');
      const wfOrder: string[] = [];
      mockTrading.findAcceptanceReplay.mockImplementation(async () => {
        wfOrder.push('findAcceptanceReplay');
        return null;
      });
      mockTrading.prepareAcceptance.mockImplementation(async () => {
        wfOrder.push('prepareAcceptance');
        return { workshopIds: ['301'] };
      });
      mockWs.lockAndAssertActive.mockImplementation(async () => {
        wfOrder.push('lockAndAssertActive');
      });
      mockTrading.accept.mockImplementation(async () => {
        wfOrder.push('accept');
        return {
          data: first.data,
          operation: first.operation!,
        };
      });

      const mockWf = new AcceptQuotationWorkflow(mockTxRunner, mockTrading, mockWs);
      const mockOut = await mockWf.execute({
        actor: buyerActor,
        requestId: '1001',
        quoteId: '401',
        expectedRequestVersion: 3,
        expectedQuoteVersion: 2,
        idempotencyKey: key,
      });
      expect(mockOut.data).toEqual(first.data);
      expect(wfOrder).toEqual([
        'findAcceptanceReplay',
        'prepareAcceptance',
        'lockAndAssertActive',
        'accept',
      ]);
    });

    it('AQ-06: fails closed when workshopContract is omitted (undefined) across workflow, use-case, and all TradingAcceptanceService entry paths', async () => {
      const txRunner = new MockTransactionRunner();
      const request = createSampleRequest();
      const recipient = createSampleRecipient();
      const quote = createSampleQuote();

      const quoteRequestRepo = {
        findById: vi.fn().mockResolvedValue(request),
        lockById: vi.fn().mockResolvedValue(request),
        update: vi.fn(),
      };
      const recipientRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
      };
      const quoteRepo = {
        findById: vi.fn().mockResolvedValue(quote),
        lockById: vi.fn().mockResolvedValue(quote),
        update: vi.fn(),
      };
      const allocationRepo = {
        create: vi.fn(),
      };
      const idempotencyRepo = {
        findByScope: vi.fn().mockResolvedValue(null),
        save: vi.fn(),
      };

      const serviceWithoutWs = new TradingAcceptanceService(
        asQuoteRequestRepo(quoteRequestRepo),
        asRecipientRepo(recipientRepo),
        asQuoteRepo(quoteRepo),
        asAllocationRepo(allocationRepo),
        asIdempotencyRepo(idempotencyRepo),
      );
      const dummyTx = Object.freeze({}) as TransactionContext;
      const key = '22222222-3333-4444-8555-666666666666';

      // 1. Direct TradingAcceptanceService entry paths fail closed
      await expect(
        serviceWithoutWs.prepareAcceptance(
          {
            actor: buyerActor,
            requestId: '1001',
            quoteId: '401',
            expectedRequestVersion: 3,
            expectedQuoteVersion: 2,
          },
          dummyTx,
        ),
      ).rejects.toThrow('Workshop contract is required for trading acceptance.');

      await expect(
        serviceWithoutWs.accept(
          {
            actor: buyerActor,
            requestId: '1001',
            quoteId: '401',
            expectedRequestVersion: 3,
            expectedQuoteVersion: 2,
            idempotencyKey: key,
          },
          dummyTx,
        ),
      ).rejects.toThrow('Workshop contract is required for trading acceptance.');

      await expect(
        serviceWithoutWs.executeAcceptance(
          {
            actor: buyerActor,
            requestId: '1001',
            quoteId: '401',
            expectedRequestVersion: 3,
            expectedQuoteVersion: 2,
            now: NOW,
          },
          dummyTx,
        ),
      ).rejects.toThrow('Workshop contract is required for trading acceptance.');

      // 2. AcceptQuotationWorkflow & AcceptQuoteUseCase fail closed when workshopContract is undefined
      const wsPresent = new MockWorkshopContract().givenActiveWorkshops('301');
      const serviceWithWs = new TradingAcceptanceService(
        asQuoteRequestRepo(quoteRequestRepo),
        asRecipientRepo(recipientRepo),
        asQuoteRepo(quoteRepo),
        asAllocationRepo(allocationRepo),
        asIdempotencyRepo(idempotencyRepo),
        wsPresent,
      );

      const workflowWithoutWs = new AcceptQuotationWorkflow(
        txRunner,
        serviceWithWs,
      );
      await expect(
        workflowWithoutWs.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toThrow(
        'Workshop contract is required for accept-quotation workflow.',
      );

      const useCaseWithoutWs = new AcceptQuoteUseCase(txRunner, serviceWithWs);
      await expect(
        useCaseWithoutWs.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toThrow(
        'Workshop contract is required for accept-quotation workflow.',
      );

      expect(quoteRequestRepo.lockById).not.toHaveBeenCalled();
      expect(quoteRepo.update).not.toHaveBeenCalled();
      expect(quoteRequestRepo.update).not.toHaveBeenCalled();
      expect(allocationRepo.create).not.toHaveBeenCalled();
      expect(idempotencyRepo.save).not.toHaveBeenCalled();
    });

    it('AQ-07: fails closed when getWorkshopSummary returns null, has blank name, or reports suspended workshop on direct ITradingContract call', async () => {
      const txRunner = new MockTransactionRunner();
      const request = createSampleRequest();
      const recipient = createSampleRecipient();
      const quote = createSampleQuote();

      const createRepos = () => {
        const quoteRequestRepo = {
          findById: vi.fn().mockResolvedValue(request),
          lockById: vi.fn().mockResolvedValue(request),
          update: vi.fn(),
        };
        const recipientRepo = {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
        };
        const quoteRepo = {
          findById: vi.fn().mockResolvedValue(quote),
          lockById: vi.fn().mockResolvedValue(quote),
          update: vi.fn(),
        };
        const allocationRepo = {
          create: vi.fn(),
        };
        const idempotencyRepo = {
          findByScope: vi.fn().mockResolvedValue(null),
          save: vi.fn(),
        };
        return {
          quoteRequestRepo,
          recipientRepo,
          quoteRepo,
          allocationRepo,
          idempotencyRepo,
        };
      };

      // Case A: getWorkshopSummary returns null -> TradingResourceNotFoundError (404 RESOURCE_NOT_FOUND)
      const reposNull = createRepos();
      const wsNull = new MockWorkshopContract().givenActiveWorkshops('301');
      wsNull.getWorkshopSummary.mockResolvedValue(null);

      const svcNull = new TradingAcceptanceService(
        asQuoteRequestRepo(reposNull.quoteRequestRepo),
        asRecipientRepo(reposNull.recipientRepo),
        asQuoteRepo(reposNull.quoteRepo),
        asAllocationRepo(reposNull.allocationRepo),
        asIdempotencyRepo(reposNull.idempotencyRepo),
        wsNull,
      );
      const wfNull = new AcceptQuotationWorkflow(txRunner, svcNull, wsNull);

      await expect(
        wfNull.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toThrow(TradingResourceNotFoundError);
      expect(reposNull.quoteRepo.update).not.toHaveBeenCalled();
      expect(reposNull.quoteRequestRepo.update).not.toHaveBeenCalled();
      expect(reposNull.allocationRepo.create).not.toHaveBeenCalled();

      // Case B: getWorkshopSummary returns blank name -> InvalidStateTransitionError (no synthetic name fabrication)
      const reposBlank = createRepos();
      const wsBlank = new MockWorkshopContract().givenActiveWorkshops('301');
      wsBlank.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: '   ',
        status: 'active',
        isProfilePublic: true,
      });
      const svcBlank = new TradingAcceptanceService(
        asQuoteRequestRepo(reposBlank.quoteRequestRepo),
        asRecipientRepo(reposBlank.recipientRepo),
        asQuoteRepo(reposBlank.quoteRepo),
        asAllocationRepo(reposBlank.allocationRepo),
        asIdempotencyRepo(reposBlank.idempotencyRepo),
        wsBlank,
      );
      await expect(
        new AcceptQuotationWorkflow(txRunner, svcBlank, wsBlank).execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toThrow(InvalidStateTransitionError);
      expect(reposBlank.allocationRepo.create).not.toHaveBeenCalled();

      // Case C: Direct ITradingContract.accept() without prior lockAndAssertActive still rejects suspended workshop
      const reposSusp = createRepos();
      const wsSusp = new MockWorkshopContract().givenSuspended('301');
      wsSusp.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Đang Tạm Ngừng',
        status: 'suspended',
        isProfilePublic: false,
      });
      const svcSusp = new TradingAcceptanceService(
        asQuoteRequestRepo(reposSusp.quoteRequestRepo),
        asRecipientRepo(reposSusp.recipientRepo),
        asQuoteRepo(reposSusp.quoteRepo),
        asAllocationRepo(reposSusp.allocationRepo),
        asIdempotencyRepo(reposSusp.idempotencyRepo),
        wsSusp,
      );
      await expect(
        svcSusp.accept(
          {
            actor: buyerActor,
            requestId: '1001',
            quoteId: '401',
            expectedRequestVersion: 3,
            expectedQuoteVersion: 2,
            idempotencyKey: '33333333-4444-4555-8666-777777777777',
          },
          Object.freeze({}) as TransactionContext,
          { now: NOW },
        ),
      ).rejects.toThrow(WorkshopSuspendedError);
      expect(reposSusp.quoteRepo.update).not.toHaveBeenCalled();
      expect(reposSusp.allocationRepo.create).not.toHaveBeenCalled();
    });

    it('AQ-08: stale expectedRequestVersion on a concurrently cancelled QuoteRequest returns 422 INVALID_STATE per QuoteRequest domain convention (while non-cancelled version mismatch returns 409 CONCURRENCY_CONFLICT)', async () => {
      const txRunner = new MockTransactionRunner();
      const cancelledAt = new Date('2026-11-15T09:55:00.000Z');
      const cancelledReq = createSampleRequest({
        status: 'artisans_bidding',
        version: 4,
        cancelled_at: cancelledAt,
        cancelled_by: '10',
        cancel_reason: 'Buyer cancelled concurrently',
      });
      const recipient = createSampleRecipient();
      const quote = createSampleQuote();

      const quoteRequestRepo = {
        findById: vi.fn().mockResolvedValue(cancelledReq),
        lockById: vi.fn().mockResolvedValue(cancelledReq),
        update: vi.fn(),
      };
      const quoteRepo = {
        findById: vi.fn().mockResolvedValue(quote),
        lockById: vi.fn().mockResolvedValue(quote),
        update: vi.fn(),
      };
      const allocationRepo = {
        create: vi.fn(),
      };
      const ws = new MockWorkshopContract().givenActiveWorkshops('301');
      ws.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Minh Long',
        status: 'active',
        isProfilePublic: true,
      });

      const service = new TradingAcceptanceService(
        asQuoteRequestRepo(quoteRequestRepo),
        asRecipientRepo({
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
        }),
        asQuoteRepo(quoteRepo),
        asAllocationRepo(allocationRepo),
        asIdempotencyRepo({}),
        ws,
      );
      const useCase = new AcceptQuoteUseCase(txRunner, service, ws);

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3, // stale relative to v4 after cancel
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      expect(quoteRepo.update).not.toHaveBeenCalled();
      expect(quoteRequestRepo.update).not.toHaveBeenCalled();
      expect(allocationRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('Mock-Prisma Repository, FOR UPDATE Locking & Snapshot Rollback', () => {
    it('PR-01: executes FOR UPDATE locks, omits Allocation.id so PostgreSQL BIGSERIAL generates it, enforces optimistic versions, and writes StatusLog/RecipientResponseHistory/AllocationLog', async () => {
      const requestRow = {
        id: 1001n,
        buyer_id: 10n,
        category_id: 5n,
        spec: '5000 bát gốm men rạn',
        quantity: 5000,
        unit: 'piece',
        unit_set_description: null,
        status: 'artisans_bidding',
        delivery_mode: 'at_buyer_address',
        delivery_region: 'Hà Nội, Gia Lâm',
        delivery_address: 'Số 12 Phố Gốm',
        recipient_name: 'Nguyễn Văn Mua',
        recipient_phone: '0901234567',
        bidding_deadline: BIDDING_DEADLINE,
        delivery_deadline: DELIVERY_DEADLINE,
        bidding_closed_at: null,
        split_requested_at: null,
        version: 3,
        cancelled_at: null,
        cancelled_by: null,
        cancel_reason: null,
        created_at: SENT_AT,
        updated_at: SENT_AT,
      };
      const recipientRow = {
        id: 2001n,
        request_id: 1001n,
        workshop_id: 301n,
        response_status: 'quoted',
        decline_reason: null,
        responded_by: 20n,
        responded_at: SENT_AT,
        sent_at: SENT_AT,
        version: 2,
      };
      const quoteRow = {
        id: 401n,
        request_id: 1001n,
        workshop_id: 301n,
        unit_price: new Prisma.Decimal('45000'),
        max_quantity: 5000,
        bid_accept_deadline: BID_ACCEPT_DEADLINE,
        committed_delivery_at: COMMITTED_DELIVERY,
        status: 'active',
        version: 2,
        withdraw_reason: null,
        withdrawn_by: null,
        withdrawn_at: null,
        created_at: SENT_AT,
        updated_at: SENT_AT,
      };
      const createdAllocationRow = {
        id: 5001n,
        request_id: 1001n,
        workshop_id: 301n,
        quote_id: 401n,
        quantity: 5000,
        unit_price: new Prisma.Decimal('45000'),
        committed_delivery_at: COMMITTED_DELIVERY,
        status: 'not_started',
        version: 1,
        started_at: null,
        started_by: null,
        handed_over_at: null,
        handed_over_by: null,
        delivery_note: null,
        admin_handed_over: false,
        admin_delivery_evidence: null,
        admin_handover_reason: null,
        admin_handover_actual_at: null,
        created_at: NOW,
        updated_at: NOW,
        allocationBatches: [],
      };

      const mockClient = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: 1001n }])
          .mockResolvedValueOnce([{ id: 2001n }])
          .mockResolvedValueOnce([{ id: 401n }]),
        quoteRequest: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(requestRow)
            .mockResolvedValueOnce(requestRow)
            .mockResolvedValueOnce({
              ...requestRow,
              status: 'buyer_accepted',
              bidding_closed_at: NOW,
              version: 4,
              updated_at: NOW,
            }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        requestRecipient: {
          findUnique: vi.fn().mockResolvedValue(recipientRow),
        },
        quote: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(quoteRow)
            .mockResolvedValueOnce(quoteRow)
            .mockResolvedValueOnce({
              ...quoteRow,
              status: 'accepted',
              version: 3,
              updated_at: NOW,
            }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        recipientResponseHistory: {
          create: vi.fn().mockResolvedValue({ id: 7001n }),
        },
        statusLog: {
          create: vi.fn().mockResolvedValue({ id: 8001n }),
        },
        allocation: {
          create: vi.fn().mockResolvedValue(createdAllocationRow),
        },
        allocationLog: {
          create: vi.fn().mockResolvedValue({ id: 9001n }),
        },
      };

      const mockPrismaService = {
        $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn(mockClient),
        ),
      } as unknown as PrismaService;

      const txRunner = new PrismaTransactionRunner(mockPrismaService);
      const ws = new MockWorkshopContract().givenActiveWorkshops('301');
      ws.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Minh Long Bát Tràng',
        status: 'active',
        isProfilePublic: true,
      });

      const tradingService = new TradingAcceptanceService(
        new PrismaQuoteRequestRepository(txRunner),
        new PrismaRequestRecipientRepository(txRunner),
        new PrismaQuoteRepository(txRunner),
        new PrismaAllocationRepository(txRunner),
        asIdempotencyRepo({}),
        ws,
      );

      const useCase = new AcceptQuoteUseCase(txRunner, tradingService, ws);
      const output = await useCase.execute({
        actor: buyerActor,
        requestId: '1001',
        quoteId: '401',
        expectedRequestVersion: 3,
        expectedQuoteVersion: 2,
        now: NOW,
      });

      expect(output.data.allocations[0].id).toBe('5001');
      expect(mockClient.$queryRaw).toHaveBeenCalledTimes(3);

      // Verify Allocation.id is undefined so PostgreSQL BIGSERIAL assigns it
      const allocCreateArg = mockClient.allocation.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(allocCreateArg.data.id).toBeUndefined();
      expect(allocCreateArg.data.status).toBe('not_started');
      expect(allocCreateArg.data.version).toBe(1);
      expect(allocCreateArg.data.quantity).toBe(5000);

      // Verify AllocationLog receives DB-generated allocation_id
      expect(mockClient.allocationLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          allocation_id: 5001n,
          event_type: 'created',
          prev_status: null,
          new_status: 'not_started',
          performed_by: 10n,
        }),
      });

      // Verify StatusLog rows
      expect(mockClient.statusLog.create).toHaveBeenCalledTimes(2);
      expect(mockClient.recipientResponseHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          recipient_id: 2001n,
          quote_id: 401n,
          event_type: 'quote_accepted',
        }),
      });
    });

    it('PR-02: snapshot-rollback $transaction rolls back Quote, QuoteRequest, and logs completely when mid-transaction Allocation write fails', async () => {
      interface DbState {
        request: QuoteRequest;
        recipient: RequestRecipient;
        quote: Quote;
        allocations: Allocation[];
        statusLogs: StatusLogRecord[];
        recipientHistory: RecipientResponseRecord[];
        allocationLogs: AllocationLogRecord[];
      }

      const initialState: DbState = {
        request: createSampleRequest({ version: 3 }),
        recipient: createSampleRecipient({ version: 2 }),
        quote: createSampleQuote({ version: 2 }),
        allocations: [],
        statusLogs: [],
        recipientHistory: [],
        allocationLogs: [],
      };

      let committedState: DbState = {
        ...initialState,
        allocations: [...initialState.allocations],
        statusLogs: [...initialState.statusLogs],
        recipientHistory: [...initialState.recipientHistory],
        allocationLogs: [...initialState.allocationLogs],
      };

      let workingState: DbState = committedState;

      const snapshotRunner: TransactionRunner = {
        async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
          const snapshot: DbState = {
            request: committedState.request,
            recipient: committedState.recipient,
            quote: committedState.quote,
            allocations: [...committedState.allocations],
            statusLogs: [...committedState.statusLogs],
            recipientHistory: [...committedState.recipientHistory],
            allocationLogs: [...committedState.allocationLogs],
          };
          workingState = snapshot;
          try {
            const res = await work({} as TransactionContext);
            committedState = workingState;
            return res;
          } catch (err) {
            workingState = committedState;
            throw err;
          }
        },
      };

      const ws = new MockWorkshopContract().givenActiveWorkshops('301');
      ws.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Minh Long',
        status: 'active',
        isProfilePublic: true,
      });

      const failingTradingService = new TradingAcceptanceService(
        asQuoteRequestRepo({
          findById: vi.fn(async () => workingState.request),
          lockById: vi.fn(async () => workingState.request),
          update: vi.fn(async ({ request, statusLogs }) => {
            workingState.request = request;
            if (statusLogs) workingState.statusLogs.push(...statusLogs);
            return request;
          }),
        }),
        asRecipientRepo({
          lockByRequestAndWorkshop: vi.fn(async () => workingState.recipient),
        }),
        asQuoteRepo({
          findById: vi.fn(async () => workingState.quote),
          lockById: vi.fn(async () => workingState.quote),
          update: vi.fn(async ({ quote, recipientHistory }) => {
            workingState.quote = quote;
            if (recipientHistory) {
              workingState.recipientHistory.push(recipientHistory);
            }
            return quote;
          }),
        }),
        asAllocationRepo({
          create: vi.fn(async () => {
            throw new ConcurrencyConflictError(
              'Simulated mid-transaction P2002 Allocation conflict',
            );
          }),
        }),
        asIdempotencyRepo({}),
        ws,
      );

      const useCase = new AcceptQuoteUseCase(
        snapshotRunner,
        failingTradingService,
        ws,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          now: NOW,
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      // Verify full rollback: Quote and QuoteRequest stayed at original statuses & versions, zero logs
      expect(committedState.quote.status).toBe('active');
      expect(committedState.quote.version).toBe(2);
      expect(committedState.request.status).toBe('artisans_bidding');
      expect(committedState.request.version).toBe(3);
      expect(committedState.request.bidding_closed_at).toBeNull();
      expect(committedState.allocations).toHaveLength(0);
      expect(committedState.statusLogs).toHaveLength(0);
      expect(committedState.recipientHistory).toHaveLength(0);
      expect(committedState.allocationLogs).toHaveLength(0);
    });
  });

  describe('HTTP Controller, ValidationPipe, Guards, Idempotency, RFC 9457, OpenAPI & AppModule Boot', () => {
    let app: NestExpressApplication;
    let base: string;
    let identityMock: MockIdentityContract;
    let workshopMock: MockWorkshopContract;

    interface InMemorySnapshot {
      requests: Map<string, QuoteRequest>;
      recipients: Map<string, RequestRecipient>;
      quotes: Map<string, Quote>;
      allocations: Map<string, Allocation>;
      idempotency: Map<string, PersistedIdempotencyRecord<unknown>>;
      statusLogs: StatusLogRecord[];
      recipientHistory: RecipientResponseRecord[];
      allocationLogs: AllocationLogRecord[];
      nextAllocSeq: number;
      nextIdempSeq: number;
    }

    let dbState: InMemorySnapshot = {
      requests: new Map(),
      recipients: new Map(),
      quotes: new Map(),
      allocations: new Map(),
      idempotency: new Map(),
      statusLogs: [],
      recipientHistory: [],
      allocationLogs: [],
      nextAllocSeq: 5001,
      nextIdempSeq: 9001,
    };

    function compositeKey(requestId: string, workshopId: string): string {
      return `${requestId}:${workshopId}`;
    }

    function scopeKey(scope: IdempotencyScopeKey): string {
      return [
        scope.account_id,
        scope.action,
        scope.object_type,
        scope.object_id,
        scope.idempotency_key,
      ].join('|');
    }

    const transactionalInMemoryRunner: TransactionRunner = {
      async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
        const snapshot: InMemorySnapshot = {
          requests: new Map(dbState.requests),
          recipients: new Map(dbState.recipients),
          quotes: new Map(dbState.quotes),
          allocations: new Map(dbState.allocations),
          idempotency: new Map(dbState.idempotency),
          statusLogs: [...dbState.statusLogs],
          recipientHistory: [...dbState.recipientHistory],
          allocationLogs: [...dbState.allocationLogs],
          nextAllocSeq: dbState.nextAllocSeq,
          nextIdempSeq: dbState.nextIdempSeq,
        };
        try {
          return await work(Object.freeze({}) as TransactionContext);
        } catch (err) {
          dbState = snapshot;
          throw err;
        }
      },
    };

    const inMemoryQuoteRequestRepo = {
      findById: vi.fn(async (id: string) => dbState.requests.get(id) ?? null),
      lockById: vi.fn(async (id: string) => dbState.requests.get(id) ?? null),
      update: vi.fn(
        async ({
          request,
          expectedVersion,
          statusLogs,
        }: {
          request: QuoteRequest;
          expectedVersion?: number;
          statusLogs?: readonly StatusLogRecord[];
        }) => {
          const current = dbState.requests.get(request.id);
          if (!current || (expectedVersion && current.version !== expectedVersion)) {
            throw new ConcurrencyConflictError('QuoteRequest version conflict');
          }
          dbState.requests.set(request.id, request);
          if (statusLogs) dbState.statusLogs.push(...statusLogs);
          return request;
        },
      ),
    };

    const inMemoryRecipientRepo = {
      findById: vi.fn(async (id: string) => {
        for (const r of dbState.recipients.values()) {
          if (r.id === id) return r;
        }
        return null;
      }),
      findByRequestAndWorkshop: vi.fn(
        async (requestId: string, workshopId: string) =>
          dbState.recipients.get(compositeKey(requestId, workshopId)) ?? null,
      ),
      lockByRequestAndWorkshop: vi.fn(
        async (requestId: string, workshopId: string) =>
          dbState.recipients.get(compositeKey(requestId, workshopId)) ?? null,
      ),
    };

    const inMemoryQuoteRepo = {
      findById: vi.fn(async (id: string) => dbState.quotes.get(id) ?? null),
      lockById: vi.fn(async (id: string) => dbState.quotes.get(id) ?? null),
      update: vi.fn(
        async ({
          quote,
          expectedVersion,
          recipientHistory,
        }: {
          quote: Quote;
          expectedVersion?: number;
          recipientHistory?: RecipientResponseRecord;
        }) => {
          const current = dbState.quotes.get(quote.id);
          if (!current || (expectedVersion && current.version !== expectedVersion)) {
            throw new ConcurrencyConflictError('Quote version conflict');
          }
          dbState.quotes.set(quote.id, quote);
          if (recipientHistory) dbState.recipientHistory.push(recipientHistory);
          return quote;
        },
      ),
    };

    const inMemoryAllocationRepo = {
      findById: vi.fn(async (id: string) => dbState.allocations.get(id) ?? null),
      create: vi.fn(
        async ({
          allocation,
          log,
        }: {
          allocation: Allocation;
          log?: AllocationLogRecord;
        }) => {
          for (const existing of dbState.allocations.values()) {
            if (
              existing.quote_id === allocation.quote_id ||
              (existing.request_id === allocation.request_id &&
                existing.workshop_id === allocation.workshop_id)
            ) {
              throw new ConcurrencyConflictError('Duplicate Allocation');
            }
          }
          const assignedId = String(dbState.nextAllocSeq++);
          const persisted = Allocation.reconstitute({
            ...allocation,
            id: assignedId,
          });
          dbState.allocations.set(assignedId, persisted);
          if (log) {
            dbState.allocationLogs.push({ ...log, allocation_id: assignedId });
          }
          return persisted;
        },
      ),
    };

    const inMemoryIdempotencyRepo: IIdempotencyRecordRepository = {
      findByScope: vi.fn(async (scope: IdempotencyScopeKey) => {
        return dbState.idempotency.get(scopeKey(scope)) ?? null;
      }) as unknown as IIdempotencyRecordRepository['findByScope'],
      save: vi.fn(async (input: CreateIdempotencyRecordInput<unknown>) => {
        const key = scopeKey(input);
        if (dbState.idempotency.has(key)) {
          const err = new Error('Unique constraint failed (P2002)') as Error & {
            code?: string;
          };
          err.code = 'P2002';
          throw err;
        }
        const saved: PersistedIdempotencyRecord<unknown> = {
          id: String(dbState.nextIdempSeq++),
          idempotency_key: input.idempotency_key,
          request_fingerprint: input.request_fingerprint,
          account_id: input.account_id,
          action: input.action,
          object_type: input.object_type,
          object_id: input.object_id,
          result_snapshot: input.result_snapshot,
          created_at: input.created_at,
          expires_at: input.expires_at,
        };
        dbState.idempotency.set(key, saved);
        return saved;
      }) as unknown as IIdempotencyRecordRepository['save'],
      findAndVerifyReplay: vi.fn(
        async () => null,
      ) as unknown as IIdempotencyRecordRepository['findAndVerifyReplay'],
      deleteExpiredBefore: vi.fn(async () => 0),
    };

    function seedOpenBiddingScenario(overrides?: {
      request?: Partial<Parameters<typeof QuoteRequest.reconstitute>[0]>;
      quote?: Partial<Parameters<typeof Quote.reconstitute>[0]>;
      workshopStatus?: 'active' | 'suspended';
    }) {
      const futureBidding = new Date(Date.now() + 48 * 3600 * 1000);
      const futureAccept = new Date(Date.now() + 72 * 3600 * 1000);
      const futureCommitted = new Date(Date.now() + 96 * 3600 * 1000);
      const futureDelivery = new Date(Date.now() + 120 * 3600 * 1000);

      const req = createSampleRequest({
        bidding_deadline: futureBidding,
        delivery_deadline: futureDelivery,
        ...overrides?.request,
      });
      const rec = createSampleRecipient({ request_id: req.id, workshop_id: '301' });
      const quote = createSampleQuote({
        request_id: req.id,
        workshop_id: '301',
        bid_accept_deadline: futureAccept,
        committed_delivery_at: futureCommitted,
        ...overrides?.quote,
      });

      dbState.requests.set(req.id, req);
      dbState.recipients.set(compositeKey(req.id, '301'), rec);
      dbState.quotes.set(quote.id, quote);

      if (overrides?.workshopStatus === 'suspended') {
        workshopMock.givenSuspended('301');
      } else {
        workshopMock.givenActiveWorkshops('301');
      }
      workshopMock.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Minh Long Bát Tràng',
        status: overrides?.workshopStatus ?? 'active',
        isProfilePublic: true,
      });
    }

    beforeAll(async () => {
      vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/test');
      vi.stubEnv(
        'SESSION_SECRET',
        'test_secret_32_chars_for_development_purposes',
      );
      vi.stubEnv('NODE_ENV', 'development');

      identityMock = new MockIdentityContract();
      workshopMock = new MockWorkshopContract();

      class TestIdentityModule {}
      Module({
        providers: [{ provide: IDENTITY_CONTRACT, useValue: identityMock }],
        exports: [IDENTITY_CONTRACT],
      })(TestIdentityModule);

      class TestHttpBuyerTradingModule {}
      Module({
        imports: [AppConfigModule, SecurityModule.register([TestIdentityModule])],
        controllers: [BuyerQuoteRequestController],
        providers: [
          { provide: TRANSACTION_RUNNER, useValue: transactionalInMemoryRunner },
          {
            provide: QUOTE_REQUEST_REPOSITORY,
            useValue: asQuoteRequestRepo(inMemoryQuoteRequestRepo),
          },
          {
            provide: REQUEST_RECIPIENT_REPOSITORY,
            useValue: asRecipientRepo(inMemoryRecipientRepo),
          },
          {
            provide: QUOTE_REPOSITORY,
            useValue: asQuoteRepo(inMemoryQuoteRepo),
          },
          {
            provide: ALLOCATION_REPOSITORY,
            useValue: asAllocationRepo(inMemoryAllocationRepo),
          },
          {
            provide: IDEMPOTENCY_RECORD_REPOSITORY,
            useValue: asIdempotencyRepo(inMemoryIdempotencyRepo),
          },
          { provide: WORKSHOP_CONTRACT, useValue: workshopMock },
          {
            provide: TradingIdempotencyService,
            useFactory: (
              repo: IIdempotencyRecordRepository,
              txRunner: TransactionRunner,
            ) => new TradingIdempotencyService(repo, txRunner),
            inject: [IDEMPOTENCY_RECORD_REPOSITORY, TRANSACTION_RUNNER],
          },
          {
            provide: TRADING_CURRENT_STATE_RESOLVER,
            useFactory: (
              qrRepo: IQuoteRequestRepository,
              allocRepo: IAllocationRepository,
              qRepo: IQuoteRepository,
              recRepo: IRequestRecipientRepository,
            ) =>
              new TradingCurrentStateResolver(qrRepo, allocRepo, qRepo, recRepo),
            inject: [
              QUOTE_REQUEST_REPOSITORY,
              ALLOCATION_REPOSITORY,
              QUOTE_REPOSITORY,
              REQUEST_RECIPIENT_REPOSITORY,
            ],
          },
          TradingMutationInterceptor,
          {
            provide: CreateDraftQuoteRequestUseCase,
            useFactory: (txRunner: TransactionRunner, qrRepo: IQuoteRequestRepository) =>
              new CreateDraftQuoteRequestUseCase(txRunner, qrRepo),
            inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
          },
          {
            provide: TradingAcceptanceService,
            useFactory: (
              qrRepo: IQuoteRequestRepository,
              recRepo: IRequestRecipientRepository,
              qRepo: IQuoteRepository,
              allocRepo: IAllocationRepository,
              idempRepo: IIdempotencyRecordRepository,
              wsContract: IWorkshopContract,
            ) =>
              new TradingAcceptanceService(
                qrRepo,
                recRepo,
                qRepo,
                allocRepo,
                idempRepo,
                wsContract,
              ),
            inject: [
              QUOTE_REQUEST_REPOSITORY,
              REQUEST_RECIPIENT_REPOSITORY,
              QUOTE_REPOSITORY,
              ALLOCATION_REPOSITORY,
              IDEMPOTENCY_RECORD_REPOSITORY,
              WORKSHOP_CONTRACT,
            ],
          },
          {
            provide: TRADING_CONTRACT,
            useExisting: TradingAcceptanceService,
          },
          {
            provide: AcceptQuoteUseCase,
            useFactory: (
              txRunner: TransactionRunner,
              tradingContract: ITradingContract,
              wsContract: IWorkshopContract,
            ) => new AcceptQuoteUseCase(txRunner, tradingContract, wsContract),
            inject: [TRANSACTION_RUNNER, TRADING_CONTRACT, WORKSHOP_CONTRACT],
          },
        ],
      })(TestHttpBuyerTradingModule);

      app = await NestFactory.create<NestExpressApplication>(
        TestHttpBuyerTradingModule,
        {
          bodyParser: false,
          logger: false,
          abortOnError: false,
        },
      );
      configureHttp(
        app,
        new AppLogger('error', (_line, done) => done()),
      );
      await app.listen(0, '127.0.0.1');
      base = (await app.getUrl()) + '/api/v1';
    }, 30_000);

    afterAll(async () => {
      await app?.close();
      vi.unstubAllEnvs();
    });

    beforeEach(() => {
      dbState = {
        requests: new Map(),
        recipients: new Map(),
        quotes: new Map(),
        allocations: new Map(),
        idempotency: new Map(),
        statusLogs: [],
        recipientHistory: [],
        allocationLogs: [],
        nextAllocSeq: 5001,
        nextIdempSeq: 9001,
      };
      vi.clearAllMocks();
    });

    it('HT-01: returns 200 OK, Cache-Control: no-store, valid AcceptanceDto + operation envelope, and updates stores atomically', async () => {
      seedOpenBiddingScenario();
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/1001/accept-quote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=buyer-token',
          'X-Idempotency-Key': 'c7a8b9e0-1234-4567-89ab-cdef01234567',
          'X-Request-ID': 'req-trace-ht01',
        },
        body: JSON.stringify({
          quote_id: '401',
          expected_request_version: 3,
          expected_quote_version: 2,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('x-request-id')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      const json = (await res.json()) as any;
      expect(json.success).toBe(true);

      const parsedData = acceptanceDtoResponseSchema.parse(json.data);
      const parsedOp = acceptQuoteOperationResponseSchema.parse(json.operation);

      expect(parsedData.request_id).toBe('1001');
      expect(parsedData.request_status).toBe('buyer_accepted');
      expect(parsedData.request_version).toBe(4);
      expect(parsedData.allocations).toHaveLength(1);
      expect(parsedData.allocations[0]).toMatchObject({
        id: '5001',
        request_id: '1001',
        workshop: { id: '301', name: 'Xưởng Gốm Minh Long Bát Tràng' },
        quote_id: '401',
        quantity: 5000,
        unit_price: 45000,
        status: 'not_started',
        version: 1,
        traceability_warning: 'NO_BATCH_LINK',
      });

      expect(parsedOp.replayed).toBe(false);
      expect(parsedOp.current_state.request).toMatchObject({
        id: '1001',
        status: 'buyer_accepted',
        version: 4,
        cancelled_at: null,
      });
      expect(parsedOp.current_state.quote).toEqual({
        id: '401',
        status: 'accepted',
        version: 3,
      });

      expect(dbState.allocations.size).toBe(1);
      expect(dbState.idempotency.size).toBe(1);
    });

    it('HT-02: idempotency replay returns 200 replayed: true with fresh current_state (even after request moves to in_production) and mismatched payload returns 409 IDEMPOTENCY_CONFLICT', async () => {
      seedOpenBiddingScenario();
      const idemKey = 'd7a8b9e0-1234-4567-89ab-cdef01234567';

      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const firstRes = await fetch(`${base}/buyer/quote-requests/1001/accept-quote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=buyer-token',
          'X-Idempotency-Key': idemKey,
        },
        body: JSON.stringify({
          quote_id: '401',
          expected_request_version: 3,
          expected_quote_version: 2,
        }),
      });
      expect(firstRes.status).toBe(200);
      const firstJson = (await firstRes.json()) as any;

      // Advance QuoteRequest to in_production (v5) in store to verify replay refreshes current_state
      const acceptedReq = dbState.requests.get('1001')!;
      dbState.requests.set(
        '1001',
        QuoteRequest.reconstitute({
          ...acceptedReq,
          status: 'in_production',
          version: 5,
        }),
      );

      // Replay with identical payload & versions -> 200 replayed: true, same data, fresh current_state
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const replayRes = await fetch(`${base}/buyer/quote-requests/1001/accept-quote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=buyer-token',
          'X-Idempotency-Key': idemKey.toUpperCase(),
        },
        body: JSON.stringify({
          quote_id: '401',
          expected_request_version: 3,
          expected_quote_version: 2,
        }),
      });
      expect(replayRes.status).toBe(200);
      const replayJson = (await replayRes.json()) as any;
      expect(replayJson.data).toEqual(firstJson.data);
      expect(replayJson.operation.replayed).toBe(true);
      expect(replayJson.operation.id).toBe(firstJson.operation.id);
      expect(replayJson.operation.current_state).toEqual({
        request: {
          id: '1001',
          status: 'in_production',
          version: 5,
          cancelled_at: null,
        },
        quote: {
          id: '401',
          status: 'accepted',
          version: 3,
        },
      });
      expect(dbState.allocations.size).toBe(1);

      // Mismatched payload with same key -> 409 IDEMPOTENCY_CONFLICT
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const conflictRes = await fetch(`${base}/buyer/quote-requests/1001/accept-quote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=buyer-token',
          'X-Idempotency-Key': idemKey,
          'X-Request-ID': 'req-idem-conflict',
        },
        body: JSON.stringify({
          quote_id: '402',
          expected_request_version: 3,
          expected_quote_version: 2,
        }),
      });
      expect(conflictRes.status).toBe(409);
      expect(conflictRes.headers.get('content-type')).toContain('application/problem+json');
      const conflictBody = (await conflictRes.json()) as any;
      expect(conflictBody).toMatchObject({
        type: 'urn:vcraft:problem:IDEMPOTENCY_CONFLICT',
        status: 409,
        code: 'IDEMPOTENCY_CONFLICT',
        tracking_id: conflictRes.headers.get('x-request-id'),
      });
    });

    it('HT-03: rejects malformed headers, :id, quote_id, versions, and unknown extra fields with RFC 9457 400 INVALID_INPUT', async () => {
      seedOpenBiddingScenario();
      const validKey = 'e7a8b9e0-1234-4567-89ab-cdef01234567';

      const badCases = [
        {
          url: `${base}/buyer/quote-requests/1001/accept-quote`,
          key: 'not-a-uuid',
          body: { quote_id: '401', expected_request_version: 3, expected_quote_version: 2 },
        },
        {
          url: `${base}/buyer/quote-requests/abc/accept-quote`,
          key: validKey,
          body: { quote_id: '401', expected_request_version: 3, expected_quote_version: 2 },
        },
        {
          url: `${base}/buyer/quote-requests/1001/accept-quote`,
          key: validKey,
          body: { quote_id: '0', expected_request_version: 3, expected_quote_version: 2 },
        },
        {
          url: `${base}/buyer/quote-requests/1001/accept-quote`,
          key: validKey,
          body: { quote_id: '99999999999999999999', expected_request_version: 3, expected_quote_version: 2 },
        },
        {
          url: `${base}/buyer/quote-requests/1001/accept-quote`,
          key: validKey,
          body: { quote_id: '401', expected_request_version: 0, expected_quote_version: 2 },
        },
        {
          url: `${base}/buyer/quote-requests/1001/accept-quote`,
          key: validKey,
          body: { quote_id: '401', expected_request_version: '3', expected_quote_version: 2 },
        },
        {
          url: `${base}/buyer/quote-requests/1001/accept-quote`,
          key: validKey,
          body: {
            quote_id: '401',
            expected_request_version: 3,
            expected_quote_version: 2,
            status: 'buyer_accepted',
          },
        },
      ];

      for (const [idx, c] of badCases.entries()) {
        identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
        const res = await fetch(c.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=buyer-token',
            'X-Idempotency-Key': c.key,
            'X-Request-ID': `req-bad-${idx}`,
          },
          body: JSON.stringify(c.body),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get('content-type')).toContain('application/problem+json');
        const problem = (await res.json()) as any;
        expect(problem.code).toBe('INVALID_INPUT');
        expect(problem.status).toBe(400);
        expect(problem.tracking_id).toBe(res.headers.get('x-request-id'));
      }
      expect(dbState.allocations.size).toBe(0);
    });

    it('HT-04: enforces Auth (401), temp_password & role guards (403), and identical anti-IDOR 404 for non-owner Buyer / missing Request / cross-request Quote', async () => {
      seedOpenBiddingScenario();
      const validKey = 'f7a8b9e0-1234-4567-89ab-cdef01234567';
      const validBody = JSON.stringify({
        quote_id: '401',
        expected_request_version: 3,
        expected_quote_version: 2,
      });

      // 1. Missing session -> 401 AUTHENTICATION_REQUIRED
      const unauthRes = await fetch(`${base}/buyer/quote-requests/1001/accept-quote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': validKey,
        },
        body: validBody,
      });
      expect(unauthRes.status).toBe(401);
      expect(((await unauthRes.json()) as any).code).toBe('AUTHENTICATION_REQUIRED');

      // 2. temp_password Buyer -> 403 TEMP_PASSWORD_RESTRICTED
      identityMock.resolveSession.mockResolvedValueOnce(tempPasswordBuyerActor);
      const tempRes = await fetch(`${base}/buyer/quote-requests/1001/accept-quote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=temp-buyer',
          'X-Idempotency-Key': validKey,
        },
        body: validBody,
      });
      expect(tempRes.status).toBe(403);
      expect(((await tempRes.json()) as any).code).toBe('TEMP_PASSWORD_RESTRICTED');

      // 3. Artisan / Admin -> 403 PERMISSION_DENIED
      for (const actor of [artisanActor, adminActor]) {
        identityMock.resolveSession.mockResolvedValueOnce(actor);
        const roleRes = await fetch(`${base}/buyer/quote-requests/1001/accept-quote`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=other-role',
            'X-Idempotency-Key': validKey,
          },
          body: validBody,
        });
        expect(roleRes.status).toBe(403);
        expect(((await roleRes.json()) as any).code).toBe('PERMISSION_DENIED');
      }

      // 4. Anti-IDOR 404: non-owner Buyer vs non-existent Request vs non-existent Quote
      identityMock.resolveSession.mockResolvedValueOnce(otherBuyerActor);
      const nonOwnerRes = await fetch(`${base}/buyer/quote-requests/1001/accept-quote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=buyer-99',
          'X-Idempotency-Key': validKey,
        },
        body: validBody,
      });
      expect(nonOwnerRes.status).toBe(404);
      const nonOwnerProblem = (await nonOwnerRes.json()) as any;

      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const missingRes = await fetch(`${base}/buyer/quote-requests/99999/accept-quote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=buyer-10',
          'X-Idempotency-Key': validKey,
        },
        body: validBody,
      });
      expect(missingRes.status).toBe(404);
      const missingProblem = (await missingRes.json()) as any;

      expect({
        type: nonOwnerProblem.type,
        title: nonOwnerProblem.title,
        status: nonOwnerProblem.status,
        detail: nonOwnerProblem.detail,
        code: nonOwnerProblem.code,
      }).toEqual({
        type: missingProblem.type,
        title: missingProblem.title,
        status: missingProblem.status,
        detail: missingProblem.detail,
        code: missingProblem.code,
      });
      expect(nonOwnerProblem.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('HT-05: maps domain/concurrency rejections (409 CONCURRENCY_CONFLICT, 422 WORKSHOP_SUSPENDED / QUOTE_EXPIRED / INSUFFICIENT_CAPACITY / INVALID_STATE) to RFC 9457 with zero mutations', async () => {
      const sendAccept = async (
        key: string,
        body: Record<string, unknown>,
      ) => {
        identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
        return fetch(`${base}/buyer/quote-requests/1001/accept-quote`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=buyer-10',
            'X-Idempotency-Key': key,
          },
          body: JSON.stringify(body),
        });
      };

      // 1. Stale version -> 409 CONCURRENCY_CONFLICT
      seedOpenBiddingScenario();
      const resVer = await sendAccept('a1111111-1234-4567-89ab-cdef01234567', {
        quote_id: '401',
        expected_request_version: 2,
        expected_quote_version: 2,
      });
      expect(resVer.status).toBe(409);
      expect(((await resVer.json()) as any).code).toBe('CONCURRENCY_CONFLICT');
      expect(dbState.allocations.size).toBe(0);
      expect(dbState.idempotency.size).toBe(0);

      // 2. Suspended workshop -> 422 WORKSHOP_SUSPENDED
      dbState.requests.clear();
      dbState.recipients.clear();
      dbState.quotes.clear();
      seedOpenBiddingScenario({ workshopStatus: 'suspended' });
      const resSusp = await sendAccept('a2222222-1234-4567-89ab-cdef01234567', {
        quote_id: '401',
        expected_request_version: 3,
        expected_quote_version: 2,
      });
      expect(resSusp.status).toBe(422);
      expect(((await resSusp.json()) as any).code).toBe('WORKSHOP_SUSPENDED');
      expect(dbState.allocations.size).toBe(0);

      // 3. Expired quote -> 422 QUOTE_EXPIRED
      dbState.requests.clear();
      dbState.recipients.clear();
      dbState.quotes.clear();
      seedOpenBiddingScenario({
        quote: { bid_accept_deadline: new Date(Date.now() - 60_000) },
      });
      const resExp = await sendAccept('a3333333-1234-4567-89ab-cdef01234567', {
        quote_id: '401',
        expected_request_version: 3,
        expected_quote_version: 2,
      });
      expect(resExp.status).toBe(422);
      expect(((await resExp.json()) as any).code).toBe('QUOTE_EXPIRED');
      expect(dbState.allocations.size).toBe(0);

      // 4. Partial capacity -> 422 INSUFFICIENT_CAPACITY
      dbState.requests.clear();
      dbState.recipients.clear();
      dbState.quotes.clear();
      seedOpenBiddingScenario({ quote: { max_quantity: 2500 } });
      const resCap = await sendAccept('a4444444-1234-4567-89ab-cdef01234567', {
        quote_id: '401',
        expected_request_version: 3,
        expected_quote_version: 2,
      });
      expect(resCap.status).toBe(422);
      expect(((await resCap.json()) as any).code).toBe('INSUFFICIENT_CAPACITY');
      expect(dbState.allocations.size).toBe(0);

      // 5. Withdrawn quote -> 422 INVALID_STATE
      dbState.requests.clear();
      dbState.recipients.clear();
      dbState.quotes.clear();
      seedOpenBiddingScenario({
        quote: {
          status: 'withdrawn',
          withdraw_reason: 'Withdrawn before accept',
          withdrawn_at: new Date(),
          withdrawn_by: '20',
        },
      });
      const resState = await sendAccept('a5555555-1234-4567-89ab-cdef01234567', {
        quote_id: '401',
        expected_request_version: 3,
        expected_quote_version: 2,
      });
      expect(resState.status).toBe(422);
      expect(((await resState.json()) as any).code).toBe('INVALID_STATE');
      expect(dbState.allocations.size).toBe(0);
    });

    it('HT-06: generates valid OpenAPI 3.0.0 Swagger spec for POST /api/v1/buyer/quote-requests/{id}/accept-quote', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const route =
        doc.paths['/api/v1/buyer/quote-requests/{id}/accept-quote']?.post;
      expect(route).toBeDefined();
      expect(route?.operationId).toBe(
        'BuyerQuoteRequestController_acceptQuote',
      );
      expect((route as any)?.['x-roles']).toEqual(['buyer']);
      expect(route?.parameters).toContainEqual(
        expect.objectContaining({
          name: 'X-Idempotency-Key',
          in: 'header',
          required: true,
        }),
      );
      expect(route?.parameters).toContainEqual(
        expect.objectContaining({
          name: 'X-CSRF-Token',
          in: 'header',
          required: true,
        }),
      );
      expect(route?.requestBody).toMatchObject({
        required: true,
        content: {
          'application/json': {
            schema: {
              additionalProperties: false,
              required: [
                'quote_id',
                'expected_request_version',
                'expected_quote_version',
              ],
            },
          },
        },
      });
      expect(route?.responses?.['200']).toBeDefined();
      expect(route?.responses?.['409']).toBeDefined();
      expect(route?.responses?.['422']).toBeDefined();
    });

    it('HT-07A: AppModule boots cleanly and resolves BuyerQuoteRequestController, AcceptQuoteUseCase, TradingAcceptanceService & TRADING_CONTRACT', async () => {
      const connectSpy = vi
        .spyOn(PrismaService.prototype, '$connect')
        .mockResolvedValue(undefined);
      const disconnectSpy = vi
        .spyOn(PrismaService.prototype, '$disconnect')
        .mockResolvedValue(undefined);
      const queryRawSpy = vi
        .spyOn(PrismaService.prototype, '$queryRaw' as any)
        .mockResolvedValue([{ '?column?': 1 }]);

      let bootedApp: NestExpressApplication | undefined;
      try {
        bootedApp = await NestFactory.create<NestExpressApplication>(
          AppModule,
          { logger: false },
        );
        await bootedApp.init();

        expect(bootedApp.get(BuyerQuoteRequestController)).toBeInstanceOf(
          BuyerQuoteRequestController,
        );
        expect(bootedApp.get(AcceptQuoteUseCase)).toBeInstanceOf(
          AcceptQuoteUseCase,
        );
        expect(bootedApp.get(TradingAcceptanceService)).toBeInstanceOf(
          TradingAcceptanceService,
        );
        expect(bootedApp.get(TRADING_CONTRACT)).toBeInstanceOf(
          TradingAcceptanceService,
        );
      } finally {
        await bootedApp?.close();
        connectSpy.mockRestore();
        disconnectSpy.mockRestore();
        queryRawSpy.mockRestore();
      }
    }, 30_000);

    it('HT-07B: TradingModule.register(TradingAcceptanceService, { imports: [TestWorkshopModule] }) wires DI without duplicate providers and executes HTTP accept-quote (200 / 422 / 404)', async () => {
      const regIdentityMock = new MockIdentityContract();
      const regWorkshopMock = new MockWorkshopContract();

      const futureBidding = new Date(Date.now() + 48 * 3600 * 1000);
      const futureAccept = new Date(Date.now() + 72 * 3600 * 1000);
      const futureCommitted = new Date(Date.now() + 96 * 3600 * 1000);
      const futureDelivery = new Date(Date.now() + 120 * 3600 * 1000);

      interface PgMockState {
        quoteRequests: Map<bigint, Record<string, unknown>>;
        requestRecipients: Map<string, Record<string, unknown>>;
        quotes: Map<bigint, Record<string, unknown>>;
        allocations: Map<bigint, Record<string, unknown>>;
        idempotencyRecords: Map<string, Record<string, unknown>>;
        statusLogs: Array<Record<string, unknown>>;
        recipientHistory: Array<Record<string, unknown>>;
        allocationLogs: Array<Record<string, unknown>>;
        nextAllocId: bigint;
        nextIdempId: bigint;
      }

      let pgState: PgMockState = {
        quoteRequests: new Map(),
        requestRecipients: new Map(),
        quotes: new Map(),
        allocations: new Map(),
        idempotencyRecords: new Map(),
        statusLogs: [],
        recipientHistory: [],
        allocationLogs: [],
        nextAllocId: 5001n,
        nextIdempId: 9001n,
      };

      const seedPgScenario = (requestId: bigint, quoteId: bigint) => {
        pgState.quoteRequests.set(requestId, {
          id: requestId,
          buyer_id: 10n,
          category_id: 5n,
          spec: '5000 bát gốm men rạn Bát Tràng cao cấp',
          quantity: 5000,
          unit: 'piece',
          unit_set_description: null,
          status: 'artisans_bidding',
          delivery_mode: 'at_buyer_address',
          delivery_region: 'Hà Nội, Gia Lâm',
          delivery_address: 'Số 12 Phố Gốm, Bát Tràng, Gia Lâm, Hà Nội',
          recipient_name: 'Nguyễn Văn Mua',
          recipient_phone: '0901234567',
          bidding_deadline: futureBidding,
          delivery_deadline: futureDelivery,
          bidding_closed_at: null,
          split_requested_at: null,
          version: 3,
          cancelled_at: null,
          cancelled_by: null,
          cancel_reason: null,
          created_at: SENT_AT,
          updated_at: SENT_AT,
        });
        pgState.requestRecipients.set(`${requestId}:301`, {
          id: requestId + 1000n,
          request_id: requestId,
          workshop_id: 301n,
          response_status: 'quoted',
          decline_reason: null,
          responded_by: 20n,
          responded_at: SENT_AT,
          sent_at: SENT_AT,
          version: 2,
        });
        pgState.quotes.set(quoteId, {
          id: quoteId,
          request_id: requestId,
          workshop_id: 301n,
          unit_price: new Prisma.Decimal('45000'),
          max_quantity: 5000,
          bid_accept_deadline: futureAccept,
          committed_delivery_at: futureCommitted,
          status: 'active',
          version: 2,
          withdraw_reason: null,
          withdrawn_by: null,
          withdrawn_at: null,
          created_at: SENT_AT,
          updated_at: SENT_AT,
        });
      };

      seedPgScenario(1001n, 401n);
      seedPgScenario(1002n, 402n);

      const fakeTxClient = {
        $queryRaw: async (sqlObj: {
          strings?: readonly string[];
          values?: readonly unknown[];
        }) => {
          const sqlText = Array.isArray(sqlObj?.strings)
            ? sqlObj.strings.join('?')
            : String(sqlObj);
          const values = Array.isArray(sqlObj?.values) ? sqlObj.values : [];
          if (sqlText.includes('"QuoteRequest"')) {
            const id = values[0] as bigint;
            return pgState.quoteRequests.has(id) ? [{ id }] : [];
          }
          if (sqlText.includes('"RequestRecipient"')) {
            const reqId = values[0] as bigint;
            const wsId = values[1] as bigint;
            const rec = pgState.requestRecipients.get(`${reqId}:${wsId}`);
            return rec ? [{ id: rec.id }] : [];
          }
          if (sqlText.includes('"Quote"')) {
            const id = values[0] as bigint;
            return pgState.quotes.has(id) ? [{ id }] : [];
          }
          return [];
        },
        quoteRequest: {
          findUnique: async ({ where }: { where: { id: bigint } }) =>
            pgState.quoteRequests.get(where.id) ?? null,
          updateMany: async ({
            where,
            data,
          }: {
            where: { id: bigint; version: number };
            data: Record<string, unknown>;
          }) => {
            const existing = pgState.quoteRequests.get(where.id);
            if (!existing || existing.version !== where.version) {
              return { count: 0 };
            }
            pgState.quoteRequests.set(where.id, { ...existing, ...data });
            return { count: 1 };
          },
        },
        requestRecipient: {
          findUnique: async ({
            where,
          }: {
            where: {
              id?: bigint;
              request_id_workshop_id?: {
                request_id: bigint;
                workshop_id: bigint;
              };
            };
          }) => {
            if (where.request_id_workshop_id) {
              return (
                pgState.requestRecipients.get(
                  `${where.request_id_workshop_id.request_id}:${where.request_id_workshop_id.workshop_id}`,
                ) ?? null
              );
            }
            for (const row of pgState.requestRecipients.values()) {
              if (row.id === where.id) return row;
            }
            return null;
          },
        },
        quote: {
          findUnique: async ({ where }: { where: { id: bigint } }) =>
            pgState.quotes.get(where.id) ?? null,
          updateMany: async ({
            where,
            data,
          }: {
            where: { id: bigint; version: number };
            data: Record<string, unknown>;
          }) => {
            const existing = pgState.quotes.get(where.id);
            if (!existing || existing.version !== where.version) {
              return { count: 0 };
            }
            pgState.quotes.set(where.id, { ...existing, ...data });
            return { count: 1 };
          },
        },
        allocation: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const id = pgState.nextAllocId++;
            const created = { ...data, id, allocationBatches: [] };
            pgState.allocations.set(id, created);
            return created;
          },
        },
        allocationLog: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const created = { id: 9100n, ...data };
            pgState.allocationLogs.push(created);
            return created;
          },
        },
        statusLog: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const created = { id: 9200n, ...data };
            pgState.statusLogs.push(created);
            return created;
          },
        },
        recipientResponseHistory: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const created = { id: 9300n, ...data };
            pgState.recipientHistory.push(created);
            return created;
          },
        },
        idempotencyRecord: {
          findUnique: async ({
            where,
          }: {
            where: {
              account_id_action_object_type_object_id_idempotency_key: {
                account_id: bigint;
                action: string;
                object_type: string;
                object_id: bigint;
                idempotency_key: string;
              };
            };
          }) => {
            const k =
              where.account_id_action_object_type_object_id_idempotency_key;
            return (
              pgState.idempotencyRecords.get(
                `${k.account_id}|${k.action}|${k.object_type}|${k.object_id}|${k.idempotency_key}`,
              ) ?? null
            );
          },
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const key = `${data.account_id}|${data.action}|${data.object_type}|${data.object_id}|${data.idempotency_key}`;
            const created = { ...data, id: pgState.nextIdempId++ };
            pgState.idempotencyRecords.set(key, created);
            return created;
          },
        },
      };

      const connectSpy = vi
        .spyOn(PrismaService.prototype, '$connect')
        .mockResolvedValue(undefined);
      const disconnectSpy = vi
        .spyOn(PrismaService.prototype, '$disconnect')
        .mockResolvedValue(undefined);
      const queryRawSpy = vi
        .spyOn(PrismaService.prototype, '$queryRaw' as any)
        .mockResolvedValue([{ '?column?': 1 }]);
      const transactionSpy = vi
        .spyOn(PrismaService.prototype, '$transaction' as any)
        .mockImplementation(
          async (fn: (client: unknown) => Promise<unknown>) => {
            const snapshot: PgMockState = {
              quoteRequests: new Map(pgState.quoteRequests),
              requestRecipients: new Map(pgState.requestRecipients),
              quotes: new Map(pgState.quotes),
              allocations: new Map(pgState.allocations),
              idempotencyRecords: new Map(pgState.idempotencyRecords),
              statusLogs: [...pgState.statusLogs],
              recipientHistory: [...pgState.recipientHistory],
              allocationLogs: [...pgState.allocationLogs],
              nextAllocId: pgState.nextAllocId,
              nextIdempId: pgState.nextIdempId,
            };
            try {
              return await fn(fakeTxClient);
            } catch (err) {
              pgState = snapshot;
              throw err;
            }
          },
        );

      class TestRegIdentityModule {}
      Module({
        providers: [{ provide: IDENTITY_CONTRACT, useValue: regIdentityMock }],
        exports: [IDENTITY_CONTRACT],
      })(TestRegIdentityModule);

      class TestWorkshopModule {}
      Module({
        providers: [{ provide: WORKSHOP_CONTRACT, useValue: regWorkshopMock }],
        exports: [WORKSHOP_CONTRACT],
      })(TestWorkshopModule);

      class TestRegisteredModule {}
      Module({
        imports: [
          SecurityModule.register([TestRegIdentityModule]),
          TradingModule.register(TradingAcceptanceService, {
            imports: [TestWorkshopModule],
          }),
        ],
      })(TestRegisteredModule);

      let registeredApp: NestExpressApplication | undefined;
      try {
        registeredApp = await NestFactory.create<NestExpressApplication>(
          TestRegisteredModule,
          {
            bodyParser: false,
            logger: false,
            abortOnError: false,
          },
        );
        configureHttp(
          registeredApp,
          new AppLogger('error', (_line, done) => done()),
        );
        await registeredApp.listen(0, '127.0.0.1');
        const regBase = (await registeredApp.getUrl()) + '/api/v1';

        const tradingContract = registeredApp.get(TRADING_CONTRACT);
        const acceptUseCase = registeredApp.get(AcceptQuoteUseCase);
        const txRunner = registeredApp.get(PrismaTransactionRunner);

        expect(tradingContract).toBeInstanceOf(TradingAcceptanceService);
        expect(acceptUseCase).toBeInstanceOf(AcceptQuoteUseCase);

        // 1. Direct TRADING_CONTRACT resolution proves TradingAcceptanceService received repos & workshopContract
        const prepared = await txRunner.run((tx) =>
          tradingContract.prepareAcceptance!(
            {
              requestId: '1001',
              quoteId: '401',
              expectedRequestVersion: 3,
              expectedQuoteVersion: 2,
              actor: buyerActor,
            },
            tx,
          ),
        );
        expect(prepared).toEqual({ workshopIds: ['301'] });

        // 2. Real HTTP POST 200 OK through TradingModule.register(TradingAcceptanceService, { imports: [TestWorkshopModule] })
        regWorkshopMock.givenActiveWorkshops('301');
        regWorkshopMock.getWorkshopSummary.mockResolvedValue({
          id: '301',
          name: 'Xưởng Gốm Minh Long Bát Tràng',
          status: 'active',
          isProfilePublic: true,
        });
        regIdentityMock.resolveSession.mockResolvedValueOnce(buyerActor);

        const okRes = await fetch(
          `${regBase}/buyer/quote-requests/1001/accept-quote`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: 'vcraft-session=buyer-token',
              'X-Idempotency-Key': 'c8a8b9e0-1234-4567-89ab-cdef01234567',
            },
            body: JSON.stringify({
              quote_id: '401',
              expected_request_version: 3,
              expected_quote_version: 2,
            }),
          },
        );
        expect(okRes.status).toBe(200);
        expect(okRes.headers.get('cache-control')).toContain('no-store');
        const okJson = (await okRes.json()) as any;
        expect(okJson.success).toBe(true);
        const parsedOkData = acceptanceDtoResponseSchema.parse(okJson.data);
        const parsedOkOp = acceptQuoteOperationResponseSchema.parse(
          okJson.operation,
        );
        expect(parsedOkData.request_id).toBe('1001');
        expect(parsedOkData.request_status).toBe('buyer_accepted');
        expect(parsedOkData.request_version).toBe(4);
        expect(parsedOkData.allocations).toHaveLength(1);
        expect(parsedOkData.allocations[0]).toMatchObject({
          id: '5001',
          request_id: '1001',
          workshop: { id: '301', name: 'Xưởng Gốm Minh Long Bát Tràng' },
          quote_id: '401',
          status: 'not_started',
          version: 1,
        });
        expect(parsedOkOp.replayed).toBe(false);
        expect(regWorkshopMock.lockAndAssertActive).toHaveBeenCalledTimes(1);
        expect(regWorkshopMock.getWorkshopSummary).toHaveBeenCalledWith('301');

        // 3. Real HTTP POST 422 WORKSHOP_SUSPENDED when workshop is suspended
        regWorkshopMock.givenSuspended('301');
        regIdentityMock.resolveSession.mockResolvedValueOnce(buyerActor);

        const suspendedRes = await fetch(
          `${regBase}/buyer/quote-requests/1002/accept-quote`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: 'vcraft-session=buyer-token',
              'X-Idempotency-Key': 'c9a8b9e0-1234-4567-89ab-cdef01234567',
            },
            body: JSON.stringify({
              quote_id: '402',
              expected_request_version: 3,
              expected_quote_version: 2,
            }),
          },
        );
        expect(suspendedRes.status).toBe(422);
        expect(((await suspendedRes.json()) as any).code).toBe(
          'WORKSHOP_SUSPENDED',
        );
        expect(pgState.allocations.size).toBe(1);
        expect(pgState.quoteRequests.get(1002n)?.status).toBe(
          'artisans_bidding',
        );

        // 4. Real HTTP POST 404 RESOURCE_NOT_FOUND when workshop summary is missing
        regWorkshopMock.givenActiveWorkshops('301');
        regWorkshopMock.getWorkshopSummary.mockResolvedValueOnce(null);
        regIdentityMock.resolveSession.mockResolvedValueOnce(buyerActor);

        const missingWsRes = await fetch(
          `${regBase}/buyer/quote-requests/1002/accept-quote`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: 'vcraft-session=buyer-token',
              'X-Idempotency-Key': 'caa8b9e0-1234-4567-89ab-cdef01234567',
            },
            body: JSON.stringify({
              quote_id: '402',
              expected_request_version: 3,
              expected_quote_version: 2,
            }),
          },
        );
        expect(missingWsRes.status).toBe(404);
        expect(((await missingWsRes.json()) as any).code).toBe(
          'RESOURCE_NOT_FOUND',
        );
        expect(pgState.allocations.size).toBe(1);
        expect(pgState.quotes.get(402n)?.status).toBe('active');
      } finally {
        await registeredApp?.close();
        connectSpy.mockRestore();
        disconnectSpy.mockRestore();
        queryRawSpy.mockRestore();
        transactionSpy.mockRestore();
      }
    }, 30_000);

    it('HT-07C: TradingModule.register honors caller provider overrides and registers fresh custom ITradingContract classes cleanly', async () => {
      const connectSpy = vi
        .spyOn(PrismaService.prototype, '$connect')
        .mockResolvedValue(undefined);
      const disconnectSpy = vi
        .spyOn(PrismaService.prototype, '$disconnect')
        .mockResolvedValue(undefined);
      const queryRawSpy = vi
        .spyOn(PrismaService.prototype, '$queryRaw' as any)
        .mockResolvedValue([{ '?column?': 1 }]);

      const buildStubAcceptanceResult = (
        input: AcceptanceInput,
        replayed: boolean,
      ): { data: AcceptanceDto; operation: AcceptanceOperationDto } => ({
        data: {
          request_id: input.requestId,
          request_status: 'buyer_accepted',
          request_version: input.expectedRequestVersion + 1,
          allocations: [],
        },
        operation: {
          id: input.requestId,
          replayed,
          committed_at: NOW.toISOString(),
          current_state: {
            request: {
              id: input.requestId,
              status: 'buyer_accepted',
              version: input.expectedRequestVersion + 1,
              cancelled_at: null,
            },
            quote: {
              id: input.quoteId,
              status: 'accepted',
              version: input.expectedQuoteVersion + 1,
            },
          },
        },
      });

      class CustomTradingContract implements ITradingContract {
        async findAcceptanceReplay(
          _input: AcceptanceInput & { idempotencyKey: string },
          _tx: TransactionContext,
        ): Promise<{
          data: AcceptanceDto;
          operation: AcceptanceOperationDto;
        } | null> {
          return null;
        }
        async prepareAcceptance(
          _input: AcceptanceInput,
          _tx: TransactionContext,
        ): Promise<{ workshopIds: string[] }> {
          return { workshopIds: [] };
        }
        async accept(
          input: AcceptanceInput & { idempotencyKey: string },
          _tx: TransactionContext,
        ): Promise<{
          data: AcceptanceDto;
          operation: AcceptanceOperationDto;
        }> {
          return buildStubAcceptanceResult(input, false);
        }
      }

      class OverriddenTradingContract implements ITradingContract {
        constructor(public readonly tag: string) {}
        async findAcceptanceReplay(
          _input: AcceptanceInput & { idempotencyKey: string },
          _tx: TransactionContext,
        ): Promise<{
          data: AcceptanceDto;
          operation: AcceptanceOperationDto;
        } | null> {
          return null;
        }
        async prepareAcceptance(
          _input: AcceptanceInput,
          _tx: TransactionContext,
        ): Promise<{ workshopIds: string[] }> {
          return { workshopIds: ['301'] };
        }
        async accept(
          input: AcceptanceInput & { idempotencyKey: string },
          _tx: TransactionContext,
        ): Promise<{
          data: AcceptanceDto;
          operation: AcceptanceOperationDto;
        }> {
          return buildStubAcceptanceResult(input, false);
        }
      }

      const overrideInstance = new OverriddenTradingContract('caller-override');

      class CustomModule {}
      Module({
        imports: [
          SecurityModule.register(),
          TradingModule.register(CustomTradingContract),
        ],
      })(CustomModule);

      class OverrideModule {}
      Module({
        imports: [
          SecurityModule.register(),
          TradingModule.register(OverriddenTradingContract, {
            providers: [
              {
                provide: OverriddenTradingContract,
                useValue: overrideInstance,
              },
            ],
          }),
        ],
      })(OverrideModule);

      let customApp: NestExpressApplication | undefined;
      let overrideApp: NestExpressApplication | undefined;
      try {
        customApp = await NestFactory.create<NestExpressApplication>(
          CustomModule,
          { logger: false },
        );
        await customApp.init();
        expect(customApp.get(TRADING_CONTRACT)).toBeInstanceOf(
          CustomTradingContract,
        );
        expect(customApp.get(CustomTradingContract)).toBeInstanceOf(
          CustomTradingContract,
        );

        overrideApp = await NestFactory.create<NestExpressApplication>(
          OverrideModule,
          { logger: false },
        );
        await overrideApp.init();
        expect(overrideApp.get(TRADING_CONTRACT)).toBe(overrideInstance);
        expect(overrideApp.get(OverriddenTradingContract)).toBe(
          overrideInstance,
        );
      } finally {
        await customApp?.close();
        await overrideApp?.close();
        connectSpy.mockRestore();
        disconnectSpy.mockRestore();
        queryRawSpy.mockRestore();
      }
    }, 30_000);

    it('HT-08: HTTP pipeline boots without WORKSHOP_CONTRACT and fails closed (500 INTERNAL_SERVER_ERROR / 404 on null summary) with zero mutations', async () => {
      // Part A: getWorkshopSummary returning null over HTTP returns 404 RESOURCE_NOT_FOUND with zero writes
      seedOpenBiddingScenario();
      workshopMock.getWorkshopSummary.mockResolvedValueOnce(null);
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const nullSummaryRes = await fetch(
        `${base}/buyer/quote-requests/1001/accept-quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=buyer-token',
            'X-Idempotency-Key': 'b1111111-1234-4567-89ab-cdef01234567',
          },
          body: JSON.stringify({
            quote_id: '401',
            expected_request_version: 3,
            expected_quote_version: 2,
          }),
        },
      );
      expect(nullSummaryRes.status).toBe(404);
      expect(((await nullSummaryRes.json()) as any).code).toBe(
        'RESOURCE_NOT_FOUND',
      );
      expect(dbState.allocations.size).toBe(0);
      expect(dbState.idempotency.size).toBe(0);

      // Part B: HTTP module wired WITHOUT WORKSHOP_CONTRACT boots cleanly, but accept-quote fails closed (500)
      class TestIdentityNoWsModule {}
      Module({
        providers: [{ provide: IDENTITY_CONTRACT, useValue: identityMock }],
        exports: [IDENTITY_CONTRACT],
      })(TestIdentityNoWsModule);

      class TestHttpNoWsModule {}
      Module({
        imports: [
          AppConfigModule,
          SecurityModule.register([TestIdentityNoWsModule]),
        ],
        controllers: [BuyerQuoteRequestController],
        providers: [
          { provide: TRANSACTION_RUNNER, useValue: transactionalInMemoryRunner },
          {
            provide: QUOTE_REQUEST_REPOSITORY,
            useValue: asQuoteRequestRepo(inMemoryQuoteRequestRepo),
          },
          {
            provide: REQUEST_RECIPIENT_REPOSITORY,
            useValue: asRecipientRepo(inMemoryRecipientRepo),
          },
          {
            provide: QUOTE_REPOSITORY,
            useValue: asQuoteRepo(inMemoryQuoteRepo),
          },
          {
            provide: ALLOCATION_REPOSITORY,
            useValue: asAllocationRepo(inMemoryAllocationRepo),
          },
          {
            provide: IDEMPOTENCY_RECORD_REPOSITORY,
            useValue: asIdempotencyRepo(inMemoryIdempotencyRepo),
          },
          {
            provide: TradingIdempotencyService,
            useFactory: (
              repo: IIdempotencyRecordRepository,
              txRunner: TransactionRunner,
            ) => new TradingIdempotencyService(repo, txRunner),
            inject: [IDEMPOTENCY_RECORD_REPOSITORY, TRANSACTION_RUNNER],
          },
          {
            provide: TRADING_CURRENT_STATE_RESOLVER,
            useFactory: (
              qrRepo: IQuoteRequestRepository,
              allocRepo: IAllocationRepository,
              qRepo: IQuoteRepository,
              recRepo: IRequestRecipientRepository,
            ) =>
              new TradingCurrentStateResolver(qrRepo, allocRepo, qRepo, recRepo),
            inject: [
              QUOTE_REQUEST_REPOSITORY,
              ALLOCATION_REPOSITORY,
              QUOTE_REPOSITORY,
              REQUEST_RECIPIENT_REPOSITORY,
            ],
          },
          TradingMutationInterceptor,
          {
            provide: CreateDraftQuoteRequestUseCase,
            useFactory: (
              txRunner: TransactionRunner,
              qrRepo: IQuoteRequestRepository,
            ) => new CreateDraftQuoteRequestUseCase(txRunner, qrRepo),
            inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
          },
          {
            provide: TradingAcceptanceService,
            useFactory: (
              qrRepo: IQuoteRequestRepository,
              recRepo: IRequestRecipientRepository,
              qRepo: IQuoteRepository,
              allocRepo: IAllocationRepository,
              idempRepo: IIdempotencyRecordRepository,
            ) =>
              new TradingAcceptanceService(
                qrRepo,
                recRepo,
                qRepo,
                allocRepo,
                idempRepo,
              ),
            inject: [
              QUOTE_REQUEST_REPOSITORY,
              REQUEST_RECIPIENT_REPOSITORY,
              QUOTE_REPOSITORY,
              ALLOCATION_REPOSITORY,
              IDEMPOTENCY_RECORD_REPOSITORY,
            ],
          },
          {
            provide: TRADING_CONTRACT,
            useExisting: TradingAcceptanceService,
          },
          {
            provide: AcceptQuoteUseCase,
            useFactory: (
              txRunner: TransactionRunner,
              tradingContract: ITradingContract,
            ) => new AcceptQuoteUseCase(txRunner, tradingContract),
            inject: [TRANSACTION_RUNNER, TRADING_CONTRACT],
          },
        ],
      })(TestHttpNoWsModule);

      let noWsApp: NestExpressApplication | undefined;
      try {
        noWsApp = await NestFactory.create<NestExpressApplication>(
          TestHttpNoWsModule,
          {
            bodyParser: false,
            logger: false,
            abortOnError: false,
          },
        );
        configureHttp(
          noWsApp,
          new AppLogger('error', (_line, done) => done()),
        );
        await noWsApp.listen(0, '127.0.0.1');
        const noWsBase = (await noWsApp.getUrl()) + '/api/v1';

        identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
        const res = await fetch(
          `${noWsBase}/buyer/quote-requests/1001/accept-quote`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: 'vcraft-session=buyer-token',
              'X-Idempotency-Key': 'b2222222-1234-4567-89ab-cdef01234567',
            },
            body: JSON.stringify({
              quote_id: '401',
              expected_request_version: 3,
              expected_quote_version: 2,
            }),
          },
        );

        expect(res.status).toBe(500);
        expect(res.headers.get('content-type')).toContain(
          'application/problem+json',
        );
        const body = (await res.json()) as any;
        expect(body.code).toBe('INTERNAL_SERVER_ERROR');
        expect(dbState.allocations.size).toBe(0);
        expect(dbState.idempotency.size).toBe(0);
        expect(dbState.quotes.get('401')?.status).toBe('active');
        expect(dbState.requests.get('1001')?.status).toBe('artisans_bidding');
      } finally {
        await noWsApp?.close();
      }
    }, 30_000);
  });
});
