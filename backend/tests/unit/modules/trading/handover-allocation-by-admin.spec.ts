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
import {
  HandoverAllocationByAdminUseCase,
  RecordAdminHandoverUseCase,
} from '../../../../src/modules/trading/application/use-cases/fulfillment/handover-allocation-by-admin.use-case';
import { AdminAllocationController } from '../../../../src/modules/trading/adapters/http/controllers/admin-allocation.controller';
import { allocationDtoResponseSchema } from '../../../../src/modules/trading/adapters/http/dtos/accept-quote.dto';
import {
  HandoverAllocationByAdminDto,
  RecordAdminHandoverDto,
  handoverAllocationByAdminOperationResponseSchema,
  handoverAllocationByAdminSchema,
} from '../../../../src/modules/trading/adapters/http/dtos/handover-allocation-by-admin.dto';
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
  DeadlineViolationError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  MAX_ADMIN_HANDOVER_TEXT_LENGTH,
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
const adminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-admin-1',
  sessionLevel: 'normal',
});

const tempPasswordAdminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-temp-admin',
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

const artisanActor: AuthenticatedActor = Object.freeze({
  accountId: '201',
  role: 'artisan',
  workshopId: '301',
  authVersion: 1,
  sessionId: 'sess-artisan-301',
  sessionLevel: 'normal',
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const STARTED_AT = new Date('2026-11-10T08:00:00.000Z');
const ACTUAL_HANDOVER_AT = new Date('2026-11-20T10:00:00.000Z');
const BASE_NOW = new Date('2026-11-20T12:00:00.000Z');
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

describe('Task 37 (UC-24, BR-24, BR-26, BR-27): POST /api/v1/admin/allocations/:id/handover-by-admin', () => {
  // =========================================================================
  // Suite A: HandoverAllocationByAdminUseCase Unit Tests
  // =========================================================================
  describe('Suite A: HandoverAllocationByAdminUseCase Unit Tests', () => {
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
    let useCase: HandoverAllocationByAdminUseCase;

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
            syncBatchLinks?: boolean;
          }) => {
            const current = allocationStore.get(input.allocation.id);
            if (!current || current.version !== input.expectedVersion) {
              throw new ConcurrencyConflictError('Allocation version conflict.');
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
                ? {
                    id: alloc.handed_over_by,
                    display_name:
                      alloc.handed_over_by === '1'
                        ? 'Ban quản lý làng gốm Bát Tràng'
                        : null,
                  }
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

      useCase = new HandoverAllocationByAdminUseCase(
        txRunner,
        mockAllocationRepo as unknown as IAllocationRepository,
        mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
        workshopContract,
      );
    });

    it('transitions Allocation in_production -> handed_over with admin override fields, records AllocationLog(handover_by_admin, is_admin_action=true), keeps QuoteRequest in_production, and enforces QuoteRequest -> Allocation lock order', async () => {
      const result = await useCase.execute({
        actor: adminActor,
        allocationId: '12001',
        expectedAllocationVersion: 3,
        reason:
          '  Hộ đã bàn giao đủ nhưng mất điện không truy cập được phần mềm  ',
        evidence:
          '  Biên bản ký nhận bàn giao hàng giấy số BB-012/2026 có chữ ký thủ kho Buyer  ',
        actualHandoverAt: ACTUAL_HANDOVER_AT.toISOString(),
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
        handed_over_by: {
          id: '1',
          display_name: 'Ban quản lý làng gốm Bát Tràng',
        },
        delivery_note: null,
        admin_handed_over: true,
        admin_handover_reason:
          'Hộ đã bàn giao đủ nhưng mất điện không truy cập được phần mềm',
        admin_delivery_evidence:
          'Biên bản ký nhận bàn giao hàng giấy số BB-012/2026 có chữ ký thủ kho Buyer',
        admin_handover_actual_at: ACTUAL_HANDOVER_AT.toISOString(),
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

      // BR-24: Admin handover does NOT auto-confirm QuoteRequest to delivered
      expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();

      // BR-24: Admin does NOT sync/modify AllocationBatch links
      expect(mockAllocationRepo.update).toHaveBeenCalledTimes(1);
      expect(mockAllocationRepo.update.mock.calls[0]?.[0]?.syncBatchLinks).toBeUndefined();

      // BR-26: AllocationLog records actual Admin actor with is_admin_action = true
      expect(savedAllocationLogs).toHaveLength(1);
      expect(savedAllocationLogs[0]).toEqual({
        allocation_id: '12001',
        event_type: 'handover_by_admin',
        prev_status: 'in_production',
        new_status: 'handed_over',
        performed_by: '1',
        is_admin_action: true,
        note: 'Hộ đã bàn giao đủ nhưng mất điện không truy cập được phần mềm',
        evidence:
          'Biên bản ký nhận bàn giao hàng giấy số BB-012/2026 có chữ ký thủ kho Buyer',
        created_at: BASE_NOW,
      });

      // Strict lock order: QuoteRequest locked BEFORE Allocation (data-design.md §4.2)
      const requestLockOrder =
        mockQuoteRequestRepo.lockById.mock.invocationCallOrder[0];
      const allocationLockOrder =
        mockAllocationRepo.lockById.mock.invocationCallOrder[0];
      expect(requestLockOrder).toBeLessThan(allocationLockOrder);
    });

    it('accepts actual_handover_at equal to now (boundary) and rejects future actual_handover_at (+1ms) with DeadlineViolationError (422 DEADLINE_VIOLATION)', async () => {
      // Future (+1ms) -> rejected
      await expect(
        useCase.execute({
          actor: adminActor,
          allocationId: '12001',
          expectedAllocationVersion: 3,
          reason: 'Xưởng mất kết nối internet',
          evidence: 'Biên bản giao hàng số 01',
          actualHandoverAt: new Date(BASE_NOW.getTime() + 1),
          now: BASE_NOW,
        }),
      ).rejects.toThrow(DeadlineViolationError);

      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
      expect(savedAllocationLogs).toHaveLength(0);

      // Equal to now -> allowed
      const exactResult = await useCase.execute({
        actor: adminActor,
        allocationId: '12001',
        expectedAllocationVersion: 3,
        reason: 'Xưởng mất kết nối internet',
        evidence: 'Biên bản giao hàng số 01',
        actualHandoverAt: BASE_NOW,
        now: BASE_NOW,
      });

      expect(exactResult.allocation.status).toBe('handed_over');
      expect(exactResult.allocation.admin_handover_actual_at).toBe(
        BASE_NOW.toISOString(),
      );
      expect(exactResult.allocation.handed_over_at).toBe(BASE_NOW.toISOString());
    });

    it('accepts timezone-offset ISO 8601 string (+07:00) for actual_handover_at and normalizes to UTC ISO string', async () => {
      // 2026-11-20T17:00:00+07:00 == 2026-11-20T10:00:00.000Z <= BASE_NOW (12:00Z)
      const result = await useCase.execute({
        actor: adminActor,
        allocationId: '12001',
        expectedAllocationVersion: 3,
        reason: 'Xưởng mất điện lưới tại Bát Tràng',
        evidence: 'Biên bản bàn giao bản cứng có chữ ký hai bên',
        actualHandoverAt: '2026-11-20T17:00:00+07:00',
        now: BASE_NOW,
      });

      expect(result.allocation.admin_handover_actual_at).toBe(
        '2026-11-20T10:00:00.000Z',
      );
    });

    it('preserves existing AllocationBatch links untouched and surfaces traceability_warning without blocking (BR-24)', async () => {
      const existingLink = AllocationBatchLink.reconstitute({
        workshop_id: '301',
        allocation_id: '12001',
        batch_id: '901',
        linked_quantity: 2000,
        linked_at: STARTED_AT,
        linked_by: '201',
      });
      allocationStore.set(
        '12001',
        createSampleAllocation({
          version: 3,
          batch_links: [existingLink],
        }),
      );

      const partialResult = await useCase.execute({
        actor: adminActor,
        allocationId: '12001',
        expectedAllocationVersion: 3,
        reason: 'Hộ không thao tác được',
        evidence: 'Phiếu xuất kho ký nhận #02',
        actualHandoverAt: ACTUAL_HANDOVER_AT,
        now: BASE_NOW,
      });

      expect(partialResult.allocation.status).toBe('handed_over');
      expect(partialResult.allocation.traceability_warning).toBe(
        'INCOMPLETE_TRACEABILITY',
      );
      expect(allocationStore.get('12001')?.batch_links).toHaveLength(1);
      expect(allocationStore.get('12001')?.batch_links[0]?.batch_id).toBe('901');
      expect(allocationStore.get('12001')?.batch_links[0]?.linked_quantity).toBe(
        2000,
      );

      // 100% linked to published batch -> null warning
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
        actor: adminActor,
        allocationId: '12001',
        expectedAllocationVersion: 3,
        reason: 'Hộ mất mạng',
        evidence: 'Biên bản ký nhận đủ 3.000 chiếc',
        actualHandoverAt: ACTUAL_HANDOVER_AT,
        now: BASE_NOW,
      });

      expect(fullResult.allocation.status).toBe('handed_over');
      expect(fullResult.allocation.traceability_warning).toBeNull();
    });

    it('allows Admin handover even when the workshop is suspended (BR-05, UC-24)', async () => {
      workshopContract.givenSuspended('301');
      workshopContract.getWorkshopSummary.mockResolvedValueOnce({
        id: '301',
        name: 'Xưởng gốm mẫu Bát Tràng',
        status: 'suspended',
        isProfilePublic: false,
      });

      const result = await useCase.execute({
        actor: adminActor,
        allocationId: '12001',
        expectedAllocationVersion: 3,
        reason: 'Hộ đang tạm ngừng và mất quyền thao tác mạng, đã xác minh giao đủ',
        evidence: 'Biên bản xác nhận bàn giao số 09',
        actualHandoverAt: ACTUAL_HANDOVER_AT,
        now: BASE_NOW,
      });

      expect(result.allocation.status).toBe('handed_over');
      expect(result.allocation.admin_handed_over).toBe(true);
      expect(workshopContract.lockAndAssertActive).not.toHaveBeenCalled();
    });

    it('strictly rejects Admin handover on not_started Allocation with InvalidStateTransitionError (422 INVALID_STATE) and never synthesizes production start (BR-24, AT-14)', async () => {
      allocationStore.set(
        '12001',
        createSampleAllocation({
          status: 'not_started',
          version: 1,
          started_at: null,
          started_by: null,
        }),
      );

      await expect(
        useCase.execute({
          actor: adminActor,
          allocationId: '12001',
          expectedAllocationVersion: 1,
          reason: 'Muốn bàn giao thay dù hộ chưa bấm bắt đầu',
          evidence: 'Biên bản #99',
          actualHandoverAt: ACTUAL_HANDOVER_AT,
          now: BASE_NOW,
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
      expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();
      expect(savedAllocationLogs).toHaveLength(0);
    });

    it('rejects Admin handover on already handed_over Allocation with InvalidStateTransitionError', async () => {
      allocationStore.set(
        '12001',
        createSampleAllocation({
          status: 'handed_over',
          version: 4,
          handed_over_at: ACTUAL_HANDOVER_AT,
          handed_over_by: '201',
        }),
      );

      await expect(
        useCase.execute({
          actor: adminActor,
          allocationId: '12001',
          expectedAllocationVersion: 4,
          reason: 'Bàn giao lại',
          evidence: 'Biên bản #100',
          actualHandoverAt: ACTUAL_HANDOVER_AT,
          now: BASE_NOW,
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
    });

    it('rejects Admin handover when QuoteRequest is cancelled (BR-21, BR-24)', async () => {
      requestStore.set(
        '10001',
        createSampleRequest({
          status: 'in_production',
          version: 8,
          cancelled_at: new Date('2026-11-19T08:00:00.000Z'),
          cancelled_by: '1',
          cancel_reason: 'Hủy do thiên tai',
        }),
      );

      await expect(
        useCase.execute({
          actor: adminActor,
          allocationId: '12001',
          expectedAllocationVersion: 3,
          reason: 'Xưởng mất điện',
          evidence: 'Biên bản giao hàng',
          actualHandoverAt: ACTUAL_HANDOVER_AT,
          now: BASE_NOW,
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
      'rejects Admin handover when QuoteRequest status is %s (must be in_production)',
      async (status) => {
        requestStore.set('10001', createSampleRequest({ status }));

        await expect(
          useCase.execute({
            actor: adminActor,
            allocationId: '12001',
            expectedAllocationVersion: 3,
            reason: 'Xưởng mất điện',
            evidence: 'Biên bản bàn giao',
            actualHandoverAt: ACTUAL_HANDOVER_AT,
            now: BASE_NOW,
          }),
        ).rejects.toThrow(InvalidStateTransitionError);

        expect(mockAllocationRepo.update).not.toHaveBeenCalled();
      },
    );

    it('throws ConcurrencyConflictError (409) when expected_allocation_version is stale', async () => {
      await expect(
        useCase.execute({
          actor: adminActor,
          allocationId: '12001',
          expectedAllocationVersion: 2, // current is 3
          reason: 'Xưởng mất điện',
          evidence: 'Biên bản bàn giao',
          actualHandoverAt: ACTUAL_HANDOVER_AT,
          now: BASE_NOW,
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
    });

    it('throws AllocationNotFoundError (404) when Allocation does not exist and QuoteRequestNotFoundError when parent request disappears', async () => {
      await expect(
        useCase.execute({
          actor: adminActor,
          allocationId: '99999',
          expectedAllocationVersion: 1,
          reason: 'Xưởng mất điện',
          evidence: 'Biên bản bàn giao',
          actualHandoverAt: ACTUAL_HANDOVER_AT,
          now: BASE_NOW,
        }),
      ).rejects.toThrow(AllocationNotFoundError);

      requestStore.delete('10001');
      await expect(
        useCase.execute({
          actor: adminActor,
          allocationId: '12001',
          expectedAllocationVersion: 3,
          reason: 'Xưởng mất điện',
          evidence: 'Biên bản bàn giao',
          actualHandoverAt: ACTUAL_HANDOVER_AT,
          now: BASE_NOW,
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);
    });

    it('throws TEMP_PASSWORD_RESTRICTED for temp_password admin and TradingPermissionDeniedError for buyer/artisan without querying repository', async () => {
      await expect(
        useCase.execute({
          actor: tempPasswordAdminActor,
          allocationId: '12001',
          expectedAllocationVersion: 3,
          reason: 'Lý do',
          evidence: 'Căn cứ',
          actualHandoverAt: ACTUAL_HANDOVER_AT,
          now: BASE_NOW,
        }),
      ).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });
      await expect(
        useCase.execute({
          actor: tempPasswordAdminActor,
          allocationId: '12001',
          expectedAllocationVersion: 3,
          reason: 'Lý do',
          evidence: 'Căn cứ',
          actualHandoverAt: ACTUAL_HANDOVER_AT,
          now: BASE_NOW,
        }),
      ).rejects.toBeInstanceOf(TradingDomainError);

      for (const actor of [buyerActor, artisanActor]) {
        await expect(
          useCase.execute({
            actor,
            allocationId: '12001',
            expectedAllocationVersion: 3,
            reason: 'Lý do',
            evidence: 'Căn cứ',
            actualHandoverAt: ACTUAL_HANDOVER_AT,
            now: BASE_NOW,
          }),
        ).rejects.toThrow(TradingPermissionDeniedError);
      }

      expect(mockAllocationRepo.findById).not.toHaveBeenCalled();
    });

    it('rejects invalid allocationId, expected_allocation_version, reason, evidence, and actual_handover_at with InvalidTradingInputError', async () => {
      const baseInput = {
        actor: adminActor,
        allocationId: '12001',
        expectedAllocationVersion: 3,
        reason: 'Xưởng mất điện',
        evidence: 'Biên bản bàn giao',
        actualHandoverAt: ACTUAL_HANDOVER_AT,
        now: BASE_NOW,
      };

      // Invalid IDs
      for (const badId of ['0', '-1', 'abc', '9223372036854775808', '']) {
        await expect(
          useCase.execute({ ...baseInput, allocationId: badId }),
        ).rejects.toThrow(InvalidTradingInputError);
      }

      // Invalid versions
      for (const badVer of [undefined, null, 0, -1, 1.5, 2_147_483_648]) {
        await expect(
          useCase.execute({
            ...baseInput,
            expectedAllocationVersion: badVer as unknown as number,
          }),
        ).rejects.toThrow(InvalidTradingInputError);
      }

      // Missing / blank / oversized reason
      for (const badReason of [
        undefined,
        null,
        '',
        '   \t\n ',
        'A'.repeat(MAX_ADMIN_HANDOVER_TEXT_LENGTH + 1),
      ]) {
        await expect(
          useCase.execute({ ...baseInput, reason: badReason }),
        ).rejects.toThrow(InvalidTradingInputError);
      }

      // Missing / blank / oversized evidence
      for (const badEvidence of [
        undefined,
        null,
        '',
        '   \t\n ',
        'B'.repeat(MAX_ADMIN_HANDOVER_TEXT_LENGTH + 1),
      ]) {
        await expect(
          useCase.execute({ ...baseInput, evidence: badEvidence }),
        ).rejects.toThrow(InvalidTradingInputError);
      }

      // Missing / invalid actual_handover_at
      for (const badAt of [
        undefined,
        null,
        '',
        'not-a-date',
        '2026-11-20',
        '2026-11-20T10:00:00', // missing timezone
        new Date('invalid'),
      ]) {
        await expect(
          useCase.execute({
            ...baseInput,
            actualHandoverAt: badAt as unknown as string,
          }),
        ).rejects.toThrow(InvalidTradingInputError);
      }

      expect(mockAllocationRepo.findById).not.toHaveBeenCalled();
    });

    it('reuses caller-supplied TransactionContext without opening a nested transaction and supports snake_case aliases', async () => {
      const runSpy = vi.spyOn(txRunner, 'run');
      const externalTx = { txId: 'ext-tx-37' } as unknown as TransactionContext;

      const result = await useCase.execute({
        actor: adminActor,
        id: '12001',
        expected_allocation_version: 3,
        reason: 'Xưởng mất điện',
        evidence: 'Biên bản giao hàng số 12',
        actual_handover_at: ACTUAL_HANDOVER_AT.toISOString(),
        now: BASE_NOW,
        tx: externalTx,
      });

      expect(result.allocation.status).toBe('handed_over');
      expect(result.allocation.admin_handed_over).toBe(true);
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

    it('falls back gracefully to WorkshopContract summary when findDetailById returns null', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(null);

      const result = await useCase.execute({
        actor: adminActor,
        allocationId: '12001',
        expectedAllocationVersion: 3,
        reason: 'Xưởng mất mạng',
        evidence: 'Biên bản bàn giao đã ký',
        actualHandoverAt: ACTUAL_HANDOVER_AT,
        now: BASE_NOW,
      });

      expect(result.allocation.workshop).toEqual({
        id: '301',
        name: 'Xưởng gốm mẫu Bát Tràng',
      });
      expect(result.allocation.handed_over_by).toEqual({
        id: '1',
        display_name: null,
      });
      expect(result.allocation.handed_over_at).toBe(BASE_NOW.toISOString());
      expect(result.allocation.admin_handed_over).toBe(true);
      expect(result.allocation.admin_handover_reason).toBe('Xưởng mất mạng');
      expect(result.allocation.admin_delivery_evidence).toBe(
        'Biên bản bàn giao đã ký',
      );
      expect(result.allocation.admin_handover_actual_at).toBe(
        ACTUAL_HANDOVER_AT.toISOString(),
      );
      expect(result.allocation.traceability_warning).toBe('NO_BATCH_LINK');
    });
  });

  // =========================================================================
  // Suite B: DTO Schema, Controller Metadata & TradingModule DI
  // =========================================================================
  describe('Suite B: DTO Schema, Controller Metadata & TradingModule DI', () => {
    it('validates HandoverAllocationByAdminDto strictly, trims reason/evidence, and rejects missing, invalid, or unknown fields', () => {
      expect(RecordAdminHandoverDto).toBe(HandoverAllocationByAdminDto);
      expect(RecordAdminHandoverUseCase).toBe(HandoverAllocationByAdminUseCase);

      expect(
        handoverAllocationByAdminSchema.parse({
          expected_allocation_version: 3,
          reason: '  Xưởng mất điện lưới  ',
          evidence: '  Biên bản bàn giao số 12/2026  ',
          actual_handover_at: '2026-11-20T10:00:00.000Z',
        }),
      ).toEqual({
        expected_allocation_version: 3,
        reason: 'Xưởng mất điện lưới',
        evidence: 'Biên bản bàn giao số 12/2026',
        actual_handover_at: '2026-11-20T10:00:00.000Z',
      });

      // Missing fields
      expect(() =>
        handoverAllocationByAdminSchema.parse({
          expected_allocation_version: 3,
          reason: 'Xưởng mất điện',
          evidence: 'Biên bản #1',
        }),
      ).toThrow();

      // Blank reason or evidence
      expect(() =>
        handoverAllocationByAdminSchema.parse({
          expected_allocation_version: 3,
          reason: '   ',
          evidence: 'Biên bản #1',
          actual_handover_at: '2026-11-20T10:00:00.000Z',
        }),
      ).toThrow();

      expect(() =>
        handoverAllocationByAdminSchema.parse({
          expected_allocation_version: 3,
          reason: 'Xưởng mất điện',
          evidence: '   ',
          actual_handover_at: '2026-11-20T10:00:00.000Z',
        }),
      ).toThrow();

      // Oversized reason / evidence
      expect(() =>
        handoverAllocationByAdminSchema.parse({
          expected_allocation_version: 3,
          reason: 'x'.repeat(MAX_ADMIN_HANDOVER_TEXT_LENGTH + 1),
          evidence: 'Biên bản #1',
          actual_handover_at: '2026-11-20T10:00:00.000Z',
        }),
      ).toThrow();

      expect(() =>
        handoverAllocationByAdminSchema.parse({
          expected_allocation_version: 3,
          reason: 'Xưởng mất điện',
          evidence: 'y'.repeat(MAX_ADMIN_HANDOVER_TEXT_LENGTH + 1),
          actual_handover_at: '2026-11-20T10:00:00.000Z',
        }),
      ).toThrow();

      // Invalid datetime format
      expect(() =>
        handoverAllocationByAdminSchema.parse({
          expected_allocation_version: 3,
          reason: 'Xưởng mất điện',
          evidence: 'Biên bản #1',
          actual_handover_at: '2026-11-20',
        }),
      ).toThrow();

      // Unknown extra fields rejected (mass-assignment protection, SEC-06/SEC-07)
      expect(() =>
        handoverAllocationByAdminSchema.parse({
          expected_allocation_version: 3,
          reason: 'Xưởng mất điện',
          evidence: 'Biên bản #1',
          actual_handover_at: '2026-11-20T10:00:00.000Z',
          admin_handed_over: true,
        }),
      ).toThrow();

      expect(() =>
        handoverAllocationByAdminSchema.parse({
          expected_allocation_version: 3,
          admin_handover_reason: 'Xưởng mất điện',
          evidence: 'Biên bản #1',
          actual_handover_at: '2026-11-20T10:00:00.000Z',
        }),
      ).toThrow();
    });

    it('verifies AdminAllocationController metadata and TradingModule controllers & exports', () => {
      expect(
        Reflect.getMetadata(PATH_METADATA, AdminAllocationController),
      ).toBe('admin/allocations');
      expect(
        Reflect.getMetadata(ACCESS_POLICY, AdminAllocationController),
      ).toEqual({ kind: 'roles', roles: ['admin'] });
      expect(
        Reflect.getMetadata(SESSION_LEVELS, AdminAllocationController),
      ).toEqual(['normal']);

      const proto = AdminAllocationController.prototype;
      const mutationMeta = Reflect.getMetadata(
        TRADING_MUTATION_METADATA_KEY,
        proto.handoverAllocationByAdmin,
      );
      expect(mutationMeta).toEqual({
        action: 'handover_allocation_by_admin',
        objectType: 'Allocation',
        objectIdParam: 'id',
        expectedVersionField: 'expected_allocation_version',
      });

      const paramTypes = Reflect.getMetadata(
        'design:paramtypes',
        proto,
        'handoverAllocationByAdmin',
      );
      expect(paramTypes).toBeDefined();
      expect(paramTypes).toHaveLength(4);
      expect(paramTypes[2]).toBe(HandoverAllocationByAdminDto);

      const moduleControllers = Reflect.getMetadata(
        'controllers',
        TradingModule,
      ) as unknown[];
      expect(moduleControllers).toContain(AdminAllocationController);

      const moduleExports = Reflect.getMetadata(
        'exports',
        TradingModule,
      ) as unknown[];
      expect(moduleExports).toContain(HandoverAllocationByAdminUseCase);
    });
  });

  // =========================================================================
  // Suite C: HTTP Controller + Guards + TradingMutationInterceptor + Idempotency
  // =========================================================================
  describe('Suite C: HTTP Controller + TradingMutationInterceptor + Idempotency', () => {
    const identityMock = new MockIdentityContract();
    const txRunner = new MockTransactionRunner();
    const workshopContract = new MockWorkshopContract();

    let allocationStore: Map<string, Allocation>;
    let requestStore: Map<string, QuoteRequest>;
    let savedAllocationLogs: AllocationLogRecord[];
    let idempotencyStore: Map<string, PersistedIdempotencyRecord<unknown>>;
    let nextIdempotencyId: bigint;

    const mockAllocationRepo = {
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
            throw new ConcurrencyConflictError('Allocation version conflict.');
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
      controllers: [AdminAllocationController],
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
          provide: HandoverAllocationByAdminUseCase,
          useFactory: (
            tr: TransactionRunner,
            allocRepo: IAllocationRepository,
            qrRepo: IQuoteRequestRepository,
            wc: IWorkshopContract,
          ) => new HandoverAllocationByAdminUseCase(tr, allocRepo, qrRepo, wc),
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
      savedAllocationLogs = [];
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
        if (token === 'session-admin-1') return adminActor;
        if (token === 'session-temp-admin') return tempPasswordAdminActor;
        if (token === 'session-buyer-101') return buyerActor;
        if (token === 'session-artisan-301') return artisanActor;
        return null;
      });
    });

    it('documents POST /api/v1/admin/allocations/{id}/handover-by-admin in OpenAPI Swagger doc', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const endpoint =
        doc.paths?.['/api/v1/admin/allocations/{id}/handover-by-admin'];
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
      expect(endpoint?.post?.responses?.['422']).toBeDefined();
      expect(endpoint?.post?.responses?.['409']).toBeDefined();
    });

    it('POST /admin/allocations/:id/handover-by-admin returns 200 OK with AllocationDto, operation metadata, and AllocationLog(is_admin_action=true)', async () => {
      const idempotencyKey = randomUUID();
      const pastTimestamp = new Date(Date.now() - 60_000).toISOString();

      const res = await fetch(
        `${base}/admin/allocations/12001/handover-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            expected_allocation_version: 3,
            reason: 'Xưởng mất điện không truy cập được phần mềm.',
            evidence: 'Biên bản ký nhận bàn giao hàng giấy số BB-012/2026.',
            actual_handover_at: pastTimestamp,
          }),
        },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(allocationDtoResponseSchema.parse(json.data)).toEqual(json.data);
      expect(json.data.status).toBe('handed_over');
      expect(json.data.version).toBe(4);
      expect(json.data.handed_over_by).toEqual({
        id: '1',
        display_name: null,
      });
      expect(json.data.admin_handed_over).toBe(true);
      expect(json.data.admin_handover_reason).toBe(
        'Xưởng mất điện không truy cập được phần mềm.',
      );
      expect(json.data.admin_delivery_evidence).toBe(
        'Biên bản ký nhận bàn giao hàng giấy số BB-012/2026.',
      );
      expect(json.data.admin_handover_actual_at).toBe(pastTimestamp);
      expect(json.data.traceability_warning).toBe('NO_BATCH_LINK');

      expect(
        handoverAllocationByAdminOperationResponseSchema.parse(json.operation),
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

      expect(savedAllocationLogs).toHaveLength(1);
      expect(savedAllocationLogs[0]?.event_type).toBe('handover_by_admin');
      expect(savedAllocationLogs[0]?.is_admin_action).toBe(true);
      expect(savedAllocationLogs[0]?.performed_by).toBe('1');
    });

    it('replays identical X-Idempotency-Key + payload with replayed=true and fresh current_state, and returns 409 IDEMPOTENCY_CONFLICT on different payload', async () => {
      const idempotencyKey = randomUUID();
      const pastTimestamp = new Date(Date.now() - 120_000).toISOString();
      const bodyPayload = {
        expected_allocation_version: 3,
        reason: 'Xưởng mất điện.',
        evidence: 'Biên bản mẫu đã ký.',
        actual_handover_at: pastTimestamp,
      };

      const firstRes = await fetch(
        `${base}/admin/allocations/12001/handover-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(bodyPayload),
        },
      );
      expect(firstRes.status).toBe(200);
      const firstJson = await firstRes.json();

      // Simulate parent request later progressing to delivered (version 8)
      requestStore.set(
        '10001',
        createSampleRequest({ status: 'delivered', version: 8 }),
      );

      // Replay with same key & payload (even though allocation version is now 4, not 3)
      const replayRes = await fetch(
        `${base}/admin/allocations/12001/handover-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(bodyPayload),
        },
      );
      expect(replayRes.status).toBe(200);
      const replayJson = await replayRes.json();
      expect(replayJson.data).toEqual(firstJson.data);
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
      // No second update or duplicate AllocationLog
      expect(mockAllocationRepo.update).toHaveBeenCalledTimes(1);
      expect(savedAllocationLogs).toHaveLength(1);

      // Reuse key with different payload -> 409 IDEMPOTENCY_CONFLICT
      const conflictRes = await fetch(
        `${base}/admin/allocations/12001/handover-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            ...bodyPayload,
            reason: 'Lý do khác hoàn toàn',
          }),
        },
      );
      expect(conflictRes.status).toBe(409);
      expect(conflictRes.headers.get('content-type')).toContain(
        'application/problem+json',
      );
      const conflictJson = await conflictRes.json();
      expect(conflictJson.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('returns 422 DEADLINE_VIOLATION when actual_handover_at is in the future', async () => {
      const futureTimestamp = new Date(Date.now() + 3_600_000).toISOString();
      const res = await fetch(
        `${base}/admin/allocations/12001/handover-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_allocation_version: 3,
            reason: 'Xưởng mất điện',
            evidence: 'Biên bản bàn giao #05',
            actual_handover_at: futureTimestamp,
          }),
        },
      );

      expect(res.status).toBe(422);
      expect(res.headers.get('content-type')).toContain(
        'application/problem+json',
      );
      const problem = await res.json();
      expect(problem.code).toBe('DEADLINE_VIOLATION');
      expect(mockAllocationRepo.update).not.toHaveBeenCalled();
    });

    it('returns 422 INVALID_STATE when Allocation is not_started', async () => {
      allocationStore.set(
        '12001',
        createSampleAllocation({
          status: 'not_started',
          version: 1,
          started_at: null,
          started_by: null,
        }),
      );

      const res = await fetch(
        `${base}/admin/allocations/12001/handover-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_allocation_version: 1,
            reason: 'Xưởng mất điện',
            evidence: 'Biên bản bàn giao #05',
            actual_handover_at: new Date(Date.now() - 60_000).toISOString(),
          }),
        },
      );

      expect(res.status).toBe(422);
      const problem = await res.json();
      expect(problem.code).toBe('INVALID_STATE');
    });

    it('returns 409 CONCURRENCY_CONFLICT for stale expected_allocation_version and 404 RESOURCE_NOT_FOUND for unknown allocation', async () => {
      const pastTimestamp = new Date(Date.now() - 60_000).toISOString();

      const staleRes = await fetch(
        `${base}/admin/allocations/12001/handover-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_allocation_version: 2,
            reason: 'Xưởng mất điện',
            evidence: 'Biên bản bàn giao #05',
            actual_handover_at: pastTimestamp,
          }),
        },
      );
      expect(staleRes.status).toBe(409);
      expect((await staleRes.json()).code).toBe('CONCURRENCY_CONFLICT');

      const notFoundRes = await fetch(
        `${base}/admin/allocations/99999/handover-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_allocation_version: 1,
            reason: 'Xưởng mất điện',
            evidence: 'Biên bản bàn giao #05',
            actual_handover_at: pastTimestamp,
          }),
        },
      );
      expect(notFoundRes.status).toBe(404);
      expect((await notFoundRes.json()).code).toBe('RESOURCE_NOT_FOUND');
    });

    it('enforces authentication (401), role authorization (403 buyer/artisan), temp_password restriction (403), missing idempotency key (400), and strict DTO validation (400)', async () => {
      const pastTimestamp = new Date(Date.now() - 60_000).toISOString();
      const validBody = JSON.stringify({
        expected_allocation_version: 3,
        reason: 'Xưởng mất điện',
        evidence: 'Biên bản bàn giao #05',
        actual_handover_at: pastTimestamp,
      });

      // Unauthenticated -> 401
      const unauthRes = await fetch(
        `${base}/admin/allocations/12001/handover-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': randomUUID(),
          },
          body: validBody,
        },
      );
      expect(unauthRes.status).toBe(401);
      expect((await unauthRes.json()).code).toBe('AUTHENTICATION_REQUIRED');

      // Buyer -> 403 PERMISSION_DENIED
      const buyerRes = await fetch(
        `${base}/admin/allocations/12001/handover-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
            'X-Idempotency-Key': randomUUID(),
          },
          body: validBody,
        },
      );
      expect(buyerRes.status).toBe(403);
      expect((await buyerRes.json()).code).toBe('PERMISSION_DENIED');

      // Artisan -> 403 PERMISSION_DENIED
      const artisanRes = await fetch(
        `${base}/admin/allocations/12001/handover-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-artisan-301',
            'X-Idempotency-Key': randomUUID(),
          },
          body: validBody,
        },
      );
      expect(artisanRes.status).toBe(403);
      expect((await artisanRes.json()).code).toBe('PERMISSION_DENIED');

      // Temp password Admin -> 403 TEMP_PASSWORD_RESTRICTED
      const tempRes = await fetch(
        `${base}/admin/allocations/12001/handover-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-temp-admin',
            'X-Idempotency-Key': randomUUID(),
          },
          body: validBody,
        },
      );
      expect(tempRes.status).toBe(403);
      expect((await tempRes.json()).code).toBe('TEMP_PASSWORD_RESTRICTED');

      // Missing X-Idempotency-Key -> 400 INVALID_INPUT
      const missingKeyRes = await fetch(
        `${base}/admin/allocations/12001/handover-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
          },
          body: validBody,
        },
      );
      expect(missingKeyRes.status).toBe(400);
      expect((await missingKeyRes.json()).code).toBe('INVALID_INPUT');

      // Unknown extra field -> 400 INVALID_INPUT
      const extraFieldRes = await fetch(
        `${base}/admin/allocations/12001/handover-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_allocation_version: 3,
            reason: 'Xưởng mất điện',
            evidence: 'Biên bản bàn giao #05',
            actual_handover_at: pastTimestamp,
            status: 'handed_over',
          }),
        },
      );
      expect(extraFieldRes.status).toBe(400);
      expect((await extraFieldRes.json()).code).toBe('INVALID_INPUT');
    });
  });
});
