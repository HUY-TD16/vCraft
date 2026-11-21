import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { configureHttp } from '../../../../src/bootstrap/configure-http';
import { AppConfigModule } from '../../../../src/common/config/app-config';
import { BusinessRuleException } from '../../../../src/common/domain/errors/business-rule.exception';
import { AppLogger } from '../../../../src/common/observability/app-logger';
import { SecurityModule } from '../../../../src/common/security/security.module';
import {
  ACCESS_POLICY,
  SESSION_LEVELS,
} from '../../../../src/common/security/decorators/access-policy';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import { createApiDocument } from '../../../../src/common/http/swagger/configure-swagger';
import {
  TRANSACTION_RUNNER,
  type TransactionContext,
  type TransactionRunner,
} from '../../../../src/common/application/ports/transaction-runner';
import { IDENTITY_CONTRACT } from '../../../../src/modules/identity/public/contracts/identity.contract';
import {
  TRACEABILITY_CONTRACT,
  type ITraceabilityContract,
} from '../../../../src/modules/traceability/public/contracts/traceability.contract';
import {
  WORKSHOP_CONTRACT,
  type IWorkshopContract,
} from '../../../../src/modules/workshops/public/contracts/workshop.contract';
import {
  ALLOCATION_BATCH_REPOSITORY,
  ALLOCATION_REPOSITORY,
  IDEMPOTENCY_RECORD_REPOSITORY,
  QUOTE_REPOSITORY,
  QUOTE_REQUEST_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
  type IAllocationBatchRepository,
  type IAllocationRepository,
  type IIdempotencyRecordRepository,
  type IQuoteRequestRepository,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import type {
  CreateIdempotencyRecordInput,
  IdempotencyScopeKey,
  PersistedIdempotencyRecord,
} from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';
import { TradingIdempotencyService } from '../../../../src/modules/trading/application/services/trading-idempotency.service';
import { ListArtisanAllocationsUseCase } from '../../../../src/modules/trading/application/use-cases/fulfillment/list-artisan-allocations.use-case';
import { StartAllocationProductionUseCase } from '../../../../src/modules/trading/application/use-cases/fulfillment/start-allocation-production.use-case';
import { LinkAllocationBatchesUseCase } from '../../../../src/modules/trading/application/use-cases/fulfillment/link-allocation-batches.use-case';
import { ArtisanAllocationController } from '../../../../src/modules/trading/adapters/http/controllers/artisan-allocation.controller';
import { allocationDtoResponseSchema } from '../../../../src/modules/trading/adapters/http/dtos/accept-quote.dto';
import {
  LinkAllocationBatchesDto,
  linkAllocationBatchesOperationResponseSchema,
  linkAllocationBatchesSchema,
} from '../../../../src/modules/trading/adapters/http/dtos/link-allocation-batches.dto';
import { TRADING_MUTATION_METADATA_KEY } from '../../../../src/modules/trading/adapters/http/decorators/trading-mutation.decorator';
import {
  TRADING_CURRENT_STATE_RESOLVER,
  TradingCurrentStateResolver,
} from '../../../../src/modules/trading/adapters/http/interceptors/trading-current-state.resolver';
import { TradingMutationInterceptor } from '../../../../src/modules/trading/adapters/http/interceptors/trading-mutation.interceptor';
import { AllocationMapper } from '../../../../src/modules/trading/adapters/persistence/mappers/allocation.mapper';
import { TradingModule } from '../../../../src/modules/trading/trading.module';
import {
  Allocation,
  AllocationBatchLink,
  AllocationNotFoundError,
  ConcurrencyConflictError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  QuoteRequest,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
  TradingResourceNotFoundError,
  type AllocationLogRecord,
  type AllocationStatus,
  type RequestStatus,
} from '../../../../src/modules/trading/domain';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
import { MockTraceabilityContract } from '../../../support/mocks/traceability.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import { MockWorkshopContract } from '../../../support/mocks/workshop.mock';

// ---------------------------------------------------------------------------
// Test Actors
// ---------------------------------------------------------------------------
const owningArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '201',
  role: 'artisan',
  workshopId: '301',
  authVersion: 1,
  sessionId: 'sess-artisan-301',
  sessionLevel: 'normal',
});

const secondArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '202',
  role: 'artisan',
  workshopId: '302',
  authVersion: 1,
  sessionId: 'sess-artisan-302',
  sessionLevel: 'normal',
});

const artisanWithoutWorkshopActor: AuthenticatedActor = Object.freeze({
  accountId: '230',
  role: 'artisan',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-artisan-no-ws',
  sessionLevel: 'normal',
});

const tempPasswordArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '201',
  role: 'artisan',
  workshopId: '301',
  authVersion: 1,
  sessionId: 'sess-temp-artisan',
  sessionLevel: 'temp_password',
});

