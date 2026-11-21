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
  WORKSHOP_CONTRACT,
  type IWorkshopContract,
} from '../../../../src/modules/workshops/public/contracts/workshop.contract';
import {
  ALLOCATION_REPOSITORY,
  IDEMPOTENCY_RECORD_REPOSITORY,
  QUOTE_REPOSITORY,
  QUOTE_REQUEST_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
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
import {
  HandoverAllocationUseCase,
  RecordArtisanHandoverUseCase,
} from '../../../../src/modules/trading/application/use-cases/fulfillment/handover-allocation.use-case';
import { ArtisanAllocationController } from '../../../../src/modules/trading/adapters/http/controllers/artisan-allocation.controller';
import { allocationDtoResponseSchema } from '../../../../src/modules/trading/adapters/http/dtos/accept-quote.dto';
import {
  HandoverAllocationDto,
  RecordArtisanHandoverDto,
  handoverAllocationOperationResponseSchema,
  handoverAllocationSchema,
} from '../../../../src/modules/trading/adapters/http/dtos/handover-allocation.dto';
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
  MAX_DELIVERY_NOTE_LENGTH,
  QuoteRequest,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
  type AllocationLogRecord,
  type AllocationStatus,
  type RequestStatus,
} from '../../../../src/modules/trading/domain';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
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
const STARTED_AT = new Date('2026-11-10T08:00:00.000Z');
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
    category_id: '1',
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
    bidding_closed_at: new Date('2026-11-10T07:00:00.000Z'),
    version: 7,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: new Date('2026-11-08T08:00:00.000Z'),
    updated_at: STARTED_AT,
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
    version: 3,
    started_at: STARTED_AT,
    started_by: '201',
    handed_over_at: null,
    handed_over_by: null,
    delivery_note: null,
    admin_handed_over: false,
    admin_delivery_evidence: null,
    admin_handover_reason: null,
    admin_handover_actual_at: null,
    created_at: new Date('2026-11-10T07:30:00.000Z'),
    updated_at: STARTED_AT,
    batch_links: [],
    ...overrides,
  });
}

