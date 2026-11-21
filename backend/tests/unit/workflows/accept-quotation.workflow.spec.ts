import { describe, expect, it, vi } from 'vitest';
import type {
  TransactionContext,
  TransactionRunner,
} from '../../../src/common/application/ports/transaction-runner';
import type { AuthenticatedActor } from '../../../src/common/application/types/contract-types';
import { Prisma } from '../../../src/generated/prisma/client';
import type {
  CreateIdempotencyRecordInput,
  IdempotencyScopeKey,
  PersistedIdempotencyRecord,
} from '../../../src/modules/trading/application/dtos/trading-persistence.dtos';
import type {
  IAllocationRepository,
  IIdempotencyRecordRepository,
  IQuoteRepository,
  IQuoteRequestRepository,
  IRequestRecipientRepository,
} from '../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { TradingAcceptanceService } from '../../../src/modules/trading/application/services/trading-acceptance.service';
import {
  Allocation,
  ConcurrencyConflictError,
  DeadlineViolationError,
  IdempotencyConflictError,
  InsufficientCapacityError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  Quote,
  QuoteExpiredError,
  QuoteRequest,
  RequestRecipient,
  TradingDomainError,
  TradingPermissionDeniedError,
  TradingResourceNotFoundError,
} from '../../../src/modules/trading/domain';
import type {
  AcceptanceDto,
  AcceptanceOperationDto,
} from '../../../src/modules/trading/public';
import { WorkshopSuspended } from '../../../src/modules/workshops/domain/errors/workshop-suspended';
import { AcceptQuotationWorkflow } from '../../../src/workflows/accept-quotation';
import { MockTradingContract } from '../../support/mocks/trading.mock';
import { MockTransactionRunner } from '../../support/mocks/transaction-runner.mock';
import { MockWorkshopContract } from '../../support/mocks/workshop.mock';

const SENT_AT = new Date('2026-11-10T08:00:00.000Z');
const NOW = new Date('2026-11-15T10:00:00.000Z');
const BIDDING_DEADLINE = new Date('2026-11-20T10:00:00.000Z');
const BID_ACCEPT_DEADLINE = new Date('2026-11-25T10:00:00.000Z');
const COMMITTED_DELIVERY = new Date('2026-11-28T10:00:00.000Z');
const DELIVERY_DEADLINE = new Date('2026-11-30T10:00:00.000Z');
const VALID_UUID = '11111111-2222-4333-8444-555555555555';

const buyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-buyer-10',
  sessionLevel: 'normal',
});

