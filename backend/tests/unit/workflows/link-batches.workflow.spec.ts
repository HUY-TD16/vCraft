import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessRuleException } from '../../../src/common/domain/errors/business-rule.exception';
import type { AuthenticatedActor } from '../../../src/common/security/guards/authenticated-request';
import type {
  IAllocationBatchRepository,
  IAllocationRepository,
  IQuoteRequestRepository,
} from '../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import {
  Allocation,
  AllocationNotFoundError,
  ConcurrencyConflictError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  QuoteRequest,
  type AllocationBatchLink,
  type AllocationLogRecord,
} from '../../../src/modules/trading/domain';
import { LinkBatchesWorkflow } from '../../../src/workflows/link-batches';
import { MockTraceabilityContract } from '../../support/mocks/traceability.mock';
import { MockTransactionRunner } from '../../support/mocks/transaction-runner.mock';
import { MockWorkshopContract } from '../../support/mocks/workshop.mock';

const artisanActor: AuthenticatedActor = Object.freeze({
  accountId: '201',
  role: 'artisan',
  workshopId: '301',
  authVersion: 1,
  sessionId: 'sess-301',
  sessionLevel: 'normal',
});

const NOW = new Date('2026-11-10T09:00:00.000Z');

describe('LinkBatchesWorkflow (UC-23, BR-24)', () => {
  let txRunner: MockTransactionRunner;
  let traceabilityContract: MockTraceabilityContract;
  let workshopContract: MockWorkshopContract;
  let allocationStore: Map<string, Allocation>;
  let requestStore: Map<string, QuoteRequest>;

  let mockAllocationRepo: IAllocationRepository;
  let mockAllocationBatchRepo: IAllocationBatchRepository;
  let mockQuoteRequestRepo: IQuoteRequestRepository;
  let workflow: LinkBatchesWorkflow;

  beforeEach(() => {
    txRunner = new MockTransactionRunner();
    traceabilityContract = new MockTraceabilityContract();
    workshopContract = new MockWorkshopContract();
    workshopContract.getWorkshopSummary.mockResolvedValue({
      id: '301',
      name: 'Xưởng gốm mẫu Bát Tràng',
      status: 'active',
      isProfilePublic: true,
    });

    requestStore = new Map([
      [
        '10001',
        QuoteRequest.reconstitute({
          id: '10001',
          buyer_id: '101',
          category_id: '11',
          spec: '3.000 cốc gốm men trắng',
          quantity: 3000,
          unit: 'piece',
          unit_set_description: null,
          status: 'in_production',
          delivery_mode: 'at_buyer_address',
          delivery_region: 'Gia Lâm, Hà Nội',
          delivery_address: 'Bát Tràng, Gia Lâm, Hà Nội',
          recipient_name: 'Nguyễn Văn A',
          recipient_phone: '0912345678',
          bidding_deadline: new Date('2026-11-12T17:00:00.000Z'),
          delivery_deadline: new Date('2026-12-01T17:00:00.000Z'),
          bidding_closed_at: new Date('2026-11-10T08:00:00.000Z'),
          version: 7,
          cancelled_at: null,
          cancelled_by: null,
          cancel_reason: null,
          created_at: new Date('2026-11-08T08:00:00.000Z'),
          updated_at: NOW,
        }),
      ],
    ]);

    allocationStore = new Map([
      [
        '12001',
        Allocation.reconstitute({
          id: '12001',
          request_id: '10001',
          workshop_id: '301',
          quote_id: '401',
          quantity: 3000,
          unit_price: 45000,
          committed_delivery_at: new Date('2026-11-28T17:00:00.000Z'),
          status: 'in_production',
          version: 2,
          started_at: NOW,
          started_by: '201',
          handed_over_at: null,
          handed_over_by: null,
          delivery_note: null,
          admin_handed_over: false,
          admin_delivery_evidence: null,
          admin_handover_reason: null,
          admin_handover_actual_at: null,
          created_at: NOW,
          updated_at: NOW,
          batch_links: [],
        }),
      ],
    ]);

    mockAllocationRepo = {
      findById: vi.fn(async (id: string) => allocationStore.get(id) ?? null),
      lockById: vi.fn(async (id: string) => allocationStore.get(id) ?? null),
      update: vi.fn(
        async (input: {
          allocation: Allocation;
          expectedVersion?: number;
          logs?: readonly AllocationLogRecord[];
        }) => {
          const current = allocationStore.get(input.allocation.id);
          if (!current || current.version !== input.expectedVersion) {
            throw new ConcurrencyConflictError('Version mismatch');
          }
          allocationStore.set(input.allocation.id, input.allocation);
          return input.allocation;
        },
      ),
    } as unknown as IAllocationRepository;

    mockAllocationBatchRepo = {
      replaceForAllocation: vi.fn(
        async (input: { links: readonly AllocationBatchLink[] }) => input.links,
      ),
    } as unknown as IAllocationBatchRepository;

    mockQuoteRequestRepo = {
      findById: vi.fn(async (id: string) => requestStore.get(id) ?? null),
      lockById: vi.fn(async (id: string) => requestStore.get(id) ?? null),
    } as unknown as IQuoteRequestRepository;

    workflow = new LinkBatchesWorkflow(
      txRunner,
      mockAllocationRepo,
      mockQuoteRequestRepo,
      traceabilityContract,
      mockAllocationBatchRepo,
      workshopContract,
    );
  });

  it('co-ordinates QuoteRequest lock -> Allocation lock -> Traceability.assertOwnedBatches -> AllocationBatch persistence in one transaction', async () => {
    traceabilityContract.assertOwnedBatches.mockResolvedValueOnce([
      {
        id: '901',
        name: 'Lô 901',
        status: 'published',
        traceUrl: '/api/v1/trace/901',
      },
    ]);

    const result = await workflow.execute({
      actor: artisanActor,
      allocationId: '12001',
      expectedAllocationVersion: 2,
      links: [{ batch_id: '901', linked_quantity: 3000 }],
      now: NOW,
    });

    expect(result.allocation.version).toBe(3);
    expect(result.allocation.traceability_warning).toBeNull();
    expect(mockAllocationBatchRepo.replaceForAllocation).toHaveBeenCalledTimes(
      1,
    );
    expect(mockAllocationRepo.update).toHaveBeenCalledTimes(1);
  });

  it('rolls back without updating Allocation when Traceability.assertOwnedBatches rejects unowned batch', async () => {
    traceabilityContract.assertOwnedBatches.mockRejectedValueOnce(
      new BusinessRuleException('RESOURCE_NOT_FOUND'),
    );

    await expect(
      workflow.execute({
        actor: artisanActor,
        allocationId: '12001',
        expectedAllocationVersion: 2,
        links: [{ batch_id: '999', linked_quantity: 1000 }],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    expect(
      mockAllocationBatchRepo.replaceForAllocation,
    ).not.toHaveBeenCalled();
    expect(mockAllocationRepo.update).not.toHaveBeenCalled();
    expect(allocationStore.get('12001')?.version).toBe(2);
  });

  it('validates input bounds and state constraints strictly', async () => {
    await expect(
      workflow.execute({
        actor: artisanActor,
        allocationId: '99999',
        expectedAllocationVersion: 2,
        links: [],
      }),
    ).rejects.toThrow(AllocationNotFoundError);

    await expect(
      workflow.execute({
        actor: artisanActor,
        allocationId: '12001',
        expectedAllocationVersion: 2,
        links: [{ batch_id: '901', linked_quantity: 3001 }],
      }),
    ).rejects.toThrow(InvalidTradingInputError);

    allocationStore.set(
      '12001',
      Allocation.reconstitute({
        ...allocationStore.get('12001')!,
        status: 'not_started',
        started_at: null,
        started_by: null,
      }),
    );

    await expect(
      workflow.execute({
        actor: artisanActor,
        allocationId: '12001',
        expectedAllocationVersion: 2,
        links: [],
      }),
    ).rejects.toThrow(InvalidStateTransitionError);
  });
});