describe('Task 33 (UC-24, BR-24): POST /api/v1/artisan/allocations/:id/handover', () => {
  // =========================================================================
  // Suite A: HandoverAllocationUseCase Unit Tests
  // =========================================================================
  describe('Suite A: HandoverAllocationUseCase Unit Tests', () => {
    let txRunner: MockTransactionRunner;
    let workshopContract: MockWorkshopContract;
    let allocationStore: Map<string, Allocation>;
    let requestStore: Map<string, QuoteRequest>;
    let publishedBatchIds: Set<string>;
    let savedAllocationLogs: AllocationLogRecord[];

    let mockAllocationRepo: {
      findById: ReturnType<typeof vi.fn>;
      lockById: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      findDetailById: ReturnType<typeof vi.fn>;
    };
    let mockQuoteRequestRepo: {
      findById: ReturnType<typeof vi.fn>;
      lockById: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    let useCase: HandoverAllocationUseCase;

    beforeEach(() => {
      vi.clearAllMocks();
      txRunner = new MockTransactionRunner();
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

      publishedBatchIds = new Set(['901', '902']);
      allocationStore = new Map([['12001', createSampleAllocation()]]);
      requestStore = new Map([['10001', createSampleRequest()]]);
      savedAllocationLogs = [];

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
              throw new ConcurrencyConflictError('Allocation version mismatch.');
            }
            allocationStore.set(input.allocation.id, input.allocation);
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
          return {
            allocation: AllocationMapper.toDto(alloc, {
              workshop: {
                id: alloc.workshop_id,
                name:
                  alloc.workshop_id === '301'
                    ? 'Xưởng gốm mẫu Bát Tràng'
                    : 'Xưởng Gốm Minh Châu',
              },
              startedByActor: alloc.started_by
                ? { id: alloc.started_by, display_name: null }
                : null,
              handedOverByActor: alloc.handed_over_by
                ? { id: alloc.handed_over_by, display_name: null }
                : null,
              publishedBatchIds,
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
        update: vi.fn(),
      };

      useCase = new HandoverAllocationUseCase(
        txRunner,
        mockAllocationRepo as unknown as IAllocationRepository,
        mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
        workshopContract,
      );
    });

    it('transitions Allocation in_production -> handed_over, records handed_over_at/handed_over_by/delivery_note, appends AllocationLog, and keeps QuoteRequest in_production', async () => {
      const result = await useCase.execute({
        actor: owningArtisanActor,
        allocationId: '12001',
        expectedAllocationVersion: 3,
        deliveryNote: '  Đã bàn giao đủ 3.000 cốc tại xưởng cho bên nhận  ',
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
        status: 'handed_over',
        version: 4,
        started_at: STARTED_AT.toISOString(),
        started_by: { id: '201', display_name: null },
        handed_over_at: BASE_NOW.toISOString(),
        handed_over_by: { id: '201', display_name: null },
        delivery_note: 'Đã bàn giao đủ 3.000 cốc tại xưởng cho bên nhận',
        admin_handed_over: false,
        admin_handover_reason: null,
        admin_delivery_evidence: null,
        admin_handover_actual_at: null,
        traceability_warning: 'NO_BATCH_LINK',
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
          status: 'handed_over',
          version: 4,
        },
      });

      expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();

      expect(savedAllocationLogs).toHaveLength(1);
      expect(savedAllocationLogs[0]).toEqual({
        allocation_id: '12001',
        event_type: 'handover_recorded',
        prev_status: 'in_production',
        new_status: 'handed_over',
        performed_by: '201',
        is_admin_action: false,
        note: 'Đã bàn giao đủ 3.000 cốc tại xưởng cho bên nhận',
        evidence: null,
        created_at: BASE_NOW,
      });

      // Strict lock order: QuoteRequest locked BEFORE Allocation (data-design.md §4.2)
      const requestLockOrder =
        mockQuoteRequestRepo.lockById.mock.invocationCallOrder[0];
      const allocationLockOrder =
        mockAllocationRepo.lockById.mock.invocationCallOrder[0];
      expect(requestLockOrder).toBeLessThan(allocationLockOrder);
    });

    it.each([undefined, null, '', '   \t\n  '])(
      'normalizes omitted, null, or blank delivery_note (%j) to null',
      async (rawNote) => {
        const result = await useCase.execute({
          actor: owningArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 3,
          deliveryNote: rawNote,
          now: BASE_NOW,
        });

        expect(result.allocation.status).toBe('handed_over');
        expect(result.allocation.delivery_note).toBeNull();
        expect(savedAllocationLogs[0]?.note).toBeNull();
      },
    );

    it('allows handover without blocking when batch links are partial or draft (INCOMPLETE_TRACEABILITY) or 100% published (null) (BR-24, UC-24)', async () => {
      // Partial batch link (2000 / 3000) -> INCOMPLETE_TRACEABILITY
      allocationStore.set(
        '12001',
        createSampleAllocation({
          version: 3,
          batch_links: [
            AllocationBatchLink.reconstitute({
              workshop_id: '301',
              allocation_id: '12001',
              batch_id: '901',
              linked_quantity: 2000,
              linked_at: STARTED_AT,
              linked_by: '201',
            }),
          ],
        }),
      );

      const partialResult = await useCase.execute({
        actor: owningArtisanActor,
        allocationId: '12001',
        expectedAllocationVersion: 3,
        deliveryNote: 'Giao đủ hàng với liên kết lô một phần',
        now: BASE_NOW,
      });

      expect(partialResult.allocation.status).toBe('handed_over');
      expect(partialResult.allocation.traceability_warning).toBe(
        'INCOMPLETE_TRACEABILITY',
      );

      // Full batch link (3000 / 3000 on published batch 901) -> null warning
      allocationStore.set(
        '12001',
        createSampleAllocation({
          version: 3,
          batch_links: [
            AllocationBatchLink.reconstitute({
              workshop_id: '301',
              allocation_id: '12001',
              batch_id: '901',
              linked_quantity: 3000,
              linked_at: STARTED_AT,
              linked_by: '201',
            }),
          ],
        }),
      );

      const fullResult = await useCase.execute({
        actor: owningArtisanActor,
        allocationId: '12001',
        expectedAllocationVersion: 3,
        deliveryNote: 'Giao đủ hàng kèm truy xuất 100%',
        now: BASE_NOW,
      });

      expect(fullResult.allocation.status).toBe('handed_over');
      expect(fullResult.allocation.traceability_warning).toBeNull();
    });

    it('allows a suspended workshop to record handover on its already awarded Allocation (BR-05, UC-24)', async () => {
      workshopContract.givenSuspended('301');
      workshopContract.getWorkshopSummary.mockResolvedValueOnce({
        id: '301',
        name: 'Xưởng gốm mẫu Bát Tràng',
        status: 'suspended',
        isProfilePublic: false,
      });

      const result = await useCase.execute({
        actor: owningArtisanActor,
        allocationId: '12001',
        expectedAllocationVersion: 3,
        deliveryNote: 'Hoàn tất bàn giao phần việc đã chốt',
        now: BASE_NOW,
      });

      expect(result.allocation.status).toBe('handed_over');
      expect(workshopContract.lockAndAssertActive).not.toHaveBeenCalled();
    });

    it('throws AllocationNotFoundError (404 anti-IDOR) when another Artisan attempts to hand over an Allocation they do not own', async () => {
      await expect(
        useCase.execute({
          actor: secondArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 3,
          deliveryNote: 'Thử bàn giao phần việc hộ khác',
        }),
      ).rejects.toThrow(AllocationNotFoundError);

      expect(mockQuoteRequestRepo.lockById).not.toHaveBeenCalled();
      expect(mockAllocationRepo.lockById).not.toHaveBeenCalled();
      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
    });

    it('throws AllocationNotFoundError when Allocation does not exist', async () => {
      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '99999',
          expectedAllocationVersion: 1,
        }),
      ).rejects.toThrow(AllocationNotFoundError);
    });

    it('throws QuoteRequestNotFoundError if parent QuoteRequest disappears before locking', async () => {
      requestStore.delete('10001');

      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 3,
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);
    });

    it('throws InvalidStateTransitionError (422 INVALID_STATE) when QuoteRequest is cancelled', async () => {
      requestStore.set(
        '10001',
        createSampleRequest({
          status: 'in_production',
          version: 8,
          cancelled_at: new Date('2026-11-10T08:30:00.000Z'),
          cancelled_by: '1',
          cancel_reason: 'Hủy bởi Ban quản lý',
        }),
      );

      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 3,
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
    });

    it.each<RequestStatus>([
      'draft_request',
      'sent_to_artisans',
      'artisans_bidding',
      'buyer_accepted',
      'delivered',
    ])(
      'throws InvalidStateTransitionError when QuoteRequest status is %s (must be in_production)',
      async (status) => {
        requestStore.set('10001', createSampleRequest({ status }));

        await expect(
          useCase.execute({
            actor: owningArtisanActor,
            allocationId: '12001',
            expectedAllocationVersion: 3,
          }),
        ).rejects.toThrow(InvalidStateTransitionError);
      },
    );

    it.each<AllocationStatus>(['not_started', 'handed_over'])(
      'throws InvalidStateTransitionError when Allocation status is %s (must be in_production)',
      async (status) => {
        allocationStore.set(
          '12001',
          createSampleAllocation({
            status,
            version: 3,
            ...(status === 'not_started'
              ? { started_at: null, started_by: null }
              : { handed_over_at: BASE_NOW, handed_over_by: '201' }),
          }),
        );

        await expect(
          useCase.execute({
            actor: owningArtisanActor,
            allocationId: '12001',
            expectedAllocationVersion: 3,
          }),
        ).rejects.toThrow(InvalidStateTransitionError);

        expect(mockAllocationRepo.update).not.toHaveBeenCalled();
      },
    );

    it('throws ConcurrencyConflictError (409) when expected_allocation_version is stale', async () => {
      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 2, // current is 3
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
    });

    it('throws TEMP_PASSWORD_RESTRICTED for temp_password session without querying repository', async () => {
      await expect(
        useCase.execute({
          actor: tempPasswordArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 3,
        }),
      ).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });

      expect(mockAllocationRepo.findById).not.toHaveBeenCalled();
    });

    it('throws TradingPermissionDeniedError for buyer/admin or artisan without workshopId', async () => {
      for (const actor of [
        buyerActor,
        adminActor,
        artisanWithoutWorkshopActor,
      ]) {
        await expect(
          useCase.execute({
            actor,
            allocationId: '12001',
            expectedAllocationVersion: 3,
          }),
        ).rejects.toThrow(TradingPermissionDeniedError);
      }

      expect(mockAllocationRepo.findById).not.toHaveBeenCalled();
    });

    it.each(['0', '-1', 'abc', '9223372036854775808', ''])(
      'throws InvalidTradingInputError for invalid allocationId %j',
      async (badId) => {
        await expect(
          useCase.execute({
            actor: owningArtisanActor,
            allocationId: badId,
            expectedAllocationVersion: 3,
          }),
        ).rejects.toThrow(InvalidTradingInputError);
      },
    );

    it.each([undefined, null, 0, -1, 1.5, 2_147_483_648])(
      'throws InvalidTradingInputError for invalid expectedAllocationVersion %j',
      async (badVersion) => {
        await expect(
          useCase.execute({
            actor: owningArtisanActor,
            allocationId: '12001',
            expectedAllocationVersion: badVersion as unknown as number,
          }),
        ).rejects.toThrow(InvalidTradingInputError);
      },
    );

    it('throws InvalidTradingInputError when delivery_note exceeds 10,000 characters or is non-string', async () => {
      const tooLongNote = 'A'.repeat(MAX_DELIVERY_NOTE_LENGTH + 1);

      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 3,
          deliveryNote: tooLongNote,
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '12001',
          expectedAllocationVersion: 3,
          deliveryNote: 12345 as unknown as string,
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      expect(mockAllocationRepo.findById).not.toHaveBeenCalled();
    });

    it('reuses caller-supplied TransactionContext without opening a nested transaction', async () => {
      const runSpy = vi.spyOn(txRunner, 'run');
      const externalTx = { txId: 'ext-tx-33' } as unknown as TransactionContext;

      const result = await useCase.execute({
        actor: owningArtisanActor,
        id: '12001',
        expected_allocation_version: 3,
        delivery_note: 'Bàn giao qua tx có sẵn',
        now: BASE_NOW,
        tx: externalTx,
      });

      expect(result.allocation.status).toBe('handed_over');
      expect(result.allocation.delivery_note).toBe('Bàn giao qua tx có sẵn');
      expect(runSpy).not.toHaveBeenCalled();
      expect(mockAllocationRepo.findById).toHaveBeenCalledWith(
        '12001',
        externalTx,
      );
      expect(mockQuoteRequestRepo.lockById).toHaveBeenCalledWith(
        '10001',
        externalTx,
      );
      expect(mockAllocationRepo.lockById).toHaveBeenCalledWith(
        '12001',
        externalTx,
      );
    });

    it('falls back gracefully to WorkshopContract summary if findDetailById returns null', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(null);

      const result = await useCase.execute({
        actor: owningArtisanActor,
        allocationId: '12001',
        expectedAllocationVersion: 3,
        deliveryNote: 'Đã bàn giao đủ',
        now: BASE_NOW,
      });

      expect(result.allocation.workshop).toEqual({
        id: '301',
        name: 'Xưởng gốm mẫu Bát Tràng',
      });
      expect(result.allocation.handed_over_by).toEqual({
        id: '201',
        display_name: null,
      });
      expect(result.allocation.handed_over_at).toBe(BASE_NOW.toISOString());
      expect(result.allocation.delivery_note).toBe('Đã bàn giao đủ');
      expect(result.allocation.traceability_warning).toBe('NO_BATCH_LINK');
    });
  });

  // =========================================================================
  // Suite B: DTO Schema, Controller Metadata & Swagger OpenAPI Document
  // =========================================================================
  describe('Suite B: DTO Schema, Controller Metadata & Swagger OpenAPI Document', () => {
    it('validates HandoverAllocationDto strictly, trims delivery_note, and rejects extra or invalid fields', () => {
      expect(RecordArtisanHandoverDto).toBe(HandoverAllocationDto);
      expect(RecordArtisanHandoverUseCase).toBe(HandoverAllocationUseCase);

      expect(
        handoverAllocationSchema.parse({
          expected_allocation_version: 3,
          delivery_note: '  Đã bàn giao đủ phần việc.  ',
        }),
      ).toEqual({
        expected_allocation_version: 3,
        delivery_note: 'Đã bàn giao đủ phần việc.',
      });

      expect(
        handoverAllocationSchema.parse({
          expected_allocation_version: 3,
          delivery_note: null,
        }),
      ).toEqual({
        expected_allocation_version: 3,
        delivery_note: null,
      });

      expect(
        handoverAllocationSchema.parse({
          expected_allocation_version: 3,
        }),
      ).toEqual({
        expected_allocation_version: 3,
      });

      expect(() => handoverAllocationSchema.parse({})).toThrow();
      expect(() =>
        handoverAllocationSchema.parse({ expected_allocation_version: 0 }),
      ).toThrow();
      expect(() =>
        handoverAllocationSchema.parse({ expected_allocation_version: '3' }),
      ).toThrow();
      expect(() =>
        handoverAllocationSchema.parse({
          expected_allocation_version: 3,
          delivery_note: 'X'.repeat(MAX_DELIVERY_NOTE_LENGTH + 1),
        }),
      ).toThrow();
      expect(() =>
        handoverAllocationSchema.parse({
          expected_allocation_version: 3,
          admin_handed_over: true,
        }),
      ).toThrow();
    });

    it('verifies ArtisanAllocationController metadata and TradingModule exports for handoverAllocation', () => {
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
        proto.handoverAllocation,
      );
      expect(mutationMeta).toEqual({
        action: 'handover_allocation',
        objectType: 'Allocation',
        objectIdParam: 'id',
        expectedVersionField: 'expected_allocation_version',
      });

      const paramTypes = Reflect.getMetadata(
        'design:paramtypes',
        proto,
        'handoverAllocation',
      );
      expect(paramTypes).toBeDefined();
      expect(paramTypes).toHaveLength(4);
      expect(paramTypes[2]).toBe(HandoverAllocationDto);

      const moduleExports = Reflect.getMetadata(
        'exports',
        TradingModule,
      ) as unknown[];
      expect(moduleExports).toContain(HandoverAllocationUseCase);
    });
  });

  // =========================================================================
  // Suite C: HTTP Controller + TradingMutationInterceptor + Idempotency
  // =========================================================================
  describe('Suite C: HTTP Controller + TradingMutationInterceptor + Idempotency', () => {
    const identityMock = new MockIdentityContract();
    const txRunner = new MockTransactionRunner();
    const workshopContract = new MockWorkshopContract();

    let allocationStore: Map<string, Allocation>;
    let requestStore: Map<string, QuoteRequest>;
    let idempotencyStore: Map<string, PersistedIdempotencyRecord<unknown>>;
    let nextIdempotencyId: bigint;

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
        return {
          allocation: AllocationMapper.toDto(alloc, {
            workshop: {
              id: alloc.workshop_id,
              name: 'Xưởng gốm mẫu Bát Tràng',
            },
            startedByActor: alloc.started_by
              ? { id: alloc.started_by, display_name: null }
              : null,
            handedOverByActor: alloc.handed_over_by
              ? { id: alloc.handed_over_by, display_name: null }
              : null,
            publishedBatchIds: new Set<string>(),
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
      update: vi.fn(),
    };

    const makeScopeKey = (s: IdempotencyScopeKey) =>
      `${s.account_id}::${s.action}::${s.object_type}::${s.object_id}::${s.idempotency_key}`;

    const mockIdempotencyRepo: IIdempotencyRecordRepository = {
      findByScope: vi.fn(async (scope: IdempotencyScopeKey) => {
        return (idempotencyStore.get(makeScopeKey(scope)) as any) ?? null;
      }),
      findAndVerifyReplay: vi.fn(async (input) => {
        const rec = idempotencyStore.get(makeScopeKey(input));
        if (!rec || rec.request_fingerprint !== input.request_fingerprint) {
          return null;
        }
        return rec as any;
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
        return record as any;
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
        { provide: QUOTE_REQUEST_REPOSITORY, useValue: mockQuoteRequestRepo },
        { provide: QUOTE_REPOSITORY, useValue: {} },
        { provide: REQUEST_RECIPIENT_REPOSITORY, useValue: {} },
        {
          provide: IDEMPOTENCY_RECORD_REPOSITORY,
          useValue: mockIdempotencyRepo,
        },
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
          ) => new LinkAllocationBatchesUseCase(tr, allocRepo, qrRepo),
          inject: [
            TRANSACTION_RUNNER,
            ALLOCATION_REPOSITORY,
            QUOTE_REQUEST_REPOSITORY,
          ],
        },
        {
          provide: HandoverAllocationUseCase,
          useFactory: (
            tr: TransactionRunner,
            allocRepo: IAllocationRepository,
            qrRepo: IQuoteRequestRepository,
            wc: IWorkshopContract,
          ) => new HandoverAllocationUseCase(tr, allocRepo, qrRepo, wc),
          inject: [
            TRANSACTION_RUNNER,
            ALLOCATION_REPOSITORY,
            QUOTE_REQUEST_REPOSITORY,
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

    it('documents POST /api/v1/artisan/allocations/{id}/handover in OpenAPI Swagger doc', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const endpoint = doc.paths?.['/api/v1/artisan/allocations/{id}/handover'];
      expect(endpoint?.post).toBeDefined();
      expect(endpoint?.post?.tags).toContain('trading');
      expect(endpoint?.post?.parameters).toContainEqual(
        expect.objectContaining({
          name: 'X-Idempotency-Key',
          in: 'header',
          required: true,
        }),
      );
      expect(endpoint?.post?.responses?.['200']).toBeDefined();
    });

    it('POST /artisan/allocations/:id/handover returns 200 OK with AllocationDto and operation metadata', async () => {
      const idempotencyKey = randomUUID();
      const res = await fetch(`${base}/artisan/allocations/12001/handover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-301',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          expected_allocation_version: 3,
          delivery_note: 'Đã bàn giao đủ phần việc.',
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(allocationDtoResponseSchema.parse(json.data)).toEqual(json.data);
      expect(json.data.status).toBe('handed_over');
      expect(json.data.version).toBe(4);
      expect(json.data.handed_over_by).toEqual({
        id: '201',
        display_name: null,
      });
      expect(typeof json.data.handed_over_at).toBe('string');
      expect(json.data.delivery_note).toBe('Đã bàn giao đủ phần việc.');
      expect(json.data.admin_handed_over).toBe(false);

      expect(
        handoverAllocationOperationResponseSchema.parse(json.operation),
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
          status: 'handed_over',
          version: 4,
        },
      });
    });

    it('replays identical X-Idempotency-Key + payload without re-executing mutation and returns fresh current_state', async () => {
      const idempotencyKey = randomUUID();
      const firstRes = await fetch(
        `${base}/artisan/allocations/12001/handover`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-artisan-301',
            'X-Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            expected_allocation_version: 3,
            delivery_note: 'Đã bàn giao đủ phần việc.',
          }),
        },
      );
      expect(firstRes.status).toBe(200);
      const firstJson = await firstRes.json();
      expect(firstJson.operation.replayed).toBe(false);

      // Simulate later QuoteRequest transition to delivered (v8) before replay
      requestStore.set(
        '10001',
        createSampleRequest({
          status: 'delivered',
          version: 8,
        }),
      );
      mockAllocationRepo.update.mockClear();

      const replayRes = await fetch(
        `${base}/artisan/allocations/12001/handover`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-artisan-301',
            'X-Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            expected_allocation_version: 3,
            delivery_note: 'Đã bàn giao đủ phần việc.',
          }),
        },
      );
      expect(replayRes.status).toBe(200);
      const replayJson = await replayRes.json();

      expect(replayJson.data).toEqual(firstJson.data);
      expect(replayJson.operation.id).toBe(firstJson.operation.id);
      expect(replayJson.operation.replayed).toBe(true);
      expect(replayJson.operation.current_state).toEqual({
        request: {
          id: '10001',
          status: 'delivered',
          version: 8,
          cancelled_at: null,
        },
        allocation: {
          id: '12001',
          status: 'handed_over',
          version: 4,
        },
      });
      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
    });

    it('returns 409 IDEMPOTENCY_CONFLICT when reusing X-Idempotency-Key with different payload', async () => {
      const idempotencyKey = randomUUID();
      const res1 = await fetch(`${base}/artisan/allocations/12001/handover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-301',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          expected_allocation_version: 3,
          delivery_note: 'Ghi chú bàn giao 1',
        }),
      });
      expect(res1.status).toBe(200);

      const res2 = await fetch(`${base}/artisan/allocations/12001/handover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-301',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          expected_allocation_version: 3,
          delivery_note: 'Ghi chú bàn giao khác',
        }),
      });
      expect(res2.status).toBe(409);
      const json2 = await res2.json();
      expect(json2.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('returns 409 CONCURRENCY_CONFLICT when expected_allocation_version does not match', async () => {
      const res = await fetch(`${base}/artisan/allocations/12001/handover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-301',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          expected_allocation_version: 2,
          delivery_note: 'Đã bàn giao đủ',
        }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe('CONCURRENCY_CONFLICT');
      expect(idempotencyStore.size).toBe(0);
    });

    it('returns 422 INVALID_STATE when Allocation is still not_started or QuoteRequest is cancelled', async () => {
      allocationStore.set(
        '12001',
        createSampleAllocation({
          status: 'not_started',
          version: 1,
          started_at: null,
          started_by: null,
        }),
      );

      const notStartedRes = await fetch(
        `${base}/artisan/allocations/12001/handover`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-artisan-301',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({ expected_allocation_version: 1 }),
        },
      );
      expect(notStartedRes.status).toBe(422);
      expect((await notStartedRes.json()).code).toBe('INVALID_STATE');

      allocationStore.set('12001', createSampleAllocation());
      requestStore.set(
        '10001',
        createSampleRequest({
          cancelled_at: BASE_NOW,
          cancelled_by: '1',
          cancel_reason: 'Hủy bởi Admin',
        }),
      );

      const cancelledRes = await fetch(
        `${base}/artisan/allocations/12001/handover`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-artisan-301',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({ expected_allocation_version: 3 }),
        },
      );
      expect(cancelledRes.status).toBe(422);
      expect((await cancelledRes.json()).code).toBe('INVALID_STATE');
    });

    it('returns 400 INVALID_INPUT when X-Idempotency-Key is missing/invalid, body has extra fields, or delivery_note > 10,000 chars', async () => {
      const resMissingKey = await fetch(
        `${base}/artisan/allocations/12001/handover`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-artisan-301',
          },
          body: JSON.stringify({ expected_allocation_version: 3 }),
        },
      );
      expect(resMissingKey.status).toBe(400);
      expect((await resMissingKey.json()).code).toBe('INVALID_INPUT');

      const resExtraField = await fetch(
        `${base}/artisan/allocations/12001/handover`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-artisan-301',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_allocation_version: 3,
            status: 'handed_over',
          }),
        },
      );
      expect(resExtraField.status).toBe(400);
      expect((await resExtraField.json()).code).toBe('INVALID_INPUT');

      const resTooLongNote = await fetch(
        `${base}/artisan/allocations/12001/handover`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-artisan-301',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_allocation_version: 3,
            delivery_note: 'N'.repeat(MAX_DELIVERY_NOTE_LENGTH + 1),
          }),
        },
      );
      expect(resTooLongNote.status).toBe(400);
      expect((await resTooLongNote.json()).code).toBe('INVALID_INPUT');
    });

    it.each(['abc', '0', '9223372036854775808'])(
      'returns 400 INVALID_INPUT for invalid :id "%s"',
      async (badId) => {
        const res = await fetch(
          `${base}/artisan/allocations/${badId}/handover`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: 'vcraft-session=session-artisan-301',
              'X-Idempotency-Key': randomUUID(),
            },
            body: JSON.stringify({ expected_allocation_version: 3 }),
          },
        );

        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('INVALID_INPUT');
      },
    );

    it('returns 404 RESOURCE_NOT_FOUND without saving IdempotencyRecord when another Artisan tries to hand over', async () => {
      const res = await fetch(`${base}/artisan/allocations/12001/handover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-302',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          expected_allocation_version: 3,
          delivery_note: 'Bàn giao hộ khác',
        }),
      });

      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('RESOURCE_NOT_FOUND');
      expect(idempotencyStore.size).toBe(0);
    });

    it('enforces auth, role, temp_password, and workshop ownership guards (401/403)', async () => {
      const unauth = await fetch(`${base}/artisan/allocations/12001/handover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({ expected_allocation_version: 3 }),
      });
      expect(unauth.status).toBe(401);
      expect((await unauth.json()).code).toBe('AUTHENTICATION_REQUIRED');

      for (const token of [
        'session-buyer-101',
        'session-admin-1',
        'session-artisan-no-ws',
      ]) {
        const forbidden = await fetch(
          `${base}/artisan/allocations/12001/handover`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: `vcraft-session=${token}`,
              'X-Idempotency-Key': randomUUID(),
            },
            body: JSON.stringify({ expected_allocation_version: 3 }),
          },
        );
        expect(forbidden.status).toBe(403);
        expect((await forbidden.json()).code).toBe('PERMISSION_DENIED');
      }

      const tempPass = await fetch(
        `${base}/artisan/allocations/12001/handover`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-temp-artisan',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({ expected_allocation_version: 3 }),
        },
      );
      expect(tempPass.status).toBe(403);
      expect((await tempPass.json()).code).toBe('TEMP_PASSWORD_RESTRICTED');
    });

    it('succeeds with 200 OK when workshop is suspended (BR-05)', async () => {
      workshopContract.givenSuspended('301');

      const res = await fetch(`${base}/artisan/allocations/12001/handover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-301',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          expected_allocation_version: 3,
          delivery_note: 'Đã bàn giao đủ khi xưởng đang tạm ngừng.',
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe('handed_over');
      expect(json.data.delivery_note).toBe(
        'Đã bàn giao đủ khi xưởng đang tạm ngừng.',
      );
    });
  });
});