function createSampleRequest(
  overrides: Partial<Parameters<typeof QuoteRequest.reconstitute>[0]> = {},
): QuoteRequest {
  return QuoteRequest.reconstitute({
    id: '1001',
    buyer_id: '10',
    category_id: '5',
    spec: '5000 bát gốm men rạn Bát Tràng',
    quantity: 5000,
    unit: 'piece',
    unit_set_description: null,
    status: 'artisans_bidding',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội',
    delivery_address: 'Bát Tràng, Gia Lâm, Hà Nội',
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

function createSampleAcceptanceDto(): AcceptanceDto {
  return {
    request_id: '1001',
    request_status: 'buyer_accepted',
    request_version: 4,
    allocations: [
      {
        id: '5001',
        request_id: '1001',
        workshop: { id: '301', name: 'Xưởng Gốm Minh Long' },
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
  };
}

function createSampleOperation(replayed: boolean): AcceptanceOperationDto {
  return {
    id: '9001',
    replayed,
    committed_at: NOW.toISOString(),
    current_state: {
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
    },
  };
}

describe('AcceptQuotationWorkflow (unit)', () => {
  it('executes all 8 atomic steps in deterministic order and commits once via txRunner', async () => {
    const txRunner = new MockTransactionRunner();
    const workshopContract = new MockWorkshopContract().givenActiveWorkshops('301');
    workshopContract.getWorkshopSummary.mockResolvedValue({
      id: '301',
      name: 'Xưởng Gốm Minh Long',
      status: 'active',
      isProfilePublic: true,
    });

    const request = createSampleRequest();
    const recipient = createSampleRecipient();
    const quote = createSampleQuote();
    const callOrder: string[] = [];
    const idempotencyStore = new Map<string, PersistedIdempotencyRecord<unknown>>();

    const tradingService = new TradingAcceptanceService(
      {
        findById: vi.fn().mockImplementation(async () => {
          callOrder.push('request.findById');
          return request;
        }),
        lockById: vi.fn().mockImplementation(async () => {
          callOrder.push('request.lockById');
          return request;
        }),
        update: vi.fn().mockImplementation(async ({ request: next }) => {
          callOrder.push('request.update');
          return next;
        }),
      } as unknown as IQuoteRequestRepository,
      {
        lockByRequestAndWorkshop: vi.fn().mockImplementation(async () => {
          callOrder.push('recipient.lockByRequestAndWorkshop');
          return recipient;
        }),
      } as unknown as IRequestRecipientRepository,
      {
        findById: vi.fn().mockImplementation(async () => {
          callOrder.push('quote.findById');
          return quote;
        }),
        lockById: vi.fn().mockImplementation(async () => {
          callOrder.push('quote.lockById');
          return quote;
        }),
        update: vi.fn().mockImplementation(async ({ quote: next }) => {
          callOrder.push('quote.update');
          return next;
        }),
      } as unknown as IQuoteRepository,
      {
        create: vi.fn().mockImplementation(async ({ allocation }) => {
          callOrder.push('allocation.create');
          return Allocation.reconstitute({ ...allocation, id: '5001' });
        }),
      } as unknown as IAllocationRepository,
      {
        findByScope: vi.fn().mockImplementation(async (scope: IdempotencyScopeKey) => {
          callOrder.push('idempotency.findByScope');
          return idempotencyStore.get(scope.idempotency_key) ?? null;
        }),
        save: vi.fn().mockImplementation(async (input: CreateIdempotencyRecordInput<unknown>) => {
          callOrder.push('idempotency.save');
          const saved: PersistedIdempotencyRecord<unknown> = {
            id: '9001',
            ...input,
          };
          idempotencyStore.set(input.idempotency_key, saved);
          return saved;
        }),
      } as unknown as IIdempotencyRecordRepository,
      workshopContract,
    );

    const origLockWs = workshopContract.lockAndAssertActive.getMockImplementation()!;
    workshopContract.lockAndAssertActive.mockImplementation(async (ids, tx) => {
      callOrder.push('workshop.lockAndAssertActive');
      return origLockWs(ids, tx);
    });

    const workflow = new AcceptQuotationWorkflow(
      txRunner,
      tradingService,
      workshopContract,
    );

    const result = await workflow.execute({
      actor: buyerActor,
      requestId: '1001',
      quoteId: '401',
      expectedRequestVersion: 3,
      expectedQuoteVersion: 2,
      idempotencyKey: `  ${VALID_UUID.toUpperCase()}  `,
      now: NOW,
    });

    expect(txRunner.contexts).toHaveLength(1);
    expect(result.data.request_status).toBe('buyer_accepted');
    expect(result.data.allocations).toHaveLength(1);
    expect(result.operation?.id).toBe('9001');
    expect(result.operation?.replayed).toBe(false);
    expect(callOrder).toEqual([
      'request.findById',
      'idempotency.findByScope',
      'request.findById',
      'quote.findById',
      'workshop.lockAndAssertActive',
      'request.lockById',
      'recipient.lockByRequestAndWorkshop',
      'quote.lockById',
      'quote.update',
      'request.update',
      'allocation.create',
      'idempotency.save',
    ]);
  });

  it('validates actor.accountId, idempotencyKey, requestId, quoteId, versions, role, and temp_password upfront before opening a transaction', async () => {
    const txRunner = new MockTransactionRunner();
    const trading = new MockTradingContract();
    const workshop = new MockWorkshopContract().givenActiveWorkshops('301');
    const workflow = new AcceptQuotationWorkflow(txRunner, trading, workshop);

    for (const badAccountId of ['0', '-5', 'abc', '']) {
      await expect(
        workflow.execute({
          actor: { ...buyerActor, accountId: badAccountId },
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          idempotencyKey: VALID_UUID,
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    }

    for (const badKey of ['', '   ', 'not-a-uuid', '11111111-2222-1333-8444-555555555555']) {
      await expect(
        workflow.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          idempotencyKey: badKey,
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    }

    await expect(
      workflow.execute({
        actor: buyerActor,
        requestId: '0',
        quoteId: '401',
        expectedRequestVersion: 3,
        expectedQuoteVersion: 2,
        idempotencyKey: VALID_UUID,
      }),
    ).rejects.toThrow(InvalidTradingInputError);

    await expect(
      workflow.execute({
        actor: buyerActor,
        requestId: '1001',
        quoteId: 'bad-id',
        expectedRequestVersion: 3,
        expectedQuoteVersion: 2,
        idempotencyKey: VALID_UUID,
      }),
    ).rejects.toThrow(InvalidTradingInputError);

    await expect(
      workflow.execute({
        actor: buyerActor,
        requestId: '1001',
        quoteId: '401',
        expectedRequestVersion: 0,
        expectedQuoteVersion: 2,
        idempotencyKey: VALID_UUID,
      }),
    ).rejects.toThrow(InvalidTradingInputError);

    await expect(
      workflow.execute({
        actor: { ...buyerActor, role: 'artisan', workshopId: '301' },
        requestId: '1001',
        quoteId: '401',
        expectedRequestVersion: 3,
        expectedQuoteVersion: 2,
        idempotencyKey: VALID_UUID,
      }),
    ).rejects.toThrow(TradingPermissionDeniedError);

    await expect(
      workflow.execute({
        actor: { ...buyerActor, sessionLevel: 'temp_password' },
        requestId: '1001',
        quoteId: '401',
        expectedRequestVersion: 3,
        expectedQuoteVersion: 2,
        idempotencyKey: VALID_UUID,
      }),
    ).rejects.toBeInstanceOf(TradingDomainError);

    expect(txRunner.contexts).toHaveLength(0);
    expect(trading.findAcceptanceReplay).not.toHaveBeenCalled();
    expect(trading.prepareAcceptance).not.toHaveBeenCalled();
    expect(trading.accept).not.toHaveBeenCalled();
  });

  it('rejects omitted idempotencyKey with InvalidTradingInputError when tradingContract lacks executeAcceptance (never passes empty string)', async () => {
    const txRunner = new MockTransactionRunner();
    const trading = new MockTradingContract();
    const workshop = new MockWorkshopContract().givenActiveWorkshops('301');
    const workflow = new AcceptQuotationWorkflow(txRunner, trading, workshop);

    await expect(
      workflow.execute({
        actor: buyerActor,
        requestId: '1001',
        quoteId: '401',
        expectedRequestVersion: 3,
        expectedQuoteVersion: 2,
      }),
    ).rejects.toThrow(InvalidTradingInputError);

    expect(txRunner.contexts).toHaveLength(0);
    expect(trading.accept).not.toHaveBeenCalled();
  });

  it('when BOTH input.tx and idempotencyKey are provided, runs Step 1 replay check and Step 7 accept (persisting IdempotencyRecord) on input.tx', async () => {
    const txRunner = new MockTransactionRunner();
    const externalTx = Object.freeze({ ext: true }) as unknown as TransactionContext;
    const trading = new MockTradingContract();
    const workshop = new MockWorkshopContract().givenActiveWorkshops('301');
    const sampleData = createSampleAcceptanceDto();
    const freshOp = createSampleOperation(false);
    const replayOp = createSampleOperation(true);

    trading.findAcceptanceReplay.mockResolvedValueOnce(null);
    trading.prepareAcceptance.mockResolvedValueOnce({ workshopIds: ['301'] });
    trading.accept.mockResolvedValueOnce({
      data: sampleData,
      operation: freshOp,
    });

    const workflow = new AcceptQuotationWorkflow(txRunner, trading, workshop);
    const first = await workflow.execute({
      actor: buyerActor,
      requestId: '1001',
      quoteId: '401',
      expectedRequestVersion: 3,
      expectedQuoteVersion: 2,
      idempotencyKey: VALID_UUID,
      now: NOW,
      tx: externalTx,
    });

    expect(txRunner.contexts).toHaveLength(0);
    expect(trading.findAcceptanceReplay).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: VALID_UUID }),
      externalTx,
    );
    expect(trading.accept).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: VALID_UUID }),
      externalTx,
      { expectedWorkshopId: '301', now: NOW },
    );
    expect(first.operation?.replayed).toBe(false);

    // 2nd call with tx + same idempotencyKey hits replay directly without locking
    trading.findAcceptanceReplay.mockResolvedValueOnce({
      data: sampleData,
      operation: replayOp,
    });
    const replayed = await workflow.execute({
      actor: buyerActor,
      requestId: '1001',
      quoteId: '401',
      expectedRequestVersion: 3,
      expectedQuoteVersion: 2,
      idempotencyKey: VALID_UUID,
      tx: externalTx,
    });

    expect(txRunner.contexts).toHaveLength(0);
    expect(replayed.operation?.replayed).toBe(true);
    expect(workshop.lockAndAssertActive).toHaveBeenCalledTimes(1);
    expect(trading.accept).toHaveBeenCalledTimes(1);
  });

  it('deduplicates and sorts workshopIds numerically ascending and fails closed on empty workshopIds', async () => {
    const txRunner = new MockTransactionRunner();
    const trading = new MockTradingContract();
    const workshop = new MockWorkshopContract().givenActiveWorkshops('2', '10');
    const workflow = new AcceptQuotationWorkflow(txRunner, trading, workshop);

    trading.findAcceptanceReplay.mockResolvedValue(null);
    trading.prepareAcceptance.mockResolvedValueOnce({
      workshopIds: ['10', '2', '10'],
    });
    trading.accept.mockResolvedValueOnce({
      data: createSampleAcceptanceDto(),
      operation: createSampleOperation(false),
    });

    await workflow.execute({
      actor: buyerActor,
      requestId: '1001',
      quoteId: '401',
      expectedRequestVersion: 3,
      expectedQuoteVersion: 2,
      idempotencyKey: VALID_UUID,
    });
    expect(workshop.lockAndAssertActive).toHaveBeenCalledWith(
      ['2', '10'],
      expect.anything(),
    );

    trading.prepareAcceptance.mockResolvedValueOnce({ workshopIds: [] });
    await expect(
      workflow.execute({
        actor: buyerActor,
        requestId: '1001',
        quoteId: '401',
        expectedRequestVersion: 3,
        expectedQuoteVersion: 2,
        idempotencyKey: VALID_UUID,
      }),
    ).rejects.toThrow(TradingResourceNotFoundError);
    expect(workshop.lockAndAssertActive).toHaveBeenCalledTimes(1);
  });

  describe('standalone concurrent race recovery (P2002 / ConcurrencyConflictError / InvalidStateTransitionError)', () => {
    it('recovers from P2002 and lock-race ConcurrencyConflictError / InvalidStateTransitionError via fresh replay tx', async () => {
      const sampleData = createSampleAcceptanceDto();
      const replayOp = createSampleOperation(true);

      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: '7.10.1' },
      );

      for (const raceError of [
        p2002Error,
        new ConcurrencyConflictError('version mismatch'),
        new InvalidStateTransitionError('already accepted'),
      ]) {
        const txRunner = new MockTransactionRunner();
        const trading = new MockTradingContract();
        const workshop = new MockWorkshopContract().givenActiveWorkshops('301');
        const workflow = new AcceptQuotationWorkflow(txRunner, trading, workshop);

        trading.findAcceptanceReplay
          .mockResolvedValueOnce(null) // Step 1 initial check sees null
          .mockResolvedValueOnce({
            // Fresh post-rollback recovery tx finds committed winner
            data: sampleData,
            operation: replayOp,
          });
        trading.prepareAcceptance.mockResolvedValueOnce({ workshopIds: ['301'] });
        trading.accept.mockRejectedValueOnce(raceError);

        const out = await workflow.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          idempotencyKey: VALID_UUID,
        });

        expect(txRunner.contexts).toHaveLength(2);
        expect(out.operation?.replayed).toBe(true);
        expect(out.data).toEqual(sampleData);
      }
    });

    it('propagates IdempotencyConflictError when recovery finds committed record with different payload', async () => {
      const txRunner = new MockTransactionRunner();
      const trading = new MockTradingContract();
      const workshop = new MockWorkshopContract().givenActiveWorkshops('301');
      const workflow = new AcceptQuotationWorkflow(txRunner, trading, workshop);

      trading.findAcceptanceReplay
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new IdempotencyConflictError('fingerprint mismatch'));
      trading.prepareAcceptance.mockResolvedValueOnce({ workshopIds: ['301'] });
      trading.accept.mockRejectedValueOnce(new ConcurrencyConflictError('stale version'));

      await expect(
        workflow.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          idempotencyKey: VALID_UUID,
        }),
      ).rejects.toThrow(IdempotencyConflictError);
      expect(txRunner.contexts).toHaveLength(2);
    });

    it('rethrows original race error when no committed IdempotencyRecord exists for that key', async () => {
      const txRunner = new MockTransactionRunner();
      const trading = new MockTradingContract();
      const workshop = new MockWorkshopContract().givenActiveWorkshops('301');
      const workflow = new AcceptQuotationWorkflow(txRunner, trading, workshop);

      trading.findAcceptanceReplay
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      trading.prepareAcceptance.mockResolvedValueOnce({ workshopIds: ['301'] });
      const originalErr = new InvalidStateTransitionError('quote was withdrawn');
      trading.accept.mockRejectedValueOnce(originalErr);

      await expect(
        workflow.execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          idempotencyKey: VALID_UUID,
        }),
      ).rejects.toBe(originalErr);
      expect(txRunner.contexts).toHaveLength(2);
    });

    it('does NOT swallow or issue extra replay lookups for non-race domain errors (WorkshopSuspended, QuoteExpiredError, InsufficientCapacityError, DeadlineViolationError, TradingResourceNotFoundError, IdempotencyConflictError)', async () => {
      const nonRaceErrors = [
        new WorkshopSuspended(),
        new QuoteExpiredError(),
        new InsufficientCapacityError(),
        new DeadlineViolationError(),
        new TradingResourceNotFoundError(),
        new IdempotencyConflictError(),
      ];

      for (const nonRaceError of nonRaceErrors) {
        const txRunner = new MockTransactionRunner();
        const trading = new MockTradingContract();
        const workshop = new MockWorkshopContract().givenActiveWorkshops('301');
        const workflow = new AcceptQuotationWorkflow(txRunner, trading, workshop);

        trading.findAcceptanceReplay.mockResolvedValueOnce(null);
        trading.prepareAcceptance.mockResolvedValueOnce({ workshopIds: ['301'] });
        trading.accept.mockRejectedValueOnce(nonRaceError);

        await expect(
          workflow.execute({
            actor: buyerActor,
            requestId: '1001',
            quoteId: '401',
            expectedRequestVersion: 3,
            expectedQuoteVersion: 2,
            idempotencyKey: VALID_UUID,
          }),
        ).rejects.toBe(nonRaceError);

        expect(txRunner.contexts).toHaveLength(1);
        expect(trading.findAcceptanceReplay).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('mid-flight mutation and lock-verification edge cases with TradingAcceptanceService', () => {
    it('detects missing RequestRecipient, quote workshop change after pre-read, and mid-flight quote withdrawal', async () => {
      const txRunner = new MockTransactionRunner();
      const workshop = new MockWorkshopContract().givenActiveWorkshops('301');
      workshop.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng Gốm Minh Long',
        status: 'active',
        isProfilePublic: true,
      });

      const request = createSampleRequest();
      const activeQuote = createSampleQuote();
      const withdrawnQuote = createSampleQuote({
        status: 'withdrawn',
        version: 3,
        withdraw_reason: 'Withdrawn concurrently',
        withdrawn_by: '20',
        withdrawn_at: NOW,
      });
      const movedWorkshopQuote = createSampleQuote({ workshop_id: '302' });

      // 1. Missing RequestRecipient
      const missingRecipientService = new TradingAcceptanceService(
        {
          findById: vi.fn().mockResolvedValue(request),
          lockById: vi.fn().mockResolvedValue(request),
          update: vi.fn(),
        } as unknown as IQuoteRequestRepository,
        {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(null),
        } as unknown as IRequestRecipientRepository,
        {
          findById: vi.fn().mockResolvedValue(activeQuote),
          lockById: vi.fn(),
          update: vi.fn(),
        } as unknown as IQuoteRepository,
        { create: vi.fn() } as unknown as IAllocationRepository,
        {
          findByScope: vi.fn().mockResolvedValue(null),
          save: vi.fn(),
        } as unknown as IIdempotencyRecordRepository,
        workshop,
      );

      await expect(
        new AcceptQuotationWorkflow(txRunner, missingRecipientService, workshop).execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          idempotencyKey: VALID_UUID,
        }),
      ).rejects.toThrow(TradingResourceNotFoundError);

      // 2. lockedQuote.workshop_id !== workshopIdToLock -> ConcurrencyConflictError
      const recipient = createSampleRecipient();
      const changedWorkshopService = new TradingAcceptanceService(
        {
          findById: vi.fn().mockResolvedValue(request),
          lockById: vi.fn().mockResolvedValue(request),
          update: vi.fn(),
        } as unknown as IQuoteRequestRepository,
        {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
        } as unknown as IRequestRecipientRepository,
        {
          findById: vi.fn().mockResolvedValue(activeQuote),
          lockById: vi.fn().mockResolvedValue(movedWorkshopQuote),
          update: vi.fn(),
        } as unknown as IQuoteRepository,
        { create: vi.fn() } as unknown as IAllocationRepository,
        {
          findByScope: vi.fn().mockResolvedValue(null),
          save: vi.fn(),
        } as unknown as IIdempotencyRecordRepository,
        workshop,
      );

      await expect(
        new AcceptQuotationWorkflow(txRunner, changedWorkshopService, workshop).execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          idempotencyKey: VALID_UUID,
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      // 3. Mid-flight withdrawal between prepareAcceptance and lockById
      const midFlightWithdrawnService = new TradingAcceptanceService(
        {
          findById: vi.fn().mockResolvedValue(request),
          lockById: vi.fn().mockResolvedValue(request),
          update: vi.fn(),
        } as unknown as IQuoteRequestRepository,
        {
          lockByRequestAndWorkshop: vi.fn().mockResolvedValue(recipient),
        } as unknown as IRequestRecipientRepository,
        {
          findById: vi.fn().mockResolvedValue(activeQuote),
          lockById: vi.fn().mockResolvedValue(withdrawnQuote),
          update: vi.fn(),
        } as unknown as IQuoteRepository,
        { create: vi.fn() } as unknown as IAllocationRepository,
        {
          findByScope: vi.fn().mockResolvedValue(null),
          save: vi.fn(),
        } as unknown as IIdempotencyRecordRepository,
        workshop,
      );

      await expect(
        new AcceptQuotationWorkflow(txRunner, midFlightWithdrawnService, workshop).execute({
          actor: buyerActor,
          requestId: '1001',
          quoteId: '401',
          expectedRequestVersion: 3,
          expectedQuoteVersion: 2,
          idempotencyKey: VALID_UUID,
        }),
      ).rejects.toThrow(ConcurrencyConflictError);
    });

    it('re-runs the 8-step workflow cleanly when TransactionRunner retries a transient serialization conflict', async () => {
      let attempts = 0;
      const retryingRunner: TransactionRunner = {
        async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
          for (let i = 0; ; i++) {
            attempts += 1;
            try {
              return await work(Object.freeze({ attempt: attempts }) as unknown as TransactionContext);
            } catch (err) {
              if (i >= 2 || (err as { code?: string }).code !== 'P2034') {
                throw err;
              }
            }
          }
        },
      };

      const trading = new MockTradingContract();
      const workshop = new MockWorkshopContract().givenActiveWorkshops('301');
      trading.findAcceptanceReplay.mockResolvedValue(null);
      trading.prepareAcceptance.mockResolvedValue({ workshopIds: ['301'] });
      trading.accept
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('Serialization failure', {
            code: 'P2034',
            clientVersion: '7.10.1',
          }),
        )
        .mockResolvedValueOnce({
          data: createSampleAcceptanceDto(),
          operation: createSampleOperation(false),
        });

      const workflow = new AcceptQuotationWorkflow(retryingRunner, trading, workshop);
      const out = await workflow.execute({
        actor: buyerActor,
        requestId: '1001',
        quoteId: '401',
        expectedRequestVersion: 3,
        expectedQuoteVersion: 2,
        idempotencyKey: VALID_UUID,
      });

      expect(attempts).toBe(2);
      expect(out.operation?.replayed).toBe(false);
    });
  });
});
