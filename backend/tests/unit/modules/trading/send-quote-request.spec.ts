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
import { MockCatalogContract } from '../../../support/mocks/catalog.mock';
import { MockWorkshopContract } from '../../../support/mocks/workshop.mock';
import { TRANSACTION_RUNNER } from '../../../../src/common/application/ports/transaction-runner';
import {
  QUOTE_REQUEST_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { CATALOG_CONTRACT } from '../../../../src/modules/catalog/public/contracts/catalog.contract';
import { WORKSHOP_CONTRACT } from '../../../../src/modules/workshops/public/contracts/workshop.contract';
import { CreateDraftQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/create-draft-quote-request.use-case';
import { SendQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/send-quote-request.use-case';
import { SendRequestWorkflow } from '../../../../src/workflows/send-request/send-request.workflow';
import { BuyerQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/buyer-quote-request.controller';
import {
  ConcurrencyConflictError,
  DeadlineViolationError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  NoEligibleWorkshopError,
  QuoteRequest,
  type QuoteRequestProps,
  QuoteRequestNotFoundError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import { WorkshopSuspended } from '../../../../src/modules/workshops/domain/errors/workshop-suspended';
import { BusinessRuleException } from '../../../../src/common/domain/errors/business-rule.exception';
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
    spec: 'Bat Trang Glazed Tea Set Spec',
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
let lastSavedStatusLogs: any[] = [];
let lastCreatedRecipients: any[] = [];

const mockQuoteRequestRepo = {
  createDraft: vi.fn(),
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
  update: vi.fn().mockImplementation(async ({ request, statusLogs }: any) => {
    currentQuoteRequest = request;
    lastSavedStatusLogs = statusLogs ?? [];
    return request;
  }),
};

const mockRecipientRepo = {
  createMany: vi.fn().mockImplementation(async (recipients: any[]) => {
    lastCreatedRecipients = [...recipients];
    return recipients;
  }),
};

const catalogMock = new MockCatalogContract();
const workshopMock = new MockWorkshopContract();

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
    { provide: QUOTE_REQUEST_REPOSITORY, useValue: mockQuoteRequestRepo },
    { provide: REQUEST_RECIPIENT_REPOSITORY, useValue: mockRecipientRepo },
    { provide: CATALOG_CONTRACT, useValue: catalogMock },
    { provide: WORKSHOP_CONTRACT, useValue: workshopMock },
    {
      provide: CreateDraftQuoteRequestUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new CreateDraftQuoteRequestUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
    {
      provide: SendQuoteRequestUseCase,
      useFactory: (
        txRunner: any,
        quoteRequestRepo: any,
        recipientRepo: any,
        catalog: any,
        workshop: any,
      ) =>
        new SendQuoteRequestUseCase(
          txRunner,
          quoteRequestRepo,
          recipientRepo,
          catalog,
          workshop,
        ),
      inject: [
        TRANSACTION_RUNNER,
        QUOTE_REQUEST_REPOSITORY,
        REQUEST_RECIPIENT_REPOSITORY,
        CATALOG_CONTRACT,
        WORKSHOP_CONTRACT,
      ],
    },
  ],
})(TestTradingModule);

describe('Task 17: Workflow gửi yêu cầu báo giá (send-request)', () => {
  describe('SendQuoteRequestUseCase & SendRequestWorkflow (Domain & Application Logic)', () => {
    it('UT-01 (Happy Path): successfully sends quote request, transitions to sent_to_artisans, increments version, creates recipients, and logs status', async () => {
      const txRunner = new MockTransactionRunner();
      const draft = createSampleDraftQuoteRequest();
      let savedRequest: QuoteRequest | null = null;
      let savedLogs: any[] = [];
      let savedRecipients: any[] = [];

      const repo = {
        findById: vi.fn().mockResolvedValue(draft),
        lockById: vi.fn().mockResolvedValue(draft),
        update: vi.fn().mockImplementation(async ({ request, statusLogs }) => {
          savedRequest = request;
          savedLogs = statusLogs ?? [];
          return request;
        }),
      };

      const recipientRepo = {
        createMany: vi.fn().mockImplementation(async (items) => {
          savedRecipients = items;
          return items;
        }),
      };

      const catalog = new MockCatalogContract().givenEligibleWorkshops('1', '10', '2', '5');
      const workshop = new MockWorkshopContract().givenActiveWorkshops('2', '5', '10');

      const useCase = new SendQuoteRequestUseCase(
        txRunner as any,
        repo as any,
        recipientRepo as any,
        catalog,
        workshop,
      );

      const sendTime = new Date('2026-11-15T09:00:00.000Z');
      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
        now: sendTime,
      });

      expect(result.status).toBe('sent_to_artisans');
      expect(result.version).toBe(2);
      expect(repo.findById).toHaveBeenCalledWith('100', expect.anything());
      expect(repo.lockById).toHaveBeenCalledWith('100', expect.anything());
      expect(repo.update).toHaveBeenCalled();
      expect(savedRequest).not.toBeNull();
      expect(savedRequest!.status).toBe('sent_to_artisans');
      expect(savedRequest!.version).toBe(2);

      // Verify status log
      expect(savedLogs).toHaveLength(1);
      expect(savedLogs[0]).toMatchObject({
        request_id: '100',
        event_type: 'sent',
        prev_status: 'draft_request',
        new_status: 'sent_to_artisans',
        performed_by: '10',
      });

      // Verify recipients created for each eligible workshop sorted ascending
      expect(savedRecipients).toHaveLength(3);
      expect(savedRecipients.map((r: any) => r.workshop_id)).toEqual(['2', '5', '10']);
      expect(savedRecipients.every((r: any) => r.request_id === '100')).toBe(true);
      expect(savedRecipients.every((r: any) => r.sent_at === sendTime)).toBe(true);
    });

    it('UT-02 (NO_ELIGIBLE_WORKSHOP edge case 1): throws NoEligibleWorkshopError and keeps draft untouched when catalog returns []', async () => {
      const txRunner = new MockTransactionRunner();
      const draft = createSampleDraftQuoteRequest();

      const repo = {
        findById: vi.fn().mockResolvedValue(draft),
        lockById: vi.fn(),
        update: vi.fn(),
      };

      const recipientRepo = {
        createMany: vi.fn(),
      };

      // Catalog returns empty workshop array
      const catalog = {
        findEligibleWorkshopIds: vi.fn().mockResolvedValue([]),
        assertEligibleWorkshops: vi.fn(),
        getProductImageAccess: vi.fn(),
      };
      const workshop = new MockWorkshopContract();

      const useCase = new SendQuoteRequestUseCase(
        txRunner as any,
        repo as any,
        recipientRepo as any,
        catalog as any,
        workshop,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(NoEligibleWorkshopError);

      expect(repo.findById).toHaveBeenCalledWith('100', expect.anything());
      // Deadlock prevention & fast-fail: lockById, workshop lock, and update must NOT be called
      expect(repo.lockById).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
      expect(recipientRepo.createMany).not.toHaveBeenCalled();
    });

    it('UT-03 (NO_ELIGIBLE_WORKSHOP edge case 2): rolls back and throws NO_ELIGIBLE_WORKSHOP when assert under lock fails', async () => {
      const txRunner = new MockTransactionRunner();
      const draft = createSampleDraftQuoteRequest();

      const repo = {
        findById: vi.fn().mockResolvedValue(draft),
        lockById: vi.fn().mockResolvedValue(draft),
        update: vi.fn(),
      };

      const recipientRepo = {
        createMany: vi.fn(),
      };

      const catalog = {
        findEligibleWorkshopIds: vi.fn().mockResolvedValue(['5']),
        assertEligibleWorkshops: vi
          .fn()
          .mockRejectedValue(new BusinessRuleException('NO_ELIGIBLE_WORKSHOP')),
        getProductImageAccess: vi.fn(),
      };
      const workshop = new MockWorkshopContract().givenActiveWorkshops('5');

      const useCase = new SendQuoteRequestUseCase(
        txRunner as any,
        repo as any,
        recipientRepo as any,
        catalog as any,
        workshop,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(BusinessRuleException);

      expect(catalog.findEligibleWorkshopIds).toHaveBeenCalled();
      expect(repo.lockById).toHaveBeenCalled();
      expect(catalog.assertEligibleWorkshops).toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
      expect(recipientRepo.createMany).not.toHaveBeenCalled();
    });

    it('UT-04 (Deadlock Prevention Order): asserts exact locking order (Catalog find -> Workshop lock ascending -> QuoteRequest lock -> Catalog assert)', async () => {
      const txRunner = new MockTransactionRunner();
      const draft = createSampleDraftQuoteRequest();
      const callSequence: string[] = [];

      const repo = {
        findById: vi.fn().mockImplementation(async () => {
          callSequence.push('repo.findById');
          return draft;
        }),
        lockById: vi.fn().mockImplementation(async () => {
          callSequence.push('repo.lockById');
          return draft;
        }),
        update: vi.fn().mockImplementation(async ({ request }) => {
          callSequence.push('repo.update');
          return request;
        }),
      };

      const recipientRepo = {
        createMany: vi.fn().mockImplementation(async () => {
          callSequence.push('recipientRepo.createMany');
          return [];
        }),
      };

      let lockedWorkshopIdsPassed: readonly string[] = [];
      const workshopContractMock = {
        lockAndAssertActive: vi.fn().mockImplementation(async (ids) => {
          callSequence.push('workshop.lockAndAssertActive');
          lockedWorkshopIdsPassed = ids;
        }),
        getWorkshopSummary: vi.fn(),
        createWorkshop: vi.fn(),
        changeStatus: vi.fn(),
        getProfileImageAccess: vi.fn(),
      };

      const catalogContractMock = {
        findEligibleWorkshopIds: vi.fn().mockImplementation(async () => {
          callSequence.push('catalog.findEligibleWorkshopIds');
          // Return unsorted IDs with potential duplicate
          return ['20', '3', '11', '3'];
        }),
        assertEligibleWorkshops: vi.fn().mockImplementation(async () => {
          callSequence.push('catalog.assertEligibleWorkshops');
        }),
        getProductImageAccess: vi.fn(),
      };

      const useCase = new SendQuoteRequestUseCase(
        txRunner as any,
        repo as any,
        recipientRepo as any,
        catalogContractMock as any,
        workshopContractMock as any,
      );

      await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
      });

      // Verify sequence
      expect(callSequence).toEqual([
        'repo.findById',
        'catalog.findEligibleWorkshopIds',
        'workshop.lockAndAssertActive',
        'repo.lockById',
        'catalog.assertEligibleWorkshops',
        'repo.update',
        'recipientRepo.createMany',
      ]);

      // Verify workshops are deduplicated and sorted numerically ascending
      expect(lockedWorkshopIdsPassed).toEqual(['3', '11', '20']);
    });

    it('UT-05 (Suspended Workshop): throws WorkshopSuspended when workshop lock detects suspended workshop', async () => {
      const txRunner = new MockTransactionRunner();
      const draft = createSampleDraftQuoteRequest();

      const repo = {
        findById: vi.fn().mockResolvedValue(draft),
        lockById: vi.fn(),
        update: vi.fn(),
      };

      const recipientRepo = {
        createMany: vi.fn(),
      };

      const catalog = new MockCatalogContract().givenEligibleWorkshops('1', '2', '5');
      const workshop = new MockWorkshopContract()
        .givenActiveWorkshops('2')
        .givenSuspended('5');

      const useCase = new SendQuoteRequestUseCase(
        txRunner as any,
        repo as any,
        recipientRepo as any,
        catalog,
        workshop,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(WorkshopSuspended);

      expect(repo.lockById).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('UT-06 (Concurrency Conflict): throws ConcurrencyConflictError when expected_request_version mismatches', async () => {
      const txRunner = new MockTransactionRunner();
      const draft = createSampleDraftQuoteRequest({ version: 2 });

      const repo = {
        findById: vi.fn().mockResolvedValue(draft),
        lockById: vi.fn().mockResolvedValue(draft),
        update: vi.fn(),
      };

      const recipientRepo = {
        createMany: vi.fn(),
      };

      const catalog = new MockCatalogContract().givenEligibleWorkshops('1', '5');
      const workshop = new MockWorkshopContract().givenActiveWorkshops('5');

      const useCase = new SendQuoteRequestUseCase(
        txRunner as any,
        repo as any,
        recipientRepo as any,
        catalog,
        workshop,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1, // Mismatch (draft is version 2)
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      expect(repo.update).not.toHaveBeenCalled();
    });

    it('UT-07 (Invalid State): throws InvalidStateTransitionError when QuoteRequest is already sent or cancelled', async () => {
      const txRunner = new MockTransactionRunner();
      const catalog = new MockCatalogContract().givenEligibleWorkshops('1', '5');
      const workshop = new MockWorkshopContract().givenActiveWorkshops('5');

      // Case A: already sent_to_artisans
      const alreadySent = createSampleDraftQuoteRequest({
        status: 'sent_to_artisans',
      });
      const repoA = {
        findById: vi.fn().mockResolvedValue(alreadySent),
        lockById: vi.fn().mockResolvedValue(alreadySent),
        update: vi.fn(),
      };
      const useCaseA = new SendQuoteRequestUseCase(
        txRunner as any,
        repoA as any,
        { createMany: vi.fn() } as any,
        catalog,
        workshop,
      );
      await expect(
        useCaseA.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      // Case B: cancelled
      const cancelled = createSampleDraftQuoteRequest({
        status: 'artisans_bidding',
        cancelled_at: new Date('2026-11-12T10:00:00.000Z'),
        cancelled_by: '10',
        cancel_reason: 'Cancelled request',
      });
      const repoB = {
        findById: vi.fn().mockResolvedValue(cancelled),
        lockById: vi.fn().mockResolvedValue(cancelled),
        update: vi.fn(),
      };
      const useCaseB = new SendQuoteRequestUseCase(
        txRunner as any,
        repoB as any,
        { createMany: vi.fn() } as any,
        catalog,
        workshop,
      );
      await expect(
        useCaseB.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('UT-08 (Missing Required Commercial Fields): throws InvalidTradingInputError when commercial fields are incomplete', async () => {
      const txRunner = new MockTransactionRunner();
      const catalog = new MockCatalogContract().givenEligibleWorkshops('1', '5');
      const workshop = new MockWorkshopContract().givenActiveWorkshops('5');

      // Test missing spec
      const missingSpec = createSampleDraftQuoteRequest({ spec: '   ' });
      const repo1 = {
        findById: vi.fn().mockResolvedValue(missingSpec),
        lockById: vi.fn().mockResolvedValue(missingSpec),
        update: vi.fn(),
      };
      const useCase1 = new SendQuoteRequestUseCase(
        txRunner as any,
        repo1 as any,
        { createMany: vi.fn() } as any,
        catalog,
        workshop,
      );
      await expect(
        useCase1.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      // Test missing quantity
      const missingQuantity = createSampleDraftQuoteRequest({ quantity: null });
      const repo2 = {
        findById: vi.fn().mockResolvedValue(missingQuantity),
        lockById: vi.fn().mockResolvedValue(missingQuantity),
        update: vi.fn(),
      };
      const useCase2 = new SendQuoteRequestUseCase(
        txRunner as any,
        repo2 as any,
        { createMany: vi.fn() } as any,
        catalog,
        workshop,
      );
      await expect(
        useCase2.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      // Test unit = 'set' without unit_set_description
      const missingSetDesc = createSampleDraftQuoteRequest({
        unit: 'set',
        unit_set_description: null,
      });
      const repo3 = {
        findById: vi.fn().mockResolvedValue(missingSetDesc),
        lockById: vi.fn().mockResolvedValue(missingSetDesc),
        update: vi.fn(),
      };
      const useCase3 = new SendQuoteRequestUseCase(
        txRunner as any,
        repo3 as any,
        { createMany: vi.fn() } as any,
        catalog,
        workshop,
      );
      await expect(
        useCase3.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      // Test delivery_mode = 'at_buyer_address' without delivery_address
      const missingAddress = createSampleDraftQuoteRequest({
        delivery_mode: 'at_buyer_address',
        delivery_address: '  ',
      });
      const repo4 = {
        findById: vi.fn().mockResolvedValue(missingAddress),
        lockById: vi.fn().mockResolvedValue(missingAddress),
        update: vi.fn(),
      };
      const useCase4 = new SendQuoteRequestUseCase(
        txRunner as any,
        repo4 as any,
        { createMany: vi.fn() } as any,
        catalog,
        workshop,
      );
      await expect(
        useCase4.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      // Test missing category_id
      const missingCat = createSampleDraftQuoteRequest({ category_id: null });
      const repo5 = {
        findById: vi.fn().mockResolvedValue(missingCat),
        lockById: vi.fn().mockResolvedValue(missingCat),
        update: vi.fn(),
      };
      const useCase5 = new SendQuoteRequestUseCase(
        txRunner as any,
        repo5 as any,
        { createMany: vi.fn() } as any,
        catalog,
        workshop,
      );
      await expect(
        useCase5.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('UT-09 (Deadline Violation): throws DeadlineViolationError when deadlines violate BR-12 (past or < 24h gap)', async () => {
      const txRunner = new MockTransactionRunner();
      const catalog = new MockCatalogContract().givenEligibleWorkshops('1', '5');
      const workshop = new MockWorkshopContract().givenActiveWorkshops('5');

      const now = new Date('2026-11-15T10:00:00.000Z');

      // Case A: bidding_deadline in the past
      const pastBidding = createSampleDraftQuoteRequest({
        bidding_deadline: new Date('2026-11-14T10:00:00.000Z'),
        delivery_deadline: new Date('2026-11-20T10:00:00.000Z'),
      });
      const repoA = {
        findById: vi.fn().mockResolvedValue(pastBidding),
        lockById: vi.fn().mockResolvedValue(pastBidding),
        update: vi.fn(),
      };
      const useCaseA = new SendQuoteRequestUseCase(
        txRunner as any,
        repoA as any,
        { createMany: vi.fn() } as any,
        catalog,
        workshop,
      );
      await expect(
        useCaseA.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          now,
        }),
      ).rejects.toThrow(DeadlineViolationError);

      // Case B: delivery_deadline <= bidding_deadline + 24 hours (gap only 12 hours)
      const shortGap = createSampleDraftQuoteRequest({
        bidding_deadline: new Date('2026-11-20T10:00:00.000Z'),
        delivery_deadline: new Date('2026-11-20T22:00:00.000Z'), // 12h later
      });
      const repoB = {
        findById: vi.fn().mockResolvedValue(shortGap),
        lockById: vi.fn().mockResolvedValue(shortGap),
        update: vi.fn(),
      };
      const useCaseB = new SendQuoteRequestUseCase(
        txRunner as any,
        repoB as any,
        { createMany: vi.fn() } as any,
        catalog,
        workshop,
      );
      await expect(
        useCaseB.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          now,
        }),
      ).rejects.toThrow(DeadlineViolationError);
    });

    it('UT-10 (Permission & Ownership): throws TradingPermissionDeniedError for wrong role or non-owner', async () => {
      const txRunner = new MockTransactionRunner();
      const draft = createSampleDraftQuoteRequest({ buyer_id: '10' });

      const repo = {
        findById: vi.fn().mockResolvedValue(draft),
        lockById: vi.fn().mockResolvedValue(draft),
        update: vi.fn(),
      };

      const useCase = new SendQuoteRequestUseCase(
        txRunner as any,
        repo as any,
        { createMany: vi.fn() } as any,
        new MockCatalogContract().givenEligibleWorkshops('1', '5'),
        new MockWorkshopContract().givenActiveWorkshops('5'),
      );

      // Artisan role rejected
      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      // Admin role rejected
      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      // Non-owner Buyer rejected
      await expect(
        useCase.execute({
          actor: otherBuyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('UT-11 (SendRequestWorkflow direct execution): executes directly via SendRequestWorkflow matching use case', async () => {
      const txRunner = new MockTransactionRunner();
      const draft = createSampleDraftQuoteRequest();

      const repo = {
        findById: vi.fn().mockResolvedValue(draft),
        lockById: vi.fn().mockResolvedValue(draft),
        update: vi.fn().mockImplementation(async ({ request }) => request),
      };

      const recipientRepo = {
        createMany: vi.fn().mockImplementation(async (items) => items),
      };

      const catalog = new MockCatalogContract().givenEligibleWorkshops('1', '42');
      const workshop = new MockWorkshopContract().givenActiveWorkshops('42');

      const workflow = new SendRequestWorkflow(
        txRunner as any,
        repo as any,
        recipientRepo as any,
        catalog,
        workshop,
      );

      const result = await workflow.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
      });

      expect(result.status).toBe('sent_to_artisans');
      expect(result.version).toBe(2);
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

    it('HTTP-01: POST /buyer/quote-requests/:id/send succeeds with 200 OK and enveloped response for Buyer', async () => {
      currentQuoteRequest = createSampleDraftQuoteRequest({ id: '100', version: 1 });
      catalogMock.givenEligibleWorkshops('1', '2', '5');
      workshopMock.givenActiveWorkshops('2', '5');
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/send`, {
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
      });
      expect(lastSavedStatusLogs).toHaveLength(1);
      expect(lastSavedStatusLogs[0].event_type).toBe('sent');
      expect(lastCreatedRecipients).toHaveLength(2);
    });

    it('HTTP-02: rejects unauthorized request with 401 Authentication Required', async () => {
      const res = await fetch(`${base}/buyer/quote-requests/100/send`, {
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

      const res = await fetch(`${base}/buyer/quote-requests/100/send`, {
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
      currentQuoteRequest = createSampleDraftQuoteRequest({ id: '100', buyer_id: '10' });
      identityMock.resolveSession.mockResolvedValueOnce(otherBuyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-other-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 1,
        }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('HTTP-05: returns 422 NO_ELIGIBLE_WORKSHOP when no active workshops match category', async () => {
      currentQuoteRequest = createSampleDraftQuoteRequest({ id: '100', version: 1, category_id: '99' });
      catalogMock.givenEligibleWorkshops('99'); // empty workshop list
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/send`, {
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
      expect(json.code).toBe('NO_ELIGIBLE_WORKSHOP');
    });

    it('HTTP-06: returns 409 CONCURRENCY_CONFLICT when expected_request_version does not match', async () => {
      currentQuoteRequest = createSampleDraftQuoteRequest({ id: '100', version: 1 });
      catalogMock.givenEligibleWorkshops('1', '2');
      workshopMock.givenActiveWorkshops('2');
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({
          expected_request_version: 99, // Mismatched
        }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe('CONCURRENCY_CONFLICT');
    });

    it('HTTP-07: returns 400 INVALID_INPUT when expected_request_version is invalid (negative or non-integer)', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/100/send`, {
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
  });
});
