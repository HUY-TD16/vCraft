import { describe, expect, it, vi } from 'vitest';
import type { TransactionContext } from '../../../../src/common/application/ports/transaction-runner';
import { Prisma } from '../../../../src/generated/prisma/client';
import type { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import {
  AllocationMapper,
  IdempotencyRecordMapper,
  PrismaAllocationRepository,
  PrismaQuoteRequestRepository,
  QuoteMapper,
  QuoteRequestMapper,
} from '../../../../src/modules/trading/adapters/persistence';
import { TradingAcceptanceService } from '../../../../src/modules/trading/application/services/trading-acceptance.service';
import {
  AllocationBatchLink,
  ConcurrencyConflictError,
  QuoteRequest,
} from '../../../../src/modules/trading/domain';
import { tradingContractSuite } from '../../../contracts/trading.contract-suite';
import {
  BUYER,
  NOW,
  VALID_UUID,
  createTradingTestDeps,
  makeAllocation,
  makeQuote,
  makeRecipient,
  makeRequest,
} from '../../../support/trading-unit-harness';

describe('Trading Persistence Mappers, Prisma Repositories & ITradingContract', () => {
  it('round-trips core domain entities through Prisma mappers without losing precision or invariants', () => {
    const req = makeRequest();
    const reqRow = { ...QuoteRequestMapper.toPrismaCreateInput(req), id: 1001n, created_at: req.created_at, updated_at: req.updated_at };
    const reqBack = QuoteRequestMapper.toDomain(reqRow as Parameters<typeof QuoteRequestMapper.toDomain>[0]);
    expect(reqBack).toMatchObject({ id: '1001', buyer_id: '10', status: 'artisans_bidding', version: 3 });

    const quote = makeQuote();
    const quoteRow = {
      ...QuoteMapper.toPrismaCreateInput(quote),
      id: 401n,
      unit_price: new Prisma.Decimal(quote.unit_price),
      created_at: quote.created_at,
      updated_at: quote.updated_at,
    };
    const quoteBack = QuoteMapper.toDomain(quoteRow as Parameters<typeof QuoteMapper.toDomain>[0]);
    expect(quoteBack).toMatchObject({ id: '401', unit_price: 45000, max_quantity: 5000, status: 'active' });

    const alloc = makeAllocation();
    const allocRow = {
      ...AllocationMapper.toPrismaCreateInput(alloc),
      id: 5001n,
      unit_price: new Prisma.Decimal(alloc.unit_price),
      created_at: alloc.created_at,
      updated_at: alloc.updated_at,
      allocationBatches: [],
    };
    const allocBack = AllocationMapper.toDomain(allocRow as Parameters<typeof AllocationMapper.toDomain>[0]);
    expect(allocBack).toMatchObject({ id: '5001', quote_id: '401', status: 'not_started', version: 1 });

    expect(IdempotencyRecordMapper.validateKey(`  ${VALID_UUID.toUpperCase()}  `)).toBe(VALID_UUID);
  });

  it('PrismaQuoteRequestRepository & PrismaAllocationRepository enforce expectedVersion 409 and batch logs via createMany', async () => {
    const req = makeRequest({ version: 4 });
    const reqClient = {
      quoteRequest: {
        updateMany: vi.fn().mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          ...QuoteRequestMapper.toPrismaCreateInput(req),
          id: 1001n,
          created_at: req.created_at,
          updated_at: req.updated_at,
        }),
      },
      statusLog: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      contactEditHistory: { create: vi.fn() },
    };
    const runner = {
      getClient: () => reqClient,
      run: async <T>(fn: (tx: TransactionContext) => Promise<T>) => fn({} as TransactionContext),
    } as unknown as PrismaTransactionRunner;

    const qrRepo = new PrismaQuoteRequestRepository(runner);
    await expect(qrRepo.update({ request: req, expectedVersion: 3 }, {} as TransactionContext)).rejects.toThrow(ConcurrencyConflictError);

    const { statusLog } = QuoteRequest.createDraft({
      id: '1001',
      buyer_id: '10',
      draft: { category_id: '5', spec: 'Test', quantity: 10, unit: 'piece', delivery_mode: 'at_buyer_address' },
      now: NOW,
    });
    await qrRepo.update({ request: req, expectedVersion: 3, statusLogs: [statusLog] }, {} as TransactionContext);
    expect(reqClient.statusLog.createMany).toHaveBeenCalledTimes(1);

    const alloc = makeAllocation({
      status: 'in_production',
      version: 2,
      batch_links: [AllocationBatchLink.reconstitute({ workshop_id: '301', allocation_id: '5001', batch_id: '901', linked_quantity: 5000, linked_at: NOW, linked_by: '20' })],
    });
    const allocClient = {
      allocation: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          ...AllocationMapper.toPrismaCreateInput(alloc),
          id: 5001n,
          unit_price: new Prisma.Decimal(alloc.unit_price),
          created_at: NOW,
          updated_at: NOW,
          allocationBatches: [],
        }),
      },
      allocationBatch: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      allocationLog: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const allocRepo = new PrismaAllocationRepository({ getClient: () => allocClient } as unknown as PrismaTransactionRunner);
    await allocRepo.update({ allocation: alloc, expectedVersion: 1, syncBatchLinks: true }, {} as TransactionContext);
    expect(allocClient.allocationBatch.createMany).toHaveBeenCalledTimes(1);
  });

  // Verify real TradingAcceptanceService adheres to shared ITradingContract suite
  tradingContractSuite('TradingAcceptanceService (ITradingContract)', async () => {
    const deps = createTradingTestDeps();
    let req = makeRequest({ version: 3 });
    let quote = makeQuote({ version: 1 });
    const recipient = makeRecipient({ version: 2 });
    let savedIdemp: unknown = null;

    deps.quoteRequestRepo.findById.mockImplementation(async () => req);
    deps.quoteRequestRepo.lockById.mockImplementation(async () => req);
    deps.quoteRequestRepo.update.mockImplementation(async ({ request }) => ((req = request), req));
    deps.recipientRepo.findByRequestAndWorkshop.mockResolvedValue(recipient);
    deps.recipientRepo.lockByRequestAndWorkshop.mockResolvedValue(recipient);
    deps.quoteRepo.findById.mockImplementation(async (id: string) => (id === '401' ? quote : null));
    deps.quoteRepo.lockById.mockImplementation(async (id: string) => (id === '401' ? quote : null));
    deps.quoteRepo.update.mockImplementation(async ({ quote: q }) => ((quote = q), quote));
    deps.allocationRepo.create.mockImplementation(async ({ allocation }) => allocation);
    deps.idempotencyRepo.findByScope.mockImplementation(async () => savedIdemp);
    deps.idempotencyRepo.save.mockImplementation(async (input) => {
      savedIdemp = { id: '9001', ...input };
      return savedIdemp;
    });

    const contract = new TradingAcceptanceService(
      deps.quoteRequestRepo,
      deps.recipientRepo,
      deps.quoteRepo,
      deps.allocationRepo,
      deps.idempotencyRepo,
      deps.workshopContract,
    );
    return {
      contract,
      runner: deps.txRunner,
      validInput: { requestId: '1001', expectedRequestVersion: 3, actor: BUYER, quoteId: '401', expectedQuoteVersion: 1, idempotencyKey: VALID_UUID, now: NOW },
      invalidQuoteInput: { requestId: '1001', expectedRequestVersion: 3, actor: BUYER, quoteId: '99999', expectedQuoteVersion: 1, idempotencyKey: VALID_UUID, now: NOW },
      dispose: async () => {},
    };
  });
});
