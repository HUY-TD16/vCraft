import { describe, expect, it, vi } from 'vitest';
import type {
  TransactionContext,
  TransactionRunner,
} from '../../../src/common/application/ports/transaction-runner';
import { Prisma } from '../../../src/generated/prisma/client';
import {
  ConcurrencyConflictError,
  IdempotencyConflictError,
  InvalidTradingInputError,
  TradingPermissionDeniedError,
} from '../../../src/modules/trading/domain';
import type { AcceptanceDto, AcceptanceOperationDto } from '../../../src/modules/trading/public';
import { WorkshopSuspended } from '../../../src/modules/workshops/domain/errors/workshop-suspended';
import { AcceptQuotationWorkflow } from '../../../src/workflows/accept-quotation';
import { MockTradingContract } from '../../support/mocks/trading.mock';
import {
  ARTISAN,
  BUYER,
  NOW,
  TEMP_BUYER,
  VALID_UUID,
  createTradingTestDeps,
  makeAllocationDto,
} from '../../support/trading-unit-harness';

const sampleResult = (replayed = false): { data: AcceptanceDto; operation: AcceptanceOperationDto } => ({
  data: { request_id: '1001', request_status: 'buyer_accepted', request_version: 4, allocations: [makeAllocationDto()] },
  operation: {
    id: '9001',
    replayed,
    committed_at: NOW.toISOString(),
    current_state: {
      request: { id: '1001', status: 'buyer_accepted', version: 4, cancelled_at: null },
      quote: { id: '401', status: 'accepted', version: 2 },
    },
  },
});

describe('AcceptQuotationWorkflow (unit — BR-16, BR-20, BR-27)', () => {
  const baseInput = {
    actor: BUYER,
    requestId: '1001',
    quoteId: '401',
    expectedRequestVersion: 3,
    expectedQuoteVersion: 1,
    idempotencyKey: VALID_UUID,
    now: NOW,
  };

  it('executes atomic steps in order (replay check -> prepare -> ascending workshop lock -> accept) within one tx', async () => {
    const { txRunner, workshopContract } = createTradingTestDeps();
    const runSpy = vi.spyOn(txRunner, 'run');
    const trading = new MockTradingContract();
    const order: string[] = [];

    trading.findAcceptanceReplay.mockImplementation(async () => (order.push('replay'), null));
    trading.prepareAcceptance.mockImplementation(async () => (order.push('prepare'), { workshopIds: ['302', '301', '301'] }));
    workshopContract.lockAndAssertActive.mockImplementation(async (ids) => {
      order.push(`lock:${ids.join(',')}`);
    });
    trading.accept.mockImplementation(async () => (order.push('accept'), sampleResult(false)));

    const workflow = new AcceptQuotationWorkflow(txRunner, trading, workshopContract);
    const out = await workflow.execute(baseInput);

    expect(out.data.request_status).toBe('buyer_accepted');
    expect(out.operation?.replayed).toBe(false);
    expect(order).toEqual(['replay', 'prepare', 'lock:301,302', 'accept']);
    expect(runSpy).toHaveBeenCalledTimes(1);
    const tx = trading.findAcceptanceReplay.mock.calls[0][1];
    expect(trading.prepareAcceptance.mock.calls[0][1]).toBe(tx);
    expect(workshopContract.lockAndAssertActive.mock.calls[0][1]).toBe(tx);
    expect(trading.accept.mock.calls[0][1]).toBe(tx);
  });

  it('rejects non-buyer, temp_password, or invalid input upfront before opening a transaction', async () => {
    const { txRunner, workshopContract } = createTradingTestDeps();
    const runSpy = vi.spyOn(txRunner, 'run');
    const workflow = new AcceptQuotationWorkflow(txRunner, new MockTradingContract(), workshopContract);

    await expect(workflow.execute({ ...baseInput, actor: ARTISAN })).rejects.toThrow(TradingPermissionDeniedError);
    await expect(workflow.execute({ ...baseInput, actor: TEMP_BUYER })).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });
    await expect(workflow.execute({ ...baseInput, idempotencyKey: 'bad-uuid' })).rejects.toThrow(InvalidTradingInputError);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('recovers P2002 / lock-race via fresh replay tx, propagates 409 mismatch, and does not swallow non-race domain errors', async () => {
    const { txRunner, workshopContract } = createTradingTestDeps();
    const trading = new MockTradingContract();
    const workflow = new AcceptQuotationWorkflow(txRunner, trading, workshopContract);

    // 1. P2002 on accept -> recovers committed replay
    trading.findAcceptanceReplay.mockResolvedValueOnce(null).mockResolvedValueOnce(sampleResult(true));
    trading.prepareAcceptance.mockResolvedValue({ workshopIds: ['301'] });
    trading.accept.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Unique', { code: 'P2002', clientVersion: '7' }));
    const recovered = await workflow.execute(baseInput);
    expect(recovered.operation?.replayed).toBe(true);

    // 2. Race recovery detects different payload -> propagates IdempotencyConflictError
    trading.findAcceptanceReplay.mockResolvedValueOnce(null).mockRejectedValueOnce(new IdempotencyConflictError('mismatch'));
    trading.accept.mockRejectedValueOnce(new ConcurrencyConflictError('stale'));
    await expect(workflow.execute(baseInput)).rejects.toThrow(IdempotencyConflictError);

    // 3. Non-race domain error (WorkshopSuspended) is rethrown directly without extra replay lookup
    const findCallsBefore = trading.findAcceptanceReplay.mock.calls.length;
    trading.findAcceptanceReplay.mockResolvedValueOnce(null);
    workshopContract.lockAndAssertActive.mockRejectedValueOnce(new WorkshopSuspended());
    await expect(workflow.execute(baseInput)).rejects.toThrow(WorkshopSuspended);
    expect(trading.findAcceptanceReplay).toHaveBeenCalledTimes(findCallsBefore + 1);
  });

  it('re-runs cleanly when TransactionRunner retries a transient serialization conflict', async () => {
    const { workshopContract } = createTradingTestDeps();
    const trading = new MockTradingContract();
    let attempt = 0;
    const retryingRunner: TransactionRunner = {
      async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
        attempt++;
        const res = await work({ id: attempt } as unknown as TransactionContext);
        if (attempt === 1) return work({ id: 2 } as unknown as TransactionContext);
        return res;
      },
    };
    trading.findAcceptanceReplay.mockResolvedValue(null);
    trading.prepareAcceptance.mockResolvedValue({ workshopIds: ['301'] });
    trading.accept.mockResolvedValue(sampleResult(false));

    const out = await new AcceptQuotationWorkflow(retryingRunner, trading, workshopContract).execute(baseInput);
    expect(out.data.request_status).toBe('buyer_accepted');
    expect(trading.accept).toHaveBeenCalledTimes(2);
  });
});
