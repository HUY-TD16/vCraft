import { describe, expect, it } from 'vitest';
import { BusinessRuleException } from '../../../src/common/domain/errors/business-rule.exception';
import {
  AllocationNotFoundError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
} from '../../../src/modules/trading/domain';
import { LinkBatchesWorkflow } from '../../../src/workflows/link-batches';
import {
  ARTISAN,
  NOW,
  createTradingTestDeps,
  makeAllocation,
  makeRequest,
} from '../../support/trading-unit-harness';

describe('LinkBatchesWorkflow (unit — UC-23, BR-24)', () => {
  const setup = (allocStatus: 'in_production' | 'not_started' = 'in_production') => {
    const deps = createTradingTestDeps();
    const req = makeRequest({ status: 'in_production', version: 5 });
    const alloc = makeAllocation({
      status: allocStatus,
      version: 2,
      started_at: allocStatus === 'in_production' ? NOW : null,
      started_by: allocStatus === 'in_production' ? ARTISAN.accountId : null,
    });
    deps.quoteRequestRepo.lockById.mockResolvedValue(req);
    deps.allocationRepo.lockById.mockResolvedValue(alloc);
    deps.allocationRepo.findById.mockResolvedValue(alloc);
    const workflow = new LinkBatchesWorkflow(
      deps.txRunner,
      deps.allocationRepo,
      deps.quoteRequestRepo,
      deps.traceabilityContract,
      deps.allocationBatchRepo,
      deps.workshopContract,
    );
    return { deps, workflow };
  };

  it('locks QuoteRequest -> Allocation -> verifies batch ownership -> persists AllocationBatch atomically', async () => {
    const { deps, workflow } = setup();
    const out = await workflow.execute({
      actor: ARTISAN,
      allocationId: '5001',
      expectedAllocationVersion: 2,
      links: [{ batch_id: '901', linked_quantity: 5000 }],
      now: NOW,
    });
    expect(out.allocation.version).toBe(3);
    expect(out.allocation.traceability_warning).toBeNull();
    expect(deps.allocationBatchRepo.replaceForAllocation).toHaveBeenCalledTimes(1);
    expect(deps.allocationRepo.update).toHaveBeenCalledTimes(1);
  });

  it('rejects unowned batch, missing allocation, over-capacity links, and non-in_production state without mutating', async () => {
    const { deps, workflow } = setup();
    deps.traceabilityContract.assertOwnedBatches.mockRejectedValueOnce(new BusinessRuleException('RESOURCE_NOT_FOUND'));
    await expect(
      workflow.execute({ actor: ARTISAN, allocationId: '5001', expectedAllocationVersion: 2, links: [{ batch_id: '999', linked_quantity: 100 }], now: NOW }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(deps.allocationRepo.update).not.toHaveBeenCalled();

    // Quantity exceeding allocation.quantity (5000) -> InvalidTradingInputError
    await expect(
      workflow.execute({ actor: ARTISAN, allocationId: '5001', expectedAllocationVersion: 2, links: [{ batch_id: '901', linked_quantity: 5001 }], now: NOW }),
    ).rejects.toThrow(InvalidTradingInputError);

    // Missing allocation -> AllocationNotFoundError
    deps.allocationRepo.lockById.mockResolvedValueOnce(null);
    await expect(
      workflow.execute({ actor: ARTISAN, allocationId: '9999', expectedAllocationVersion: 2, links: [], now: NOW }),
    ).rejects.toThrow(AllocationNotFoundError);

    // Allocation not started -> InvalidStateTransitionError
    const { workflow: notStartedWf } = setup('not_started');
    await expect(
      notStartedWf.execute({ actor: ARTISAN, allocationId: '5001', expectedAllocationVersion: 2, links: [], now: NOW }),
    ).rejects.toThrow(InvalidStateTransitionError);
  });
});
