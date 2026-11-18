import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { TransactionContext } from '../../../../src/common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
} from '../../../../src/common/application/types/contract-types';
import {
  TRADING_CONTRACT,
  type ITradingContract,
} from '../../../../src/modules/trading/public/contracts/trading.contract';
import { TradingAcceptanceService } from '../../../../src/modules/trading/application/services/trading-acceptance.service';
import { TradingModule } from '../../../../src/modules/trading/trading.module';
import {
  Allocation,
  ConcurrencyConflictError,
  InsufficientCapacityError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  Quote,
  QuoteExpiredError,
  QuoteRequest,
  QuoteRequestNotFoundError,
  RequestRecipient,
  TradingDomainError,
  TradingPermissionDeniedError,
  TradingResourceNotFoundError,
  WorkshopSuspendedError,
} from '../../../../src/modules/trading/domain';
import type {
  CreateIdempotencyRecordInput,
  IdempotencyScopeKey,
  PersistedIdempotencyRecord,
} from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';
import type {
  IAllocationRepository,
  IIdempotencyRecordRepository,
  IQuoteRepository,
  IQuoteRequestRepository,
  IRequestRecipientRepository,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { PrismaService } from '../../../../src/infrastructure/database/prisma/prisma.service';
import { MockTradingContract } from '../../../support/mocks/trading.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import { MockWorkshopContract } from '../../../support/mocks/workshop.mock';
import { tradingContractSuite } from '../../../contracts/trading.contract-suite';

const SENT_AT = new Date('2026-11-10T08:00:00.000Z');
const NOW = new Date('2026-11-15T10:00:00.000Z');
const BIDDING_DEADLINE = new Date('2026-11-20T10:00:00.000Z');
const BID_ACCEPT_DEADLINE = new Date('2026-11-25T10:00:00.000Z');
const COMMITTED_DELIVERY = new Date('2026-11-28T10:00:00.000Z');
const DELIVERY_DEADLINE = new Date('2026-11-30T10:00:00.000Z');

const VALID_IDEMPOTENCY_KEY = '11111111-2222-4333-8444-555555555555';

const buyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-buyer',
  sessionLevel: 'normal',
});

const artisanActor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '301',
  authVersion: 1,
  sessionId: 'sess-artisan',
  sessionLevel: 'normal',
});

