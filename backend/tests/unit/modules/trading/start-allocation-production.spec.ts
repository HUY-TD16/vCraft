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
import { ArtisanAllocationController } from '../../../../src/modules/trading/adapters/http/controllers/artisan-allocation.controller';
import { allocationDtoResponseSchema } from '../../../../src/modules/trading/adapters/http/dtos/accept-quote.dto';
import {
  StartAllocationDto,
  startAllocationOperationResponseSchema,
  startAllocationSchema,
} from '../../../../src/modules/trading/adapters/http/dtos/start-allocation.dto';
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
  AllocationNotFoundError,
  ConcurrencyConflictError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  QuoteRequest,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
  type AllocationLogRecord,
  type AllocationStatus,
  type RequestStatus,
  type StatusLogRecord,
} from '../../../../src/modules/trading/domain';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import { MockWorkshopContract } from '../../../support/mocks/workshop.mock';

// ---------------------------------------------------------------------------
// Test Actors
// ---------------------------------------------------------------------------
const owningArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '21',
  role: 'artisan',
  workshopId: '201',
  authVersion: 1,
  sessionId: 'sess-artisan-201',
  sessionLevel: 'normal',
});

const secondArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '22',
  role: 'artisan',
  workshopId: '202',
  authVersion: 1,
  sessionId: 'sess-artisan-202',
  sessionLevel: 'normal',
});

const artisanWithoutWorkshopActor: AuthenticatedActor = Object.freeze({
  accountId: '30',
  role: 'artisan',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-artisan-no-ws',
  sessionLevel: 'normal',
});

const tempPasswordArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '21',
  role: 'artisan',
  workshopId: '201',
  authVersion: 1,
  sessionId: 'sess-temp-artisan',
  sessionLevel: 'temp_password',
});

const buyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-buyer-10',
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
const BASE_NOW = new Date('2026-11-16T08:00:00.000Z');
const BIDDING_DEADLINE = new Date('2026-11-20T10:00:00.000Z');
const DELIVERY_DEADLINE = new Date('2026-12-05T10:00:00.000Z');
const COMMITTED_DELIVERY = new Date('2026-12-01T10:00:00.000Z');

function createSampleRequest(
  overrides: Partial<Parameters<typeof QuoteRequest.reconstitute>[0]> = {},
): QuoteRequest {
  return QuoteRequest.reconstitute({
    id: '100',
    buyer_id: '10',
    category_id: '1',
    spec: '5.000 cốc gốm men trắng dung tích 300ml',
    quantity: 5000,
    unit: 'piece',
    unit_set_description: null,
    status: 'buyer_accepted',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Gia Lâm, Hà Nội',
    delivery_address: 'Số 10 Bát Tràng, Gia Lâm, Hà Nội',
    recipient_name: 'Nguyễn Văn An',
    recipient_phone: '0912345678',
    bidding_deadline: BIDDING_DEADLINE,
    delivery_deadline: DELIVERY_DEADLINE,
    bidding_closed_at: new Date('2026-11-15T10:00:00.000Z'),
    version: 3,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: new Date('2026-11-10T08:00:00.000Z'),
    updated_at: new Date('2026-11-15T10:00:00.000Z'),
    ...overrides,
  });
}

function createSampleAllocation(
  overrides: Partial<Parameters<typeof Allocation.reconstitute>[0]> = {},
): Allocation {
  return Allocation.reconstitute({
    id: '501',
    request_id: '100',
    workshop_id: '201',
    quote_id: '401',
    quantity: 5000,
    unit_price: 45000,
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
    created_at: new Date('2026-11-15T10:00:00.000Z'),
    updated_at: new Date('2026-11-15T10:00:00.000Z'),
    batch_links: [],
    ...overrides,
  });
}