const buyerActor: AuthenticatedActor = Object.freeze({
  accountId: '101',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-buyer-101',
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

// ---------------------------------------------------------------------------
// Fixtures & In-Memory Stores
// ---------------------------------------------------------------------------
const BASE_NOW = new Date('2026-11-10T09:00:00.000Z');
const BIDDING_DEADLINE = new Date('2026-11-12T17:00:00.000Z');
const DELIVERY_DEADLINE = new Date('2026-12-01T17:00:00.000Z');
const COMMITTED_DELIVERY = new Date('2026-11-28T17:00:00.000Z');

function createSampleRequest(
  overrides: Partial<Parameters<typeof QuoteRequest.reconstitute>[0]> = {},
): QuoteRequest {
  return QuoteRequest.reconstitute({
    id: '10001',
    buyer_id: '101',
    category_id: '11',
    spec: '3.000 cốc gốm men trắng dung tích 300ml',
    quantity: 3000,
    unit: 'piece',
    unit_set_description: null,
    status: 'in_production',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Gia Lâm, Hà Nội',
    delivery_address: 'Số 10 Bát Tràng, Gia Lâm, Hà Nội',
    recipient_name: 'Nguyễn Văn An',
    recipient_phone: '0912345678',
    bidding_deadline: BIDDING_DEADLINE,
    delivery_deadline: DELIVERY_DEADLINE,
    bidding_closed_at: new Date('2026-11-10T08:00:00.000Z'),
    version: 7,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: new Date('2026-11-08T08:00:00.000Z'),
    updated_at: new Date('2026-11-10T09:00:00.000Z'),
    ...overrides,
  });
}

function createSampleAllocation(
  overrides: Partial<Parameters<typeof Allocation.reconstitute>[0]> = {},
): Allocation {
  return Allocation.reconstitute({
    id: '12001',
    request_id: '10001',
    workshop_id: '301',
    quote_id: '401',
    quantity: 3000,
    unit_price: 45000,
    committed_delivery_at: COMMITTED_DELIVERY,
    status: 'in_production',
    version: 2,
    started_at: new Date('2026-11-10T09:00:00.000Z'),
    started_by: '201',
    handed_over_at: null,
    handed_over_by: null,
    delivery_note: null,
    admin_handed_over: false,
    admin_delivery_evidence: null,
    admin_handover_reason: null,
    admin_handover_actual_at: null,
    created_at: new Date('2026-11-10T08:30:00.000Z'),
    updated_at: new Date('2026-11-10T09:00:00.000Z'),
    batch_links: [],
    ...overrides,
  });
}

describe('Task 32 (UC-23, BR-24): PUT /api/v1/artisan/allocations/:id/batches', () => {
  // =========================================================================
  // Suite A: LinkAllocationBatchesUseCase & LinkBatchesWorkflow Unit Tests
  // =========================================================================
  describe('Suite A: LinkAllocationBatchesUseCase Unit Tests', () => {
    let txRunner: MockTransactionRunner;
    let traceabilityContract: MockTraceabilityContract;
    let workshopContract: MockWorkshopContract;
    let allocationStore: Map<string, Allocation>;
    let requestStore: Map<string, QuoteRequest>;
    let batchStatusStore: Map<
      string,
      {
        readonly id: string;
        readonly workshopId: string;
        readonly name: string;
        readonly status: 'draft' | 'published';
        readonly traceUrl: string | null;
      }
    >;
    let savedAllocationLogs: AllocationLogRecord[];
    let savedBatchLinks: AllocationBatchLink[];

    let mockAllocationRepo: {
      findById: ReturnType<typeof vi.fn>;
      lockById: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      findDetailById: ReturnType<typeof vi.fn>;
    };
    let mockAllocationBatchRepo: {
      replaceForAllocation: ReturnType<typeof vi.fn>;
    };
    let mockQuoteRequestRepo: {
      findById: ReturnType<typeof vi.fn>;
      lockById: ReturnType<typeof vi.fn>;
    };
    let useCase: LinkAllocationBatchesUseCase;

    beforeEach(() => {
      vi.clearAllMocks();
      txRunner = new MockTransactionRunner();
      traceabilityContract = new MockTraceabilityContract();
      workshopContract = new MockWorkshopContract();
      workshopContract.givenActiveWorkshops('301', '302');
      workshopContract.getWorkshopSummary.mockImplementation(
        async (wsId: string) => ({
          id: wsId,
          name:
            wsId === '301'
              ? 'Xưởng gốm mẫu Bát Tràng'
              : 'Xưởng Gốm Minh Châu',
          status: 'active',
          isProfilePublic: true,
        }),
      );

      batchStatusStore = new Map([
        [
          '901',
          {
            id: '901',
            workshopId: '301',
            name: 'Lô 901 đã công bố',
            status: 'published',
            traceUrl: '/api/v1/trace/demo-bat-trang-901',
          },
        ],
        [
          '902',
          {
            id: '902',
            workshopId: '301',
            name: 'Lô 902 đã công bố',
            status: 'published',
            traceUrl: '/api/v1/trace/demo-bat-trang-902',
          },
        ],
        [
          '903',
          {
            id: '903',
            workshopId: '301',
            name: 'Lô 903 còn nháp',
            status: 'draft',
            traceUrl: null,
          },
        ],
        [
          '999',
          {
            id: '999',
            workshopId: '302',
            name: 'Lô 999 của xưởng khác',
            status: 'published',
            traceUrl: '/api/v1/trace/other-999',
          },
        ],
      ]);

      traceabilityContract.assertOwnedBatches.mockImplementation(
        async ({ batchIds, workshopId }) => {
          const results: Array<{
            id: string;
            name: string;
            status: 'draft' | 'published';
            traceUrl: string | null;
          }> = [];
          for (const batchId of batchIds) {
            const batch = batchStatusStore.get(batchId);
            if (!batch || batch.workshopId !== workshopId) {
              throw new BusinessRuleException('RESOURCE_NOT_FOUND');
            }
            results.push({
              id: batch.id,
              name: batch.name,
              status: batch.status,
              traceUrl: batch.traceUrl,
            });
          }
          return results;
        },
      );

      allocationStore = new Map([['12001', createSampleAllocation()]]);
      requestStore = new Map([['10001', createSampleRequest()]]);
      savedAllocationLogs = [];
      savedBatchLinks = [];

      mockAllocationBatchRepo = {
        replaceForAllocation: vi.fn(
          async (input: {
            allocationId: string;
            workshopId: string;
            links: readonly AllocationBatchLink[];
          }) => {
            savedBatchLinks = [...input.links];
            return savedBatchLinks;
          },
        ),
      };

      mockAllocationRepo = {
        findById: vi.fn(async (id: string) => allocationStore.get(id) ?? null),
        lockById: vi.fn(async (id: string) => allocationStore.get(id) ?? null),
        update: vi.fn(
          async (input: {
            allocation: Allocation;
            expectedVersion?: number;
            logs?: readonly AllocationLogRecord[];
            syncBatchLinks?: boolean;
          }) => {
            const current = allocationStore.get(input.allocation.id);
            if (!current || current.version !== input.expectedVersion) {
              throw new ConcurrencyConflictError('Allocation version mismatch.');
            }
            allocationStore.set(input.allocation.id, input.allocation);
            if (input.syncBatchLinks) {
              savedBatchLinks = [...input.allocation.batch_links];
            }
            if (input.logs) {
              savedAllocationLogs.push(...input.logs);
            }
            return input.allocation;
          },
        ),
        findDetailById: vi.fn(async (id: string) => {
          const alloc = allocationStore.get(id);
          if (!alloc) return null;
          const req = requestStore.get(alloc.request_id)!;
          const publishedIds = new Set<string>();
          for (const link of alloc.batch_links) {
            if (batchStatusStore.get(link.batch_id)?.status === 'published') {
              publishedIds.add(link.batch_id);
            }
          }
          return {
            allocation: AllocationMapper.toDto(alloc, {
              workshop: {
                id: alloc.workshop_id,
                name: 'Xưởng gốm mẫu Bát Tràng',
              },
              startedByActor: alloc.started_by
                ? { id: alloc.started_by, display_name: null }
                : null,
              handedOverByActor: null,
              publishedBatchIds: publishedIds,
            }),
            requestBuyerId: req.buyer_id,
            recipientName: req.recipient_name,
            recipientPhone: req.recipient_phone,
            deliveryAddress: req.delivery_address,
          };
        }),
      };

      mockQuoteRequestRepo = {
        findById: vi.fn(async (id: string) => requestStore.get(id) ?? null),
        lockById: vi.fn(async (id: string) => requestStore.get(id) ?? null),
      };

      useCase = new LinkAllocationBatchesUseCase(
        txRunner,
        mockAllocationRepo as unknown as IAllocationRepository,
        mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
        traceabilityContract,
        mockAllocationBatchRepo as unknown as IAllocationBatchRepository,
        workshopContract,
      );
    });

    it('links published batches covering 100% quantity, clears traceability_warning to null, bumps allocation version, and enforces lock order', async () => {
      const result = await useCase.execute({
        actor: owningArtisanActor,
        allocationId: '12001',
        expectedAllocationVersion: 2,
        links: [
          { batch_id: '901', linked_quantity: 2000 },
          { batch_id: '902', linked_quantity: 1000 },
        ],
        now: BASE_NOW,
      });

      expect(result.allocation).toEqual({
        id: '12001',
        request_id: '10001',
        workshop: { id: '301', name: 'Xưởng gốm mẫu Bát Tràng' },
        quote_id: '401',
        quantity: 3000,
        unit_price: 45000,
        committed_delivery_at: COMMITTED_DELIVERY.toISOString(),
        status: 'in_production',
        version: 3,
        started_at: BASE_NOW.toISOString(),
        started_by: { id: '201', display_name: null },
        handed_over_at: null,
        handed_over_by: null,
        delivery_note: null,
        admin_handed_over: false,
        admin_handover_reason: null,
        admin_delivery_evidence: null,
        admin_handover_actual_at: null,
        traceability_warning: null,
      });

      expect(result.currentState).toEqual({
        request: {
          id: '10001',
          status: 'in_production',
          version: 7,
          cancelled_at: null,
        },
        allocation: {
          id: '12001',
          status: 'in_production',
          version: 3,
        },
      });

      expect(savedBatchLinks).toHaveLength(2);
      expect(savedBatchLinks.map((l) => ({
        batch_id: l.batch_id,
        linked_quantity: l.linked_quantity,
        workshop_id: l.workshop_id,
        allocation_id: l.allocation_id,
        linked_by: l.linked_by,
      }))).toEqual([
        {
          batch_id: '901',
          linked_quantity: 2000,
          workshop_id: '301',
          allocation_id: '12001',
          linked_by: '201',
        },
        {
          batch_id: '902',
          linked_quantity: 1000,
          workshop_id: '301',
          allocation_id: '12001',
          linked_by: '201',
        },
      ]);

      expect(savedAllocationLogs).toHaveLength(1);
      expect(savedAllocationLogs[0]).toMatchObject({
        allocation_id: '12001',
        event_type: 'batch_links_changed',
        prev_status: 'in_production',
        new_status: 'in_production',
        performed_by: '201',
        is_admin_action: false,
        created_at: BASE_NOW,
      });

      // Mandatory lock ordering: QuoteRequest -> Allocation -> Traceability.assertOwnedBatches
      const reqLockOrder =
        mockQuoteRequestRepo.lockById.mock.invocationCallOrder[0];
      const allocLockOrder =
        mockAllocationRepo.lockById.mock.invocationCallOrder[0];
      const traceOrder =
        traceabilityContract.assertOwnedBatches.mock.invocationCallOrder[0];
      expect(reqLockOrder).toBeLessThan(allocLockOrder);
      expect(allocLockOrder).toBeLessThan(traceOrder);
    });

    it('warns INCOMPLETE_TRACEABILITY without blocking save when a linked batch is still in draft status (UC-23, BR-24)', async () => {
      const result = await useCase.execute({
        actor: owningArtisanActor,
        allocationId: '12001',
        expectedAllocationVersion: 2,
        links: [
          { batch_id: '901', linked_quantity: 2000 },
          { batch_id: '903', linked_quantity: 1000 }, // 903 is draft
        ],
        now: BASE_NOW,
      });

      expect(result.allocation.version).toBe(3);
      expect(result.allocation.traceability_warning).toBe(
        'INCOMPLETE_TRACEABILITY',
      );
      expect(savedBatchLinks).toHaveLength(2);
    });

    it('warns INCOMPLETE_TRACEABILITY when total linked_quantity is less than allocation.quantity (UC-23, BR-24)', async () => {
      const result = await useCase.execute({
        actor: owningArtisanActor,
        allocationId: '12001',
        expectedAllocationVersion: 2,
        links: [{ batch_id: '901', linked_quantity: 2500 }],
        now: BASE_NOW,
      });

      expect(result.allocation.version).toBe(3);
      expect(result.allocation.traceability_warning).toBe(
        'INCOMPLETE_TRACEABILITY',
      );
      expect(savedBatchLinks).toHaveLength(1);
    });

    it('clears all batch links when links is empty [] and returns NO_BATCH_LINK warning (api-design.md §9.6)', async () => {
      // Pre-populate with existing batch link
      allocationStore.set(
        '12001',
        createSampleAllocation({
          version: 2,
          batch_links: [
            AllocationBatchLink.reconstitute({
              workshop_id: '301',
              allocation_id: '12001',
              batch_id: '901',
              linked_quantity: 3000,
              linked_at: BASE_NOW,
              linked_by: '201',
            }),
          ],
        }),
      );

      const result = await useCase.execute({
        actor: owningArtisanActor,
        allocationId: '12001',
        expectedAllocationVersion: 2,
        links: [],
        now: BASE_NOW,
      });

      expect(result.allocation.version).toBe(3);
      expect(result.allocation.traceability_warning).toBe('NO_BATCH_LINK');
      expect(savedBatchLinks).toHaveLength(0);
      expect(traceabilityContract.assertOwnedBatches).not.toHaveBeenCalled();
    });

    it('allows a suspended workshop to link batches to its awarded Allocation (BR-05)', async () => {
      workshopContract.givenSuspended('301');

      const result = await useCase.execute({
        actor: owningArtisanActor,
        allocationId: '12001',
        expectedAllocationVersion: 2,
        links: [{ batch_id: '901', linked_quantity: 3000 }],
        now: BASE_NOW,
      });

      expect(result.allocation.version).toBe(3);
      expect(result.allocation.traceability_warning).toBeNull();
      expect(workshopContract.lockAndAssertActive).not.toHaveBeenCalled();
    });

    it('rejects when total linked_quantity exceeds allocation.quantity (InvalidTradingInputError -> 400 INVALID_INPUT)', async () => {
      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 2,
          links: [
            { batch_id: '901', linked_quantity: 2000 },
            { batch_id: '902', linked_quantity: 1001 },
          ],
          now: BASE_NOW,
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
      expect(
        mockAllocationBatchRepo.replaceForAllocation,
      ).not.toHaveBeenCalled();
    });

    it('rejects duplicate batch_id in links array (InvalidTradingInputError -> 400 INVALID_INPUT)', async () => {
      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 2,
          links: [
            { batch_id: '901', linked_quantity: 1000 },
            { batch_id: '901', linked_quantity: 1000 },
          ],
          now: BASE_NOW,
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
    });

    it('rejects when a batch belongs to another workshop or does not exist (RESOURCE_NOT_FOUND -> 404)', async () => {
      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 2,
          links: [{ batch_id: '999', linked_quantity: 1000 }],
          now: BASE_NOW,
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
    });

    it('rejects with TradingResourceNotFoundError if Traceability returns partial batch results', async () => {
      traceabilityContract.assertOwnedBatches.mockResolvedValueOnce([]);

      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 2,
          links: [{ batch_id: '901', linked_quantity: 1000 }],
          now: BASE_NOW,
        }),
      ).rejects.toThrow(TradingResourceNotFoundError);
    });

    it.each<AllocationStatus>(['not_started', 'handed_over'])(
      'throws InvalidStateTransitionError (422 INVALID_STATE) when Allocation status is %s',
      async (status) => {
        allocationStore.set(
          '12001',
          createSampleAllocation({
            status,
            version: 2,
            ...(status === 'not_started'
              ? { started_at: null, started_by: null }
              : { handed_over_at: BASE_NOW, handed_over_by: '201' }),
          }),
        );

        await expect(
          useCase.execute({
            actor: owningArtisanActor,
            allocationId: '12001',
            expectedAllocationVersion: 2,
            links: [{ batch_id: '901', linked_quantity: 1000 }],
          }),
        ).rejects.toThrow(InvalidStateTransitionError);

        expect(mockAllocationRepo.update).not.toHaveBeenCalled();
      },
    );

    it('throws InvalidStateTransitionError when QuoteRequest is cancelled', async () => {
      requestStore.set(
        '10001',
        createSampleRequest({
          cancelled_at: new Date('2026-11-10T09:00:00.000Z'),
          cancelled_by: '1',
          cancel_reason: 'Hủy bởi Admin',
        }),
      );

      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 2,
          links: [{ batch_id: '901', linked_quantity: 1000 }],
        }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it.each<RequestStatus>([
      'draft_request',
      'sent_to_artisans',
      'artisans_bidding',
      'delivered',
    ])(
      'throws InvalidStateTransitionError when QuoteRequest status is %s',
      async (status) => {
        requestStore.set('10001', createSampleRequest({ status }));

        await expect(
          useCase.execute({
            actor: owningArtisanActor,
            allocationId: '12001',
            expectedAllocationVersion: 2,
            links: [{ batch_id: '901', linked_quantity: 1000 }],
          }),
        ).rejects.toThrow(InvalidStateTransitionError);
      },
    );

    it('throws ConcurrencyConflictError (409) when expected_allocation_version is stale', async () => {
      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 1, // current is 2
          links: [{ batch_id: '901', linked_quantity: 1000 }],
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
    });

    it('throws AllocationNotFoundError (404 anti-IDOR) when another Artisan attempts to link batches on an Allocation they do not own', async () => {
      await expect(
        useCase.execute({
          actor: secondArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 2,
          links: [{ batch_id: '999', linked_quantity: 1000 }],
        }),
      ).rejects.toThrow(AllocationNotFoundError);

      expect(mockQuoteRequestRepo.lockById).not.toHaveBeenCalled();
      expect(mockAllocationRepo.lockById).not.toHaveBeenCalled();
      expect(traceabilityContract.assertOwnedBatches).not.toHaveBeenCalled();
    });

    it('throws QuoteRequestNotFoundError if parent QuoteRequest disappears before locking', async () => {
      requestStore.delete('10001');

      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 2,
          links: [{ batch_id: '901', linked_quantity: 1000 }],
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);
    });

    it('throws TEMP_PASSWORD_RESTRICTED for temp_password session without querying repository', async () => {
      await expect(
        useCase.execute({
          actor: tempPasswordArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 2,
          links: [],
        }),
      ).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });

      expect(mockAllocationRepo.findById).not.toHaveBeenCalled();
    });

    it('throws TradingPermissionDeniedError for buyer, admin, or artisan without workshopId', async () => {
      for (const actor of [
        buyerActor,
        adminActor,
        artisanWithoutWorkshopActor,
      ]) {
        await expect(
          useCase.execute({
            actor,
            allocationId: '12001',
            expectedAllocationVersion: 2,
            links: [],
          }),
        ).rejects.toThrow(TradingPermissionDeniedError);
      }

      expect(mockAllocationRepo.findById).not.toHaveBeenCalled();
    });

    it('reuses caller-supplied TransactionContext without opening a nested transaction', async () => {
      const runSpy = vi.spyOn(txRunner, 'run');
      const externalTx = { txId: 'ext-tx-32' } as unknown as TransactionContext;

      const result = await useCase.execute({
        actor: owningArtisanActor,
        allocationId: '12001',
        expectedAllocationVersion: 2,
        links: [{ batch_id: '901', linked_quantity: 3000 }],
        now: BASE_NOW,
        tx: externalTx,
      });

      expect(result.allocation.version).toBe(3);
      expect(runSpy).not.toHaveBeenCalled();
      expect(traceabilityContract.assertOwnedBatches).toHaveBeenCalledWith(
        { batchIds: ['901'], workshopId: '301' },
        externalTx,
      );
    });

    it('falls back gracefully to WorkshopContract summary and syncBatchLinks when findDetailById returns null and allocationBatchRepo is omitted', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(null);
      const useCaseWithoutBatchRepo = new LinkAllocationBatchesUseCase(
        txRunner,
        mockAllocationRepo as unknown as IAllocationRepository,
        mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
        traceabilityContract,
        undefined,
        workshopContract,
      );

      const result = await useCaseWithoutBatchRepo.execute({
        actor: owningArtisanActor,
        allocationId: '12001',
        expectedAllocationVersion: 2,
        links: [{ batch_id: '903', linked_quantity: 1000 }],
        now: BASE_NOW,
      });

      expect(result.allocation.workshop).toEqual({
        id: '301',
        name: 'Xưởng gốm mẫu Bát Tràng',
      });
      expect(result.allocation.traceability_warning).toBe(
        'INCOMPLETE_TRACEABILITY',
      );
      expect(mockAllocationRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ syncBatchLinks: true }),
        expect.anything(),
      );
    });
  });

  // =========================================================================
  // Suite B: DTO Schema, Controller Metadata & Swagger OpenAPI Document
  // =========================================================================
  describe('Suite B: DTO Schema, Controller Metadata & Swagger OpenAPI Document', () => {
    it('validates LinkAllocationBatchesDto strictly and rejects extra or invalid fields', () => {
      expect(
        linkAllocationBatchesSchema.parse({
          expected_allocation_version: 2,
          links: [
            { batch_id: '901', linked_quantity: 2000 },
            { batch_id: '902', linked_quantity: 1000 },
          ],
        }),
      ).toEqual({
        expected_allocation_version: 2,
        links: [
          { batch_id: '901', linked_quantity: 2000 },
          { batch_id: '902', linked_quantity: 1000 },
        ],
      });

      expect(
        linkAllocationBatchesSchema.parse({
          expected_allocation_version: 2,
          links: [],
        }),
      ).toEqual({
        expected_allocation_version: 2,
        links: [],
      });

      expect(() => linkAllocationBatchesSchema.parse({})).toThrow();
      expect(() =>
        linkAllocationBatchesSchema.parse({
          expected_allocation_version: 0,
          links: [],
        }),
      ).toThrow();
      expect(() =>
        linkAllocationBatchesSchema.parse({
          expected_allocation_version: 2,
          links: [{ batch_id: '0', linked_quantity: 100 }],
        }),
      ).toThrow();
      expect(() =>
        linkAllocationBatchesSchema.parse({
          expected_allocation_version: 2,
          links: [{ batch_id: '901', linked_quantity: 0 }],
        }),
      ).toThrow();
      expect(() =>
        linkAllocationBatchesSchema.parse({
          expected_allocation_version: 2,
          links: [{ batch_id: '901', linked_quantity: 100, extra: true }],
        }),
      ).toThrow();
      expect(() =>
        linkAllocationBatchesSchema.parse({
          expected_allocation_version: 2,
          links: [],
          status: 'handed_over',
        }),
      ).toThrow();
    });

    it('verifies ArtisanAllocationController metadata and TradingModule exports', () => {
      expect(
        Reflect.getMetadata(PATH_METADATA, ArtisanAllocationController),
      ).toBe('artisan/allocations');
      expect(
        Reflect.getMetadata(ACCESS_POLICY, ArtisanAllocationController),
      ).toEqual({ kind: 'roles', roles: ['artisan'] });
      expect(
        Reflect.getMetadata(SESSION_LEVELS, ArtisanAllocationController),
      ).toEqual(['normal']);

      const proto = ArtisanAllocationController.prototype;
      const mutationMeta = Reflect.getMetadata(
        TRADING_MUTATION_METADATA_KEY,
        proto.linkBatches,
      );
      expect(mutationMeta).toEqual({
        action: 'link_batches',
        objectType: 'Allocation',
        objectIdParam: 'id',
        expectedVersionField: 'expected_allocation_version',
      });

      const paramTypes = Reflect.getMetadata(
        'design:paramtypes',
        proto,
        'linkBatches',
      );
      expect(paramTypes).toBeDefined();
      expect(paramTypes).toHaveLength(4);
      expect(paramTypes[2]).toBe(LinkAllocationBatchesDto);

      const moduleExports = Reflect.getMetadata(
        'exports',
        TradingModule,
      ) as unknown[];
      expect(moduleExports).toContain(LinkAllocationBatchesUseCase);
    });
  });

  // =========================================================================
  // Suite C: HTTP Controller + TradingMutationInterceptor + Idempotency
  // =========================================================================
  describe('Suite C: HTTP Controller + TradingMutationInterceptor + Idempotency', () => {
    const identityMock = new MockIdentityContract();
    const txRunner = new MockTransactionRunner();
    const traceabilityContract = new MockTraceabilityContract();
    const workshopContract = new MockWorkshopContract();

    let allocationStore: Map<string, Allocation>;
    let requestStore: Map<string, QuoteRequest>;
    let idempotencyStore: Map<string, PersistedIdempotencyRecord<unknown>>;
    let nextIdempotencyId: bigint;

    const batchStatusStore = new Map<
      string,
      {
        readonly id: string;
        readonly workshopId: string;
        readonly name: string;
        readonly status: 'draft' | 'published';
        readonly traceUrl: string | null;
      }
    >([
      [
        '901',
        {
          id: '901',
          workshopId: '301',
          name: 'Lô cốc mẫu 901',
          status: 'published',
          traceUrl: '/api/v1/trace/demo-bat-trang-901',
        },
      ],
      [
        '902',
        {
          id: '902',
          workshopId: '301',
          name: 'Lô cốc mẫu 902',
          status: 'published',
          traceUrl: '/api/v1/trace/demo-bat-trang-902',
        },
      ],
      [
        '903',
        {
          id: '903',
          workshopId: '301',
          name: 'Lô cốc nháp 903',
          status: 'draft',
          traceUrl: null,
        },
      ],
      [
        '999',
        {
          id: '999',
          workshopId: '302',
          name: 'Lô xưởng khác 999',
          status: 'published',
          traceUrl: '/api/v1/trace/other-999',
        },
      ],
    ]);

    const mockAllocationBatchRepo = {
      replaceForAllocation: vi.fn(
        async (input: {
          allocationId: string;
          workshopId: string;
          links: readonly AllocationBatchLink[];
        }) => input.links,
      ),
    };

    const mockAllocationRepo = {
      findById: vi.fn(async (id: string) => allocationStore.get(id) ?? null),
      lockById: vi.fn(async (id: string) => allocationStore.get(id) ?? null),
      findArtisanAllocations: vi.fn(async () => ({ rows: [], totalRecords: 0 })),
      update: vi.fn(
        async (input: {
          allocation: Allocation;
          expectedVersion?: number;
        }) => {
          const current = allocationStore.get(input.allocation.id);
          if (!current || current.version !== input.expectedVersion) {
            throw new ConcurrencyConflictError('Allocation version conflict.');
          }
          allocationStore.set(input.allocation.id, input.allocation);
          return input.allocation;
        },
      ),
      findDetailById: vi.fn(async (id: string) => {
        const alloc = allocationStore.get(id);
        if (!alloc) return null;
        const req = requestStore.get(alloc.request_id)!;
        const publishedIds = new Set<string>();
        for (const link of alloc.batch_links) {
          if (batchStatusStore.get(link.batch_id)?.status === 'published') {
            publishedIds.add(link.batch_id);
          }
        }
        return {
          allocation: AllocationMapper.toDto(alloc, {
            workshop: {
              id: alloc.workshop_id,
              name: 'Xưởng gốm mẫu Bát Tràng',
            },
            startedByActor: alloc.started_by
              ? { id: alloc.started_by, display_name: null }
              : null,
            handedOverByActor: null,
            publishedBatchIds: publishedIds,
          }),
          requestBuyerId: req.buyer_id,
          recipientName: req.recipient_name,
          recipientPhone: req.recipient_phone,
          deliveryAddress: req.delivery_address,
        };
      }),
    };

    const mockQuoteRequestRepo = {
      findById: vi.fn(async (id: string) => requestStore.get(id) ?? null),
      lockById: vi.fn(async (id: string) => requestStore.get(id) ?? null),
    };

    const makeScopeKey = (s: IdempotencyScopeKey) =>
      `${s.account_id}::${s.action}::${s.object_type}::${s.object_id}::${s.idempotency_key}`;

    const mockIdempotencyRepo: IIdempotencyRecordRepository = {
      findByScope: vi.fn(async (scope: IdempotencyScopeKey) => {
        return (
          (idempotencyStore.get(
            makeScopeKey(scope),
          ) as PersistedIdempotencyRecord<any>) ?? null
        );
      }),
      findAndVerifyReplay: vi.fn(async (input) => {
        const rec = idempotencyStore.get(makeScopeKey(input));
        if (!rec || rec.request_fingerprint !== input.request_fingerprint) {
          return null;
        }
        return rec as PersistedIdempotencyRecord<any>;
      }),
      save: vi.fn(async (input: CreateIdempotencyRecordInput<unknown>) => {
        const key = makeScopeKey(input);
        if (idempotencyStore.has(key)) {
          const err = new Error('Unique constraint violation') as Error & {
            code: string;
          };
          err.code = 'P2002';
          throw err;
        }
        const record: PersistedIdempotencyRecord<unknown> = {
          id: String(nextIdempotencyId++),
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
        idempotencyStore.set(key, record);
        return record as PersistedIdempotencyRecord<any>;
      }),
      deleteExpiredBefore: vi.fn(async () => 0),
    };

    let app: NestExpressApplication;
    let base: string;

    class TestIdentityModule {}
    Module({
      providers: [{ provide: IDENTITY_CONTRACT, useValue: identityMock }],
      exports: [IDENTITY_CONTRACT],
    })(TestIdentityModule);

    class TestAppModule {}
    Module({
      imports: [AppConfigModule, SecurityModule.register([TestIdentityModule])],
      controllers: [ArtisanAllocationController],
      providers: [
        { provide: TRANSACTION_RUNNER, useValue: txRunner },
        { provide: ALLOCATION_REPOSITORY, useValue: mockAllocationRepo },
        {
          provide: ALLOCATION_BATCH_REPOSITORY,
          useValue: mockAllocationBatchRepo,
        },
        { provide: QUOTE_REQUEST_REPOSITORY, useValue: mockQuoteRequestRepo },
        { provide: QUOTE_REPOSITORY, useValue: {} },
        { provide: REQUEST_RECIPIENT_REPOSITORY, useValue: {} },
        {
          provide: IDEMPOTENCY_RECORD_REPOSITORY,
          useValue: mockIdempotencyRepo,
        },
        { provide: TRACEABILITY_CONTRACT, useValue: traceabilityContract },
        { provide: WORKSHOP_CONTRACT, useValue: workshopContract },
        {
          provide: TradingIdempotencyService,
          useFactory: (
            repo: IIdempotencyRecordRepository,
            tr: TransactionRunner,
          ) => new TradingIdempotencyService(repo, tr),
          inject: [IDEMPOTENCY_RECORD_REPOSITORY, TRANSACTION_RUNNER],
        },
        {
          provide: TRADING_CURRENT_STATE_RESOLVER,
          useFactory: (
            qrRepo: IQuoteRequestRepository,
            allocRepo: IAllocationRepository,
          ) =>
            new TradingCurrentStateResolver(
              qrRepo,
              allocRepo,
              {} as any,
              {} as any,
            ),
          inject: [QUOTE_REQUEST_REPOSITORY, ALLOCATION_REPOSITORY],
        },
        TradingMutationInterceptor,
        {
          provide: ListArtisanAllocationsUseCase,
          useFactory: (
            tr: TransactionRunner,
            allocRepo: IAllocationRepository,
          ) => new ListArtisanAllocationsUseCase(tr, allocRepo),
          inject: [TRANSACTION_RUNNER, ALLOCATION_REPOSITORY],
        },
        {
          provide: StartAllocationProductionUseCase,
          useFactory: (
            tr: TransactionRunner,
            allocRepo: IAllocationRepository,
            qrRepo: IQuoteRequestRepository,
            wc: IWorkshopContract,
          ) => new StartAllocationProductionUseCase(tr, allocRepo, qrRepo, wc),
          inject: [
            TRANSACTION_RUNNER,
            ALLOCATION_REPOSITORY,
            QUOTE_REQUEST_REPOSITORY,
            WORKSHOP_CONTRACT,
          ],
        },
        {
          provide: LinkAllocationBatchesUseCase,
          useFactory: (
            tr: TransactionRunner,
            allocRepo: IAllocationRepository,
            qrRepo: IQuoteRequestRepository,
            tc: ITraceabilityContract,
            abRepo: IAllocationBatchRepository,
            wc: IWorkshopContract,
          ) =>
            new LinkAllocationBatchesUseCase(
              tr,
              allocRepo,
              qrRepo,
              tc,
              abRepo,
              wc,
            ),
          inject: [
            TRANSACTION_RUNNER,
            ALLOCATION_REPOSITORY,
            QUOTE_REQUEST_REPOSITORY,
            TRACEABILITY_CONTRACT,
            ALLOCATION_BATCH_REPOSITORY,
            WORKSHOP_CONTRACT,
          ],
        },
      ],
    })(TestAppModule);

    beforeAll(async () => {
      vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/test');
      vi.stubEnv(
        'SESSION_SECRET',
        'test_secret_32_chars_for_development_purposes',
      );
      vi.stubEnv('NODE_ENV', 'development');

      app = await NestFactory.create<NestExpressApplication>(TestAppModule, {
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

    beforeEach(() => {
      vi.clearAllMocks();
      allocationStore = new Map([['12001', createSampleAllocation()]]);
      requestStore = new Map([['10001', createSampleRequest()]]);
      idempotencyStore = new Map();
      nextIdempotencyId = 19001n;

      workshopContract.givenActiveWorkshops('301', '302');
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '301',
        name: 'Xưởng gốm mẫu Bát Tràng',
        status: 'active',
        isProfilePublic: true,
      });

      traceabilityContract.assertOwnedBatches.mockImplementation(
        async ({ batchIds, workshopId }) => {
          const results: Array<{
            id: string;
            name: string;
            status: 'draft' | 'published';
            traceUrl: string | null;
          }> = [];
          for (const batchId of batchIds) {
            const batch = batchStatusStore.get(batchId);
            if (!batch || batch.workshopId !== workshopId) {
              throw new BusinessRuleException('RESOURCE_NOT_FOUND');
            }
            results.push({
              id: batch.id,
              name: batch.name,
              status: batch.status,
              traceUrl: batch.traceUrl,
            });
          }
          return results;
        },
      );

      identityMock.resolveSession.mockImplementation(async (token: string) => {
        if (token === 'session-artisan-301') return owningArtisanActor;
        if (token === 'session-artisan-302') return secondArtisanActor;
        if (token === 'session-artisan-no-ws')
          return artisanWithoutWorkshopActor;
        if (token === 'session-temp-artisan') return tempPasswordArtisanActor;
        if (token === 'session-buyer-101') return buyerActor;
        if (token === 'session-admin-1') return adminActor;
        return null;
      });
    });

    it('documents PUT /api/v1/artisan/allocations/{id}/batches in OpenAPI Swagger doc', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const endpoint = doc.paths?.['/api/v1/artisan/allocations/{id}/batches'];
      expect(endpoint?.put).toBeDefined();
      expect(endpoint?.put?.tags).toContain('trading');
      expect(endpoint?.put?.parameters).toContainEqual(
        expect.objectContaining({
          name: 'X-Idempotency-Key',
          in: 'header',
          required: true,
        }),
      );
      expect(endpoint?.put?.responses?.['200']).toBeDefined();
    });

    it('PUT /artisan/allocations/:id/batches returns 200 OK matching link-batches fixture contract', async () => {
      const idempotencyKey = 'b85ebf30-2f70-47bb-8d08-46ccf22d3414';
      const res = await fetch(`${base}/artisan/allocations/12001/batches`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-301',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          expected_allocation_version: 2,
          links: [{ batch_id: '901', linked_quantity: 3000 }],
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(allocationDtoResponseSchema.parse(json.data)).toEqual(json.data);
      expect(json.data).toMatchObject({
        id: '12001',
        request_id: '10001',
        workshop: {
          id: '301',
          name: 'Xưởng gốm mẫu Bát Tràng',
        },
        quote_id: '401',
        quantity: 3000,
        unit_price: 45000,
        status: 'in_production',
        version: 3,
        traceability_warning: null,
      });

      expect(
        linkAllocationBatchesOperationResponseSchema.parse(json.operation),
      ).toEqual(json.operation);
      expect(json.operation.replayed).toBe(false);
      expect(json.operation.current_state).toEqual({
        request: {
          id: '10001',
          status: 'in_production',
          version: 7,
          cancelled_at: null,
        },
        allocation: {
          id: '12001',
          status: 'in_production',
          version: 3,
        },
      });
    });

    it('returns traceability_warning: INCOMPLETE_TRACEABILITY when linking a draft batch over HTTP without blocking save', async () => {
      const res = await fetch(`${base}/artisan/allocations/12001/batches`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-301',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          expected_allocation_version: 2,
          links: [
            { batch_id: '901', linked_quantity: 2000 },
            { batch_id: '903', linked_quantity: 1000 },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.version).toBe(3);
      expect(json.data.traceability_warning).toBe('INCOMPLETE_TRACEABILITY');
    });

    it('replays identical X-Idempotency-Key + payload without re-executing mutation and returns fresh current_state', async () => {
      const idempotencyKey = randomUUID();
      const payload = {
        expected_allocation_version: 2,
        links: [{ batch_id: '901', linked_quantity: 3000 }],
      };

      const firstRes = await fetch(
        `${base}/artisan/allocations/12001/batches`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-artisan-301',
            'X-Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(payload),
        },
      );
      expect(firstRes.status).toBe(200);
      const firstJson = await firstRes.json();
      expect(firstJson.operation.replayed).toBe(false);

      // Simulate later handover (status: handed_over, version: 4) before replay
      allocationStore.set(
        '12001',
        createSampleAllocation({
          status: 'handed_over',
          version: 4,
          handed_over_at: BASE_NOW,
          handed_over_by: '201',
        }),
      );
      mockAllocationRepo.update.mockClear();
      traceabilityContract.assertOwnedBatches.mockClear();

      const replayRes = await fetch(
        `${base}/artisan/allocations/12001/batches`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-artisan-301',
            'X-Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(payload),
        },
      );
      expect(replayRes.status).toBe(200);
      const replayJson = await replayRes.json();

      expect(replayJson.data).toEqual(firstJson.data);
      expect(replayJson.operation.id).toBe(firstJson.operation.id);
      expect(replayJson.operation.replayed).toBe(true);
      expect(replayJson.operation.current_state.allocation).toEqual({
        id: '12001',
        status: 'handed_over',
        version: 4,
      });
      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
      expect(traceabilityContract.assertOwnedBatches).not.toHaveBeenCalled();
    });

    it('returns 409 IDEMPOTENCY_CONFLICT when reusing X-Idempotency-Key with different payload', async () => {
      const idempotencyKey = randomUUID();
      const res1 = await fetch(`${base}/artisan/allocations/12001/batches`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-301',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          expected_allocation_version: 2,
          links: [{ batch_id: '901', linked_quantity: 2000 }],
        }),
      });
      expect(res1.status).toBe(200);

      const res2 = await fetch(`${base}/artisan/allocations/12001/batches`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-301',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          expected_allocation_version: 2,
          links: [{ batch_id: '901', linked_quantity: 3000 }],
        }),
      });
      expect(res2.status).toBe(409);
      const json2 = await res2.json();
      expect(json2.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('returns 409 CONCURRENCY_CONFLICT when expected_allocation_version does not match', async () => {
      const res = await fetch(`${base}/artisan/allocations/12001/batches`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-301',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          expected_allocation_version: 99,
          links: [{ batch_id: '901', linked_quantity: 3000 }],
        }),
      });

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('CONCURRENCY_CONFLICT');
      expect(idempotencyStore.size).toBe(0);
    });

    it('returns 400 INVALID_INPUT when total linked_quantity exceeds allocation.quantity or duplicate batch_id is sent', async () => {
      const resExceed = await fetch(
        `${base}/artisan/allocations/12001/batches`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-artisan-301',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_allocation_version: 2,
            links: [
              { batch_id: '901', linked_quantity: 2000 },
              { batch_id: '902', linked_quantity: 1500 },
            ],
          }),
        },
      );
      expect(resExceed.status).toBe(400);
      expect((await resExceed.json()).code).toBe('INVALID_INPUT');

      const resDup = await fetch(`${base}/artisan/allocations/12001/batches`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-301',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          expected_allocation_version: 2,
          links: [
            { batch_id: '901', linked_quantity: 1000 },
            { batch_id: '901', linked_quantity: 1000 },
          ],
        }),
      });
      expect(resDup.status).toBe(400);
      expect((await resDup.json()).code).toBe('INVALID_INPUT');
      expect(idempotencyStore.size).toBe(0);
    });

    it('returns 404 RESOURCE_NOT_FOUND when batch belongs to another workshop or another Artisan tries to link', async () => {
      const resOtherBatch = await fetch(
        `${base}/artisan/allocations/12001/batches`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-artisan-301',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_allocation_version: 2,
            links: [{ batch_id: '999', linked_quantity: 1000 }],
          }),
        },
      );
      expect(resOtherBatch.status).toBe(404);
      expect((await resOtherBatch.json()).code).toBe('RESOURCE_NOT_FOUND');

      const resOtherArtisan = await fetch(
        `${base}/artisan/allocations/12001/batches`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-artisan-302',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_allocation_version: 2,
            links: [{ batch_id: '999', linked_quantity: 1000 }],
          }),
        },
      );
      expect(resOtherArtisan.status).toBe(404);
      expect((await resOtherArtisan.json()).code).toBe('RESOURCE_NOT_FOUND');
      expect(idempotencyStore.size).toBe(0);
    });

    it('returns 422 INVALID_STATE when Allocation is handed_over or not_started', async () => {
      allocationStore.set(
        '12001',
        createSampleAllocation({
          status: 'handed_over',
          version: 3,
          handed_over_at: BASE_NOW,
          handed_over_by: '201',
        }),
      );

      const res = await fetch(`${base}/artisan/allocations/12001/batches`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-301',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          expected_allocation_version: 3,
          links: [{ batch_id: '901', linked_quantity: 3000 }],
        }),
      });

      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('INVALID_STATE');
      expect(idempotencyStore.size).toBe(0);
    });

    it('enforces auth, role, temp_password, and workshop ownership guards (401/403)', async () => {
      const unauth = await fetch(`${base}/artisan/allocations/12001/batches`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          expected_allocation_version: 2,
          links: [],
        }),
      });
      expect(unauth.status).toBe(401);
      expect((await unauth.json()).code).toBe('AUTHENTICATION_REQUIRED');

      for (const token of [
        'session-buyer-101',
        'session-admin-1',
        'session-artisan-no-ws',
      ]) {
        const forbidden = await fetch(
          `${base}/artisan/allocations/12001/batches`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Cookie: `vcraft-session=${token}`,
              'X-Idempotency-Key': randomUUID(),
            },
            body: JSON.stringify({
              expected_allocation_version: 2,
              links: [],
            }),
          },
        );
        expect(forbidden.status).toBe(403);
        expect((await forbidden.json()).code).toBe('PERMISSION_DENIED');
      }

      const tempPass = await fetch(
        `${base}/artisan/allocations/12001/batches`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-temp-artisan',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_allocation_version: 2,
            links: [],
          }),
        },
      );
      expect(tempPass.status).toBe(403);
      expect((await tempPass.json()).code).toBe('TEMP_PASSWORD_RESTRICTED');
    });
  });
});