const adminActor: AuthenticatedActor = Object.freeze({
  accountId: '30',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-admin',
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

describe('Task 25: Public Contract ITradingContract & TradingAcceptanceService', () => {
  describe('1. NestJS DI Token Resolution & Module Exports', () => {
    it('TRADING_CONTRACT resolves to TradingAcceptanceService in TradingModule context', async () => {
      vi.spyOn(PrismaService.prototype, '$connect').mockResolvedValue(undefined);
      vi.spyOn(PrismaService.prototype, '$disconnect').mockResolvedValue(undefined);
      vi.spyOn(PrismaService.prototype, '$queryRaw' as any).mockResolvedValue([
        { '?column?': 1 },
      ]);

      const app = await NestFactory.createApplicationContext(TradingModule, {
        logger: false,
      });
      try {
        const contract = app.get<ITradingContract>(TRADING_CONTRACT);
        expect(contract).toBeDefined();
        expect(contract).toBeInstanceOf(TradingAcceptanceService);

        const concreteService = app.get(TradingAcceptanceService);
        expect(concreteService).toBe(contract);
      } finally {
        await app.close();
      }
    });

    it('TradingModule.register(MockTradingContract) binds TRADING_CONTRACT to custom mock', async () => {
      vi.spyOn(PrismaService.prototype, '$connect').mockResolvedValue(undefined);
      vi.spyOn(PrismaService.prototype, '$disconnect').mockResolvedValue(undefined);
      vi.spyOn(PrismaService.prototype, '$queryRaw' as any).mockResolvedValue([
        { '?column?': 1 },
      ]);

      const dynamicModule = TradingModule.register(MockTradingContract);
      @Module({
        imports: [dynamicModule],
      })
      class DynamicHostModule {}

      const app = await NestFactory.createApplicationContext(DynamicHostModule, {
        logger: false,
      });
      try {
        const contract = app.get<ITradingContract>(TRADING_CONTRACT);
        expect(contract).toBeDefined();
        expect(contract).toBeInstanceOf(MockTradingContract);
      } finally {
        await app.close();
      }
    });
  });

  describe('2. ITradingContract.prepareAcceptance Specifications', () => {
    it('discovers participating workshopIds without locking or mutating state', async () => {
      const request = createSampleRequest();
      const quote = createSampleQuote();
      const workshopContract = new MockWorkshopContract().givenActiveWorkshops('301');

      const mockQuoteRequestRepo = {
        findById: vi.fn().mockResolvedValue(request),
        lockById: vi.fn(),
      } as unknown as IQuoteRequestRepository;

      const mockQuoteRepo = {
        findById: vi.fn().mockResolvedValue(quote),
        lockById: vi.fn(),
      } as unknown as IQuoteRepository;

      const service = new TradingAcceptanceService(
        mockQuoteRequestRepo,
        {} as IRequestRecipientRepository,
        mockQuoteRepo,
        {} as IAllocationRepository,
        {} as IIdempotencyRecordRepository,
        workshopContract,
      );

      const dummyTx = {} as TransactionContext;
      const result = await service.prepareAcceptance(
        {
          requestId: '1001',
          expectedRequestVersion: 3,
          quoteId: '401',
          expectedQuoteVersion: 2,
          actor: buyerActor,
        },
        dummyTx,
      );

      expect(result).toEqual({ workshopIds: ['301'] });
      expect(mockQuoteRequestRepo.findById).toHaveBeenCalledWith('1001', dummyTx);
      expect(mockQuoteRepo.findById).toHaveBeenCalledWith('401', dummyTx);
      expect(mockQuoteRequestRepo.lockById).not.toHaveBeenCalled();
      expect(mockQuoteRepo.lockById).not.toHaveBeenCalled();
    });

    it('rejects non-buyer roles (artisan, admin) with PERMISSION_DENIED', async () => {
      const service = new TradingAcceptanceService(
        {} as IQuoteRequestRepository,
        {} as IRequestRecipientRepository,
        {} as IQuoteRepository,
        {} as IAllocationRepository,
        {} as IIdempotencyRecordRepository,
        new MockWorkshopContract(),
      );

      const dummyTx = {} as TransactionContext;
      for (const actor of [artisanActor, adminActor]) {
        await expect(
          service.prepareAcceptance(
            {
              requestId: '1001',
              expectedRequestVersion: 3,
              quoteId: '401',
              expectedQuoteVersion: 2,
              actor,
            },
            dummyTx,
          ),
        ).rejects.toThrow(TradingPermissionDeniedError);
      }
    });

    it('rejects temp_password sessions with TEMP_PASSWORD_RESTRICTED', async () => {
      const service = new TradingAcceptanceService(
        {} as IQuoteRequestRepository,
        {} as IRequestRecipientRepository,
        {} as IQuoteRepository,
        {} as IAllocationRepository,
        {} as IIdempotencyRecordRepository,
        new MockWorkshopContract(),
      );

      const dummyTx = {} as TransactionContext;
      await expect(
        service.prepareAcceptance(
          {
            requestId: '1001',
            expectedRequestVersion: 3,
            quoteId: '401',
            expectedQuoteVersion: 2,
            actor: tempPasswordBuyerActor,
          },
          dummyTx,
        ),
      ).rejects.toThrow(TradingDomainError);
    });

    it('throws QuoteRequestNotFoundError when request is missing or belongs to another buyer', async () => {
      const mockQuoteRequestRepo = {
        findById: vi.fn().mockResolvedValue(null),
      } as unknown as IQuoteRequestRepository;

      const service = new TradingAcceptanceService(
        mockQuoteRequestRepo,
        {} as IRequestRecipientRepository,
        {} as IQuoteRepository,
        {} as IAllocationRepository,
        {} as IIdempotencyRecordRepository,
        new MockWorkshopContract(),
      );

      const dummyTx = {} as TransactionContext;
      await expect(
        service.prepareAcceptance(
          {
            requestId: '9999',
            expectedRequestVersion: 1,
            quoteId: '401',
            expectedQuoteVersion: 1,
            actor: buyerActor,
          },
          dummyTx,
        ),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      const foreignRequest = createSampleRequest({ buyer_id: '99' });
      vi.mocked(mockQuoteRequestRepo.findById).mockResolvedValue(foreignRequest);
      await expect(
        service.prepareAcceptance(
          {
            requestId: '1001',
            expectedRequestVersion: 3,
            quoteId: '401',
            expectedQuoteVersion: 1,
            actor: buyerActor,
          },
          dummyTx,
        ),
      ).rejects.toThrow(QuoteRequestNotFoundError);
    });

    it('throws TradingResourceNotFoundError when quote is missing or belongs to different request', async () => {
      const request = createSampleRequest();
      const mockQuoteRequestRepo = {
        findById: vi.fn().mockResolvedValue(request),
      } as unknown as IQuoteRequestRepository;

      const mockQuoteRepo = {
        findById: vi.fn().mockResolvedValue(null),
      } as unknown as IQuoteRepository;

      const service = new TradingAcceptanceService(
        mockQuoteRequestRepo,
        {} as IRequestRecipientRepository,
        mockQuoteRepo,
        {} as IAllocationRepository,
        {} as IIdempotencyRecordRepository,
        new MockWorkshopContract(),
      );

      const dummyTx = {} as TransactionContext;
      await expect(
        service.prepareAcceptance(
          {
            requestId: '1001',
            expectedRequestVersion: 3,
            quoteId: '999',
            expectedQuoteVersion: 1,
            actor: buyerActor,
          },
          dummyTx,
        ),
      ).rejects.toThrow(TradingResourceNotFoundError);

      const foreignQuote = createSampleQuote({ request_id: '8888' });
      vi.mocked(mockQuoteRepo.findById).mockResolvedValue(foreignQuote);
      await expect(
        service.prepareAcceptance(
          {
            requestId: '1001',
            expectedRequestVersion: 3,
            quoteId: '401',
            expectedQuoteVersion: 1,
            actor: buyerActor,
          },
          dummyTx,
        ),
      ).rejects.toThrow(TradingResourceNotFoundError);
    });

    it('fails closed when workshopContract is omitted', async () => {
      const service = new TradingAcceptanceService(
        {} as IQuoteRequestRepository,
        {} as IRequestRecipientRepository,
        {} as IQuoteRepository,
        {} as IAllocationRepository,
        {} as IIdempotencyRecordRepository,
        undefined,
      );

      const dummyTx = {} as TransactionContext;
      await expect(
        service.prepareAcceptance(
          {
            requestId: '1001',
            expectedRequestVersion: 3,
            quoteId: '401',
            expectedQuoteVersion: 2,
            actor: buyerActor,
          },
          dummyTx,
        ),
      ).rejects.toThrow('Workshop contract is required for trading acceptance.');
    });
  });

  describe('3. ITradingContract.findAcceptanceReplay Specifications', () => {
    it('returns null when no idempotency record exists in database', async () => {
      const request = createSampleRequest();
      const mockQuoteRequestRepo = {
        findById: vi.fn().mockResolvedValue(request),
      } as unknown as IQuoteRequestRepository;

      const mockIdempotencyRepo = {
        findByScope: vi.fn().mockResolvedValue(null),
      } as unknown as IIdempotencyRecordRepository;

      const service = new TradingAcceptanceService(
        mockQuoteRequestRepo,
        {} as IRequestRecipientRepository,
        {} as IQuoteRepository,
        {} as IAllocationRepository,
        mockIdempotencyRepo,
        new MockWorkshopContract(),
      );

      const dummyTx = {} as TransactionContext;
      const replay = await service.findAcceptanceReplay(
        {
          requestId: '1001',
          expectedRequestVersion: 3,
          quoteId: '401',
          expectedQuoteVersion: 2,
          actor: buyerActor,
          idempotencyKey: VALID_IDEMPOTENCY_KEY,
        },
        dummyTx,
      );

      expect(replay).toBeNull();
    });

    it('returns cached result and operation metadata with replayed: true when payload fingerprint matches', async () => {
      const request = createSampleRequest();
      const quote = createSampleQuote();
      const mockQuoteRequestRepo = {
        findById: vi.fn().mockResolvedValue(request),
      } as unknown as IQuoteRequestRepository;
      const mockQuoteRepo = {
        findById: vi.fn().mockResolvedValue(quote),
      } as unknown as IQuoteRepository;

      const { computeCanonicalFingerprint } = await import(
        '../../../../src/modules/trading/domain/utilities'
      );
      const existingRecord: PersistedIdempotencyRecord<unknown> = {
        id: '9001',
        idempotency_key: VALID_IDEMPOTENCY_KEY,
        request_fingerprint: computeCanonicalFingerprint({
          quote_id: '401',
          expected_request_version: 3,
          expected_quote_version: 2,
        }),
        account_id: '10',
        action: 'accept_quote',
        object_type: 'QuoteRequest',
        object_id: '1001',
        result_snapshot: {
          request_id: '1001',
          request_status: 'buyer_accepted',
          request_version: 4,
          allocations: [],
        },
        created_at: NOW,
        expires_at: new Date(NOW.getTime() + 86400000),
      };

      const mockIdempotencyRepo = {
        findByScope: vi.fn().mockResolvedValue(existingRecord),
      } as unknown as IIdempotencyRecordRepository;

      const service = new TradingAcceptanceService(
        mockQuoteRequestRepo,
        {} as IRequestRecipientRepository,
        mockQuoteRepo,
        {} as IAllocationRepository,
        mockIdempotencyRepo,
        new MockWorkshopContract(),
      );

      const dummyTx = {} as TransactionContext;
      const replay = await service.findAcceptanceReplay(
        {
          requestId: '1001',
          expectedRequestVersion: 3,
          quoteId: '401',
          expectedQuoteVersion: 2,
          actor: buyerActor,
          idempotencyKey: VALID_IDEMPOTENCY_KEY,
        },
        dummyTx,
      );

      expect(replay).not.toBeNull();
      expect(replay!.operation.replayed).toBe(true);
      expect(replay!.operation.id).toBe('9001');
      expect(replay!.data).toEqual(existingRecord.result_snapshot);
      expect(replay!.operation.current_state.request.status).toBe('artisans_bidding');
    });

    it('rejects with IDEMPOTENCY_CONFLICT when same key is used with differing payload', async () => {
      const request = createSampleRequest();
      const mockQuoteRequestRepo = {
        findById: vi.fn().mockResolvedValue(request),
      } as unknown as IQuoteRequestRepository;

      const { computeCanonicalFingerprint } = await import(
        '../../../../src/modules/trading/domain/utilities'
      );
      const existingRecord: PersistedIdempotencyRecord<unknown> = {
        id: '9001',
        idempotency_key: VALID_IDEMPOTENCY_KEY,
        request_fingerprint: computeCanonicalFingerprint({
          quote_id: '401',
          expected_request_version: 3,
          expected_quote_version: 2,
        }),
        account_id: '10',
        action: 'accept_quote',
        object_type: 'QuoteRequest',
        object_id: '1001',
        result_snapshot: {},
        created_at: NOW,
        expires_at: new Date(NOW.getTime() + 86400000),
      };

      const mockIdempotencyRepo = {
        findByScope: vi.fn().mockResolvedValue(existingRecord),
      } as unknown as IIdempotencyRecordRepository;

      const service = new TradingAcceptanceService(
        mockQuoteRequestRepo,
        {} as IRequestRecipientRepository,
        {} as IQuoteRepository,
        {} as IAllocationRepository,
        mockIdempotencyRepo,
        new MockWorkshopContract(),
      );

      const dummyTx = {} as TransactionContext;
      // Different quoteId '402'
      await expect(
        service.findAcceptanceReplay(
          {
            requestId: '1001',
            expectedRequestVersion: 3,
            quoteId: '402',
            expectedQuoteVersion: 2,
            actor: buyerActor,
            idempotencyKey: VALID_IDEMPOTENCY_KEY,
          },
          dummyTx,
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });

    it('rejects invalid non-UUID v4 idempotency keys with INVALID_INPUT', async () => {
      const service = new TradingAcceptanceService(
        {} as IQuoteRequestRepository,
        {} as IRequestRecipientRepository,
        {} as IQuoteRepository,
        {} as IAllocationRepository,
        {} as IIdempotencyRecordRepository,
        new MockWorkshopContract(),
      );

      const dummyTx = {} as TransactionContext;
      for (const badKey of ['', 'not-a-uuid', '12345', '11111111-2222-1333-8444-555555555555']) {
        await expect(
          service.findAcceptanceReplay(
            {
              requestId: '1001',
              expectedRequestVersion: 3,
              quoteId: '401',
              expectedQuoteVersion: 2,
              actor: buyerActor,
              idempotencyKey: badKey,
            },
            dummyTx,
          ),
        ).rejects.toThrow(InvalidTradingInputError);
      }
    });
  });

  describe('4. ITradingContract.accept Specifications (Atomic Execution & Invariants)', () => {
    it('executes full atomic acceptance, creates Allocation, updates Quote & Request, writes logs & IdempotencyRecord', async () => {
      const request = createSampleRequest();
      const recipient = createSampleRecipient();
      const quote = createSampleQuote();

      const workshopContract = new MockWorkshopContract().givenActiveWorkshops('301');
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Bát Tràng Hưng Thịnh',
        status: 'active',
        isProfilePublic: true,
      });

      let savedQuote: Quote | null = null;
      let savedRequest: QuoteRequest | null = null;
      let savedAllocation: Allocation | null = null;
      let savedIdempotency: PersistedIdempotencyRecord<unknown> | null = null;

      const mockQuoteRequestRepo = {
        lockById: vi.fn().mockResolvedValue(request),
        update: vi.fn().mockImplementation(async ({ request: updated }) => {
          savedRequest = updated;
          return updated;
        }),
      } as unknown as IQuoteRequestRepository;

      const mockRecipientRepo = {
        lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
      } as unknown as IRequestRecipientRepository;

      const mockQuoteRepo = {
        lockById: vi.fn().mockResolvedValue(quote),
        update: vi.fn().mockImplementation(async ({ quote: updated }) => {
          savedQuote = updated;
          return updated;
        }),
      } as unknown as IQuoteRepository;

      const mockAllocationRepo = {
        create: vi.fn().mockImplementation(async ({ allocation }) => {
          savedAllocation = Allocation.reconstitute({
            ...allocation,
            id: '7001',
          });
          return savedAllocation;
        }),
      } as unknown as IAllocationRepository;

      const mockIdempotencyRepo = {
        save: vi.fn().mockImplementation(async (input: CreateIdempotencyRecordInput<unknown>) => {
          savedIdempotency = {
            id: '9001',
            ...input,
          };
          return savedIdempotency;
        }),
      } as unknown as IIdempotencyRecordRepository;

      const service = new TradingAcceptanceService(
        mockQuoteRequestRepo,
        mockRecipientRepo,
        mockQuoteRepo,
        mockAllocationRepo,
        mockIdempotencyRepo,
        workshopContract,
      );

      const dummyTx = {} as TransactionContext;
      const result = await service.accept(
        {
          requestId: '1001',
          expectedRequestVersion: 3,
          quoteId: '401',
          expectedQuoteVersion: 2,
          actor: buyerActor,
          idempotencyKey: VALID_IDEMPOTENCY_KEY,
        },
        dummyTx,
        {
          expectedWorkshopId: '301',
          now: NOW,
        },
      );

      // Verify return envelope
      expect(result.data.request_id).toBe('1001');
      expect(result.data.request_status).toBe('buyer_accepted');
      expect(result.data.request_version).toBe(4);
      expect(result.data.allocations.length).toBe(1);
      expect(result.data.allocations[0].id).toBe('7001');
      expect(result.data.allocations[0].status).toBe('not_started');
      expect(result.data.allocations[0].quantity).toBe(5000);
      expect(result.data.allocations[0].unit_price).toBe(45000);
      expect(result.data.allocations[0].workshop.id).toBe('301');
      expect(result.data.allocations[0].workshop.name).toBe('Xưởng Gốm Bát Tràng Hưng Thịnh');

      expect(result.operation.replayed).toBe(false);
      expect(result.operation.id).toBe('9001');
      expect(result.operation.current_state.request.status).toBe('buyer_accepted');
      expect(result.operation.current_state.quote?.status).toBe('accepted');

      // Verify repository mutations
      expect(savedRequest).not.toBeNull();
      expect(savedRequest!.status).toBe('buyer_accepted');
      expect(savedRequest!.version).toBe(4);
      expect(savedRequest!.bidding_closed_at).toEqual(NOW);

      expect(savedQuote).not.toBeNull();
      expect(savedQuote!.status).toBe('accepted');
      expect(savedQuote!.version).toBe(3);

      expect(savedAllocation).not.toBeNull();
      expect(savedAllocation!.status).toBe('not_started');
      expect(savedAllocation!.version).toBe(1);

      expect(savedIdempotency).not.toBeNull();
      expect(savedIdempotency!.idempotency_key).toBe(VALID_IDEMPOTENCY_KEY);
      expect(savedIdempotency!.expires_at.getTime() - savedIdempotency!.created_at.getTime()).toBe(
        24 * 60 * 60 * 1000,
      );
    });

    it('rejects when workshop is suspended with WORKSHOP_SUSPENDED', async () => {
      const request = createSampleRequest();
      const recipient = createSampleRecipient();
      const quote = createSampleQuote();

      const workshopContract = new MockWorkshopContract();
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Bát Tràng',
        status: 'suspended',
        isProfilePublic: false,
      });

      const service = new TradingAcceptanceService(
        { lockById: vi.fn().mockResolvedValue(request) } as unknown as IQuoteRequestRepository,
        { lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient) } as unknown as IRequestRecipientRepository,
        { lockById: vi.fn().mockResolvedValue(quote) } as unknown as IQuoteRepository,
        {} as IAllocationRepository,
        {} as IIdempotencyRecordRepository,
        workshopContract,
      );

      const dummyTx = {} as TransactionContext;
      await expect(
        service.accept(
          {
            requestId: '1001',
            expectedRequestVersion: 3,
            quoteId: '401',
            expectedQuoteVersion: 2,
            actor: buyerActor,
            idempotencyKey: VALID_IDEMPOTENCY_KEY,
          },
          dummyTx,
          { expectedWorkshopId: '301', now: NOW },
        ),
      ).rejects.toThrow(WorkshopSuspendedError);
    });

    it('rejects when Quote acceptance deadline has passed with QUOTE_EXPIRED', async () => {
      const request = createSampleRequest();
      const recipient = createSampleRecipient();
      const expiredQuote = createSampleQuote({
        bid_accept_deadline: new Date(NOW.getTime() - 1000), // expired 1s ago
      });

      const workshopContract = new MockWorkshopContract();
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Bát Tràng',
        status: 'active',
        isProfilePublic: true,
      });

      const service = new TradingAcceptanceService(
        { lockById: vi.fn().mockResolvedValue(request) } as unknown as IQuoteRequestRepository,
        { lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient) } as unknown as IRequestRecipientRepository,
        { lockById: vi.fn().mockResolvedValue(expiredQuote) } as unknown as IQuoteRepository,
        {} as IAllocationRepository,
        {} as IIdempotencyRecordRepository,
        workshopContract,
      );

      const dummyTx = {} as TransactionContext;
      await expect(
        service.accept(
          {
            requestId: '1001',
            expectedRequestVersion: 3,
            quoteId: '401',
            expectedQuoteVersion: 2,
            actor: buyerActor,
            idempotencyKey: VALID_IDEMPOTENCY_KEY,
          },
          dummyTx,
          { expectedWorkshopId: '301', now: NOW },
        ),
      ).rejects.toThrow(QuoteExpiredError);
    });

    it('rejects when Quote cannot satisfy 100% request quantity with INSUFFICIENT_CAPACITY', async () => {
      const request = createSampleRequest({ quantity: 5000 }); // requires 5000
      const recipient = createSampleRecipient();
      const partialQuote = createSampleQuote({ max_quantity: 3000 }); // only 3000

      const workshopContract = new MockWorkshopContract();
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Bát Tràng',
        status: 'active',
        isProfilePublic: true,
      });

      const service = new TradingAcceptanceService(
        { lockById: vi.fn().mockResolvedValue(request) } as unknown as IQuoteRequestRepository,
        { lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient) } as unknown as IRequestRecipientRepository,
        { lockById: vi.fn().mockResolvedValue(partialQuote) } as unknown as IQuoteRepository,
        {} as IAllocationRepository,
        {} as IIdempotencyRecordRepository,
        workshopContract,
      );

      const dummyTx = {} as TransactionContext;
      await expect(
        service.accept(
          {
            requestId: '1001',
            expectedRequestVersion: 3,
            quoteId: '401',
            expectedQuoteVersion: 2,
            actor: buyerActor,
            idempotencyKey: VALID_IDEMPOTENCY_KEY,
          },
          dummyTx,
          { expectedWorkshopId: '301', now: NOW },
        ),
      ).rejects.toThrow(InsufficientCapacityError);
    });

    it('rejects optimistic version mismatch on request or quote with CONCURRENCY_CONFLICT', async () => {
      const request = createSampleRequest({ version: 3 });
      const recipient = createSampleRecipient();
      const quote = createSampleQuote({ version: 2 });

      const workshopContract = new MockWorkshopContract();
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm',
        status: 'active',
        isProfilePublic: true,
      });

      const service = new TradingAcceptanceService(
        { lockById: vi.fn().mockResolvedValue(request) } as unknown as IQuoteRequestRepository,
        { lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient) } as unknown as IRequestRecipientRepository,
        { lockById: vi.fn().mockResolvedValue(quote) } as unknown as IQuoteRepository,
        {} as IAllocationRepository,
        {} as IIdempotencyRecordRepository,
        workshopContract,
      );

      const dummyTx = {} as TransactionContext;

      // 1. Mismatched request version (client expects 2, server is 3)
      await expect(
        service.accept(
          {
            requestId: '1001',
            expectedRequestVersion: 2,
            quoteId: '401',
            expectedQuoteVersion: 2,
            actor: buyerActor,
            idempotencyKey: VALID_IDEMPOTENCY_KEY,
          },
          dummyTx,
          { expectedWorkshopId: '301', now: NOW },
        ),
      ).rejects.toThrow(ConcurrencyConflictError);

      // 2. Mismatched quote version (client expects 1, server is 2)
      await expect(
        service.accept(
          {
            requestId: '1001',
            expectedRequestVersion: 3,
            quoteId: '401',
            expectedQuoteVersion: 1,
            actor: buyerActor,
            idempotencyKey: VALID_IDEMPOTENCY_KEY,
          },
          dummyTx,
          { expectedWorkshopId: '301', now: NOW },
        ),
      ).rejects.toThrow(ConcurrencyConflictError);
    });

    it('rejects when request is cancelled with INVALID_STATE', async () => {
      const cancelledRequest = createSampleRequest({
        cancelled_at: NOW,
        cancelled_by: '10',
        cancel_reason: 'Buyer cancelled',
        status: 'artisans_bidding',
      });
      const recipient = createSampleRecipient();
      const quote = createSampleQuote();

      const service = new TradingAcceptanceService(
        { lockById: vi.fn().mockResolvedValue(cancelledRequest) } as unknown as IQuoteRequestRepository,
        { lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient) } as unknown as IRequestRecipientRepository,
        { lockById: vi.fn().mockResolvedValue(quote) } as unknown as IQuoteRepository,
        {} as IAllocationRepository,
        {} as IIdempotencyRecordRepository,
        new MockWorkshopContract(),
      );

      const dummyTx = {} as TransactionContext;
      await expect(
        service.accept(
          {
            requestId: '1001',
            expectedRequestVersion: 3,
            quoteId: '401',
            expectedQuoteVersion: 2,
            actor: buyerActor,
            idempotencyKey: VALID_IDEMPOTENCY_KEY,
          },
          dummyTx,
          { expectedWorkshopId: '301', now: NOW },
        ),
      ).rejects.toThrow(InvalidStateTransitionError);
    });
  });

  describe('5. tradingContractSuite Execution against TradingAcceptanceService', () => {
    tradingContractSuite('TradingAcceptanceService Contract Suite Compliance', async () => {
      let request = createSampleRequest();
      let recipient = createSampleRecipient();
      let quote = createSampleQuote();

      const idempotencyRecords = new Map<string, PersistedIdempotencyRecord<unknown>>();
      const workshopContract = new MockWorkshopContract().givenActiveWorkshops('301');
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Bát Tràng',
        status: 'active',
        isProfilePublic: true,
      });

      const quoteRequestRepo = {
        findById: vi.fn().mockImplementation(async (id: string) => {
          return id === request.id ? request : null;
        }),
        lockById: vi.fn().mockImplementation(async (id: string) => {
          return id === request.id ? request : null;
        }),
        update: vi.fn().mockImplementation(async ({ request: updated }) => {
          request = updated;
          return updated;
        }),
      } as unknown as IQuoteRequestRepository;

      const recipientRepo = {
        lockByRequestAndWorkshop: vi.fn().mockImplementation(async (reqId, wsId) => {
          return reqId === request.id && wsId === recipient.workshop_id ? recipient : null;
        }),
      } as unknown as IRequestRecipientRepository;

      const quoteRepo = {
        findById: vi.fn().mockImplementation(async (id: string) => {
          return id === quote.id ? quote : null;
        }),
        lockById: vi.fn().mockImplementation(async (id: string) => {
          return id === quote.id ? quote : null;
        }),
        update: vi.fn().mockImplementation(async ({ quote: updated }) => {
          quote = updated;
          return updated;
        }),
      } as unknown as IQuoteRepository;

      const allocationRepo = {
        create: vi.fn().mockImplementation(async ({ allocation }) =>
          Allocation.reconstitute({ ...allocation, id: '5001' }),
        ),
      } as unknown as IAllocationRepository;

      const idempotencyRepo = {
        findByScope: vi.fn().mockImplementation(async (scope: IdempotencyScopeKey) => {
          return idempotencyRecords.get(scope.idempotency_key) ?? null;
        }),
        save: vi.fn().mockImplementation(async (input: CreateIdempotencyRecordInput<unknown>) => {
          const record: PersistedIdempotencyRecord<unknown> = {
            id: '9001',
            ...input,
          };
          idempotencyRecords.set(input.idempotency_key, record);
          return record;
        }),
      } as unknown as IIdempotencyRecordRepository;

      const contract = new TradingAcceptanceService(
        quoteRequestRepo,
        recipientRepo,
        quoteRepo,
        allocationRepo,
        idempotencyRepo,
        workshopContract,
      );

      return {
        contract,
        runner: new MockTransactionRunner(),
        validInput: {
          requestId: '1001',
          expectedRequestVersion: 3,
          quoteId: '401',
          expectedQuoteVersion: 2,
          actor: buyerActor,
          idempotencyKey: VALID_IDEMPOTENCY_KEY,
        },
        invalidQuoteInput: {
          requestId: '1001',
          expectedRequestVersion: 3,
          quoteId: '999',
          expectedQuoteVersion: 2,
          actor: buyerActor,
          idempotencyKey: VALID_IDEMPOTENCY_KEY,
        },
        dispose: async () => {},
      };
    });
  });
});