describe('Task 31 (UC-23, BR-24): POST /api/v1/artisan/allocations/:id/start', () => {
  // =========================================================================
  // Suite A: StartAllocationProductionUseCase Unit Tests
  // =========================================================================
  describe('Suite A: StartAllocationProductionUseCase Unit Tests', () => {
    let txRunner: MockTransactionRunner;
    let workshopContract: MockWorkshopContract;
    let allocationStore: Map<string, Allocation>;
    let requestStore: Map<string, QuoteRequest>;
    let savedAllocationLogs: AllocationLogRecord[];
    let savedStatusLogs: StatusLogRecord[];

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
    let useCase: StartAllocationProductionUseCase;

    beforeEach(() => {
      vi.clearAllMocks();
      txRunner = new MockTransactionRunner();
      workshopContract = new MockWorkshopContract();
      workshopContract.givenActiveWorkshops('201', '202');
      workshopContract.getWorkshopSummary.mockImplementation(async (wsId: string) => ({
        id: wsId,
        name: wsId === '201' ? 'Xưởng Gốm Hưng Thịnh' : 'Xưởng Gốm Minh Châu',
        status: 'active',
        isProfilePublic: true,
      }));

      allocationStore = new Map([
        ['501', createSampleAllocation()],
      ]);
      requestStore = new Map([
        ['100', createSampleRequest()],
      ]);
      savedAllocationLogs = [];
      savedStatusLogs = [];

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
                  alloc.workshop_id === '201'
                    ? 'Xưởng Gốm Hưng Thịnh'
                    : 'Xưởng Gốm Minh Châu',
              },
              startedByActor: alloc.started_by
                ? { id: alloc.started_by, display_name: null }
                : null,
              handedOverByActor: null,
              publishedBatchIds: new Set<string>(),
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
        update: vi.fn(
          async (input: {
            request: QuoteRequest;
            expectedVersion?: number;
            statusLogs?: readonly StatusLogRecord[];
          }) => {
            const current = requestStore.get(input.request.id);
            if (!current || current.version !== input.expectedVersion) {
              throw new ConcurrencyConflictError('QuoteRequest version mismatch.');
            }
            requestStore.set(input.request.id, input.request);
            if (input.statusLogs) {
              savedStatusLogs.push(...input.statusLogs);
            }
            return input.request;
          },
        ),
      };

      useCase = new StartAllocationProductionUseCase(
        txRunner,
        mockAllocationRepo as unknown as IAllocationRepository,
        mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
        workshopContract,
      );
    });

    it('transitions Allocation not_started -> in_production, records started_at/started_by, and promotes first-start QuoteRequest buyer_accepted -> in_production', async () => {
      const result = await useCase.execute({
        actor: owningArtisanActor,
        allocationId: '501',
        expectedAllocationVersion: 1,
        now: BASE_NOW,
      });

      expect(result.allocation).toEqual({
        id: '501',
        request_id: '100',
        workshop: { id: '201', name: 'Xưởng Gốm Hưng Thịnh' },
        quote_id: '401',
        quantity: 5000,
        unit_price: 45000,
        committed_delivery_at: COMMITTED_DELIVERY.toISOString(),
        status: 'in_production',
        version: 2,
        started_at: BASE_NOW.toISOString(),
        started_by: { id: '21', display_name: null },
        handed_over_at: null,
        handed_over_by: null,
        delivery_note: null,
        admin_handed_over: false,
        admin_handover_reason: null,
        admin_delivery_evidence: null,
        admin_handover_actual_at: null,
        traceability_warning: 'NO_BATCH_LINK',
      });

      expect(result.currentState).toEqual({
        request: {
          id: '100',
          status: 'in_production',
          version: 4,
          cancelled_at: null,
        },
        allocation: {
          id: '501',
          status: 'in_production',
          version: 2,
        },
      });

      expect(savedAllocationLogs).toHaveLength(1);
      expect(savedAllocationLogs[0]).toMatchObject({
        allocation_id: '501',
        event_type: 'production_started',
        prev_status: 'not_started',
        new_status: 'in_production',
        performed_by: '21',
        is_admin_action: false,
        created_at: BASE_NOW,
      });

      expect(savedStatusLogs).toHaveLength(1);
      expect(savedStatusLogs[0]).toMatchObject({
        request_id: '100',
        event_type: 'production_started',
        prev_status: 'buyer_accepted',
        new_status: 'in_production',
        performed_by: '21',
        is_admin_action: false,
        created_at: BASE_NOW,
      });

      // Strict lock order: QuoteRequest locked BEFORE Allocation (data-design.md §4.2)
      const requestLockOrder =
        mockQuoteRequestRepo.lockById.mock.invocationCallOrder[0];
      const allocationLockOrder =
        mockAllocationRepo.lockById.mock.invocationCallOrder[0];
      expect(requestLockOrder).toBeLessThan(allocationLockOrder);
    });

    it('keeps QuoteRequest in in_production without bumping request version or duplicating StatusLog when a second allocation starts', async () => {
      requestStore.set(
        '100',
        createSampleRequest({ status: 'in_production', version: 4 }),
      );
      allocationStore.set(
        '502',
        createSampleAllocation({
          id: '502',
          workshop_id: '202',
          quote_id: '402',
          version: 1,
        }),
      );

      const result = await useCase.execute({
        actor: secondArtisanActor,
        allocationId: '502',
        expectedAllocationVersion: 1,
        now: BASE_NOW,
      });

      expect(result.allocation.status).toBe('in_production');
      expect(result.allocation.version).toBe(2);
      expect(result.allocation.started_by).toEqual({
        id: '22',
        display_name: null,
      });
      expect(result.currentState).toEqual({
        request: {
          id: '100',
          status: 'in_production',
          version: 4,
          cancelled_at: null,
        },
        allocation: {
          id: '502',
          status: 'in_production',
          version: 2,
        },
      });

      expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();
      expect(savedStatusLogs).toHaveLength(0);
      expect(savedAllocationLogs).toHaveLength(1);
    });

    it('allows a suspended workshop to start production on its already accepted Allocation (BR-05, UC-23)', async () => {
      workshopContract.givenSuspended('201');
      workshopContract.getWorkshopSummary.mockResolvedValueOnce({
        id: '201',
        name: 'Xưởng Gốm Hưng Thịnh',
        status: 'suspended',
        isProfilePublic: false,
      });

      const result = await useCase.execute({
        actor: owningArtisanActor,
        allocationId: '501',
        expectedAllocationVersion: 1,
        now: BASE_NOW,
      });

      expect(result.allocation.status).toBe('in_production');
      expect(workshopContract.lockAndAssertActive).not.toHaveBeenCalled();
    });

    it('throws AllocationNotFoundError (404 anti-IDOR) when another Artisan attempts to start an Allocation they do not own', async () => {
      await expect(
        useCase.execute({
          actor: secondArtisanActor,
          allocationId: '501',
          expectedAllocationVersion: 1,
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
      requestStore.delete('100');

      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '501',
          expectedAllocationVersion: 1,
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);
    });

    it('throws InvalidStateTransitionError (INVALID_STATE) when QuoteRequest is cancelled', async () => {
      requestStore.set(
        '100',
        createSampleRequest({
          status: 'buyer_accepted',
          version: 4,
          cancelled_at: new Date('2026-11-15T12:00:00.000Z'),
          cancelled_by: '1',
          cancel_reason: 'Hủy bởi Ban quản lý',
        }),
      );

      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '501',
          expectedAllocationVersion: 1,
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
    });

    it.each<RequestStatus>([
      'draft_request',
      'sent_to_artisans',
      'artisans_bidding',
      'delivered',
    ])(
      'throws InvalidStateTransitionError when QuoteRequest status is %s',
      async (status) => {
        requestStore.set('100', createSampleRequest({ status }));

        await expect(
          useCase.execute({
            actor: owningArtisanActor,
            allocationId: '501',
            expectedAllocationVersion: 1,
          }),
        ).rejects.toThrow(InvalidStateTransitionError);
      },
    );

    it.each<AllocationStatus>(['in_production', 'handed_over'])(
      'throws InvalidStateTransitionError when Allocation is already %s and expected version matches current',
      async (status) => {
        allocationStore.set(
          '501',
          createSampleAllocation({
            status,
            version: 2,
            started_at: BASE_NOW,
            started_by: '21',
            ...(status === 'handed_over'
              ? { handed_over_at: BASE_NOW, handed_over_by: '21' }
              : {}),
          }),
        );

        await expect(
          useCase.execute({
            actor: owningArtisanActor,
            allocationId: '501',
            expectedAllocationVersion: 2,
          }),
        ).rejects.toThrow(InvalidStateTransitionError);
      },
    );

    it('throws ConcurrencyConflictError when expected_allocation_version is stale', async () => {
      allocationStore.set(
        '501',
        createSampleAllocation({
          status: 'in_production',
          version: 2,
          started_at: BASE_NOW,
          started_by: '21',
        }),
      );
      requestStore.set(
        '100',
        createSampleRequest({ status: 'in_production', version: 4 }),
      );

      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          allocationId: '501',
          expectedAllocationVersion: 1,
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
    });

    it('throws TEMP_PASSWORD_RESTRICTED for temp_password session without querying repository', async () => {
      await expect(
        useCase.execute({
          actor: tempPasswordArtisanActor,
          allocationId: '501',
          expectedAllocationVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });

      expect(mockAllocationRepo.findById).not.toHaveBeenCalled();
    });

    it('throws TradingPermissionDeniedError for buyer/admin or artisan without workshopId', async () => {
      for (const actor of [buyerActor, adminActor, artisanWithoutWorkshopActor]) {
        await expect(
          useCase.execute({
            actor,
            allocationId: '501',
            expectedAllocationVersion: 1,
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
            expectedAllocationVersion: 1,
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
            allocationId: '501',
            expectedAllocationVersion: badVersion as unknown as number,
          }),
        ).rejects.toThrow(InvalidTradingInputError);
      },
    );

    it('reuses caller-supplied TransactionContext without opening a nested transaction', async () => {
      const runSpy = vi.spyOn(txRunner, 'run');
      const externalTx = { txId: 'ext-tx-31' } as unknown as TransactionContext;

      const result = await useCase.execute({
        actor: owningArtisanActor,
        allocationId: '501',
        expectedAllocationVersion: 1,
        now: BASE_NOW,
        tx: externalTx,
      });

      expect(result.allocation.status).toBe('in_production');
      expect(runSpy).not.toHaveBeenCalled();
      expect(mockAllocationRepo.findById).toHaveBeenCalledWith('501', externalTx);
      expect(mockQuoteRequestRepo.lockById).toHaveBeenCalledWith(
        '100',
        externalTx,
      );
      expect(mockAllocationRepo.lockById).toHaveBeenCalledWith(
        '501',
        externalTx,
      );
    });

    it('falls back gracefully to WorkshopContract summary if findDetailById returns null', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(null);

      const result = await useCase.execute({
        actor: owningArtisanActor,
        allocationId: '501',
        expectedAllocationVersion: 1,
        now: BASE_NOW,
      });

      expect(result.allocation.workshop).toEqual({
        id: '201',
        name: 'Xưởng Gốm Hưng Thịnh',
      });
      expect(result.allocation.started_by).toEqual({
        id: '21',
        display_name: null,
      });
      expect(result.allocation.traceability_warning).toBe('NO_BATCH_LINK');
    });
  });

  // =========================================================================
  // Suite B: DTO Schema, Controller Metadata & Swagger OpenAPI Document
  // =========================================================================
  describe('Suite B: DTO Schema, Controller Metadata & Swagger OpenAPI Document', () => {
    it('validates StartAllocationDto strictly and rejects extra or invalid fields', () => {
      expect(
        startAllocationSchema.parse({ expected_allocation_version: 1 }),
      ).toEqual({ expected_allocation_version: 1 });

      expect(() => startAllocationSchema.parse({})).toThrow();
      expect(() =>
        startAllocationSchema.parse({ expected_allocation_version: 0 }),
      ).toThrow();
      expect(() =>
        startAllocationSchema.parse({ expected_allocation_version: '1' }),
      ).toThrow();
      expect(() =>
        startAllocationSchema.parse({
          expected_allocation_version: 1,
          status: 'in_production',
        }),
      ).toThrow();
    });

    it('verifies ArtisanAllocationController metadata, TradingModule exports, and OpenAPI schema', async () => {
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
        proto.startAllocation,
      );
      expect(mutationMeta).toEqual({
        action: 'start_production',
        objectType: 'Allocation',
        objectIdParam: 'id',
        expectedVersionField: 'expected_allocation_version',
      });

      const paramTypes = Reflect.getMetadata(
        'design:paramtypes',
        proto,
        'startAllocation',
      );
      expect(paramTypes).toBeDefined();
      expect(paramTypes).toHaveLength(4);
      expect(paramTypes[2]).toBe(StartAllocationDto);

      const moduleExports = Reflect.getMetadata(
        'exports',
        TradingModule,
      ) as unknown[];
      expect(moduleExports).toContain(StartAllocationProductionUseCase);
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
              name: 'Xưởng Gốm Hưng Thịnh',
            },
            startedByActor: alloc.started_by
              ? { id: alloc.started_by, display_name: null }
              : null,
            handedOverByActor: null,
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
      update: vi.fn(
        async (input: { request: QuoteRequest; expectedVersion?: number }) => {
          const current = requestStore.get(input.request.id);
          if (!current || current.version !== input.expectedVersion) {
            throw new ConcurrencyConflictError(
              'QuoteRequest version conflict.',
            );
          }
          requestStore.set(input.request.id, input.request);
          return input.request;
        },
      ),
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
      allocationStore = new Map([['501', createSampleAllocation()]]);
      requestStore = new Map([['100', createSampleRequest()]]);
      idempotencyStore = new Map();
      nextIdempotencyId = 19001n;

      workshopContract.givenActiveWorkshops('201', '202');
      workshopContract.getWorkshopSummary.mockResolvedValue({
        id: '201',
        name: 'Xưởng Gốm Hưng Thịnh',
        status: 'active',
        isProfilePublic: true,
      });

      identityMock.resolveSession.mockImplementation(async (token: string) => {
        if (token === 'session-artisan-201') return owningArtisanActor;
        if (token === 'session-artisan-202') return secondArtisanActor;
        if (token === 'session-artisan-no-ws') return artisanWithoutWorkshopActor;
        if (token === 'session-temp-artisan') return tempPasswordArtisanActor;
        if (token === 'session-buyer-10') return buyerActor;
        if (token === 'session-admin-1') return adminActor;
        return null;
      });
    });

    it('documents POST /api/v1/artisan/allocations/{id}/start in OpenAPI Swagger doc', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const endpoint = doc.paths?.['/api/v1/artisan/allocations/{id}/start'];
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

    it('POST /artisan/allocations/:id/start returns 200 OK with AllocationDto and operation metadata', async () => {
      const idempotencyKey = randomUUID();
      const res = await fetch(`${base}/artisan/allocations/501/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-201',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ expected_allocation_version: 1 }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(allocationDtoResponseSchema.parse(json.data)).toEqual(json.data);
      expect(json.data.status).toBe('in_production');
      expect(json.data.version).toBe(2);
      expect(json.data.started_by).toEqual({ id: '21', display_name: null });
      expect(typeof json.data.started_at).toBe('string');

      expect(
        startAllocationOperationResponseSchema.parse(json.operation),
      ).toEqual(json.operation);
      expect(json.operation.replayed).toBe(false);
      expect(json.operation.current_state).toEqual({
        request: {
          id: '100',
          status: 'in_production',
          version: 4,
          cancelled_at: null,
        },
        allocation: {
          id: '501',
          status: 'in_production',
          version: 2,
        },
      });
    });

    it('replays identical X-Idempotency-Key + payload without re-executing mutation and returns fresh current_state', async () => {
      const idempotencyKey = randomUUID();
      const firstRes = await fetch(`${base}/artisan/allocations/501/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-201',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ expected_allocation_version: 1 }),
      });
      expect(firstRes.status).toBe(200);
      const firstJson = await firstRes.json();
      expect(firstJson.operation.replayed).toBe(false);

      // Simulate later state change on Allocation (e.g. handed_over v3) before replay
      allocationStore.set(
        '501',
        createSampleAllocation({
          status: 'handed_over',
          version: 3,
          started_at: BASE_NOW,
          started_by: '21',
          handed_over_at: BASE_NOW,
          handed_over_by: '21',
        }),
      );
      mockAllocationRepo.update.mockClear();

      const replayRes = await fetch(`${base}/artisan/allocations/501/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-201',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ expected_allocation_version: 1 }),
      });
      expect(replayRes.status).toBe(200);
      const replayJson = await replayRes.json();

      expect(replayJson.data).toEqual(firstJson.data);
      expect(replayJson.operation.id).toBe(firstJson.operation.id);
      expect(replayJson.operation.replayed).toBe(true);
      expect(replayJson.operation.current_state.allocation).toEqual({
        id: '501',
        status: 'handed_over',
        version: 3,
      });
      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
    });

    it('returns 409 IDEMPOTENCY_CONFLICT when reusing X-Idempotency-Key with different payload', async () => {
      const idempotencyKey = randomUUID();
      const res1 = await fetch(`${base}/artisan/allocations/501/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-201',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ expected_allocation_version: 1 }),
      });
      expect(res1.status).toBe(200);

      const res2 = await fetch(`${base}/artisan/allocations/501/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-201',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ expected_allocation_version: 2 }),
      });
      expect(res2.status).toBe(409);
      const json2 = await res2.json();
      expect(json2.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('returns 409 CONCURRENCY_CONFLICT when expected_allocation_version does not match', async () => {
      const res = await fetch(`${base}/artisan/allocations/501/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-201',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({ expected_allocation_version: 99 }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe('CONCURRENCY_CONFLICT');
      expect(idempotencyStore.size).toBe(0);
    });

    it('returns 400 INVALID_INPUT when X-Idempotency-Key is missing or invalid', async () => {
      const resMissing = await fetch(`${base}/artisan/allocations/501/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-201',
        },
        body: JSON.stringify({ expected_allocation_version: 1 }),
      });
      expect(resMissing.status).toBe(400);
      expect((await resMissing.json()).code).toBe('INVALID_INPUT');

      const resBadKey = await fetch(`${base}/artisan/allocations/501/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-201',
          'X-Idempotency-Key': 'not-a-uuid',
        },
        body: JSON.stringify({ expected_allocation_version: 1 }),
      });
      expect(resBadKey.status).toBe(400);
      expect((await resBadKey.json()).code).toBe('INVALID_INPUT');
    });

    it('returns 400 INVALID_INPUT when body contains extra undeclared fields (mass assignment protection)', async () => {
      const res = await fetch(`${base}/artisan/allocations/501/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-201',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          expected_allocation_version: 1,
          status: 'handed_over',
        }),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('INVALID_INPUT');
    });

    it.each(['abc', '0', '9223372036854775808'])(
      'returns 400 INVALID_INPUT for invalid :id "%s"',
      async (badId) => {
        const res = await fetch(`${base}/artisan/allocations/${badId}/start`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-artisan-201',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({ expected_allocation_version: 1 }),
        });

        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('INVALID_INPUT');
      },
    );

    it('returns 404 RESOURCE_NOT_FOUND without saving IdempotencyRecord when another Artisan tries to start', async () => {
      const res = await fetch(`${base}/artisan/allocations/501/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-202',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({ expected_allocation_version: 1 }),
      });

      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('RESOURCE_NOT_FOUND');
      expect(idempotencyStore.size).toBe(0);
    });

    it('enforces auth, role, temp_password, and workshop ownership guards (401/403)', async () => {
      const unauth = await fetch(`${base}/artisan/allocations/501/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({ expected_allocation_version: 1 }),
      });
      expect(unauth.status).toBe(401);
      expect((await unauth.json()).code).toBe('AUTHENTICATION_REQUIRED');

      for (const token of ['session-buyer-10', 'session-admin-1', 'session-artisan-no-ws']) {
        const forbidden = await fetch(`${base}/artisan/allocations/501/start`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `vcraft-session=${token}`,
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({ expected_allocation_version: 1 }),
        });
        expect(forbidden.status).toBe(403);
        expect((await forbidden.json()).code).toBe('PERMISSION_DENIED');
      }

      const tempPass = await fetch(`${base}/artisan/allocations/501/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-temp-artisan',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({ expected_allocation_version: 1 }),
      });
      expect(tempPass.status).toBe(403);
      expect((await tempPass.json()).code).toBe('TEMP_PASSWORD_RESTRICTED');
    });

    it('succeeds with 200 OK when workshop is suspended (BR-05)', async () => {
      workshopContract.givenSuspended('201');

      const res = await fetch(`${base}/artisan/allocations/501/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-artisan-201',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({ expected_allocation_version: 1 }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe('in_production');
    });
  });
});
