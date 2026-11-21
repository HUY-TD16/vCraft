import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
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
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import { createApiDocument } from '../../../../src/common/http/swagger/configure-swagger';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../../../src/common/application/ports/transaction-runner';
import { IDENTITY_CONTRACT } from '../../../../src/modules/identity/public/contracts/identity.contract';
import {
  ALLOCATION_REPOSITORY,
  IDEMPOTENCY_RECORD_REPOSITORY,
  QUOTE_REPOSITORY,
  QUOTE_REQUEST_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
  type IIdempotencyRecordRepository,
  type IQuoteRequestRepository,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import type {
  CreateIdempotencyRecordInput,
  IdempotencyScopeKey,
  PersistedIdempotencyRecord,
  PersistedStatusLogRecord,
} from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';
import { TradingIdempotencyService } from '../../../../src/modules/trading/application/services/trading-idempotency.service';
import { CancelQuoteRequestByAdminUseCase } from '../../../../src/modules/trading/application/use-cases/requests/cancel-quote-request-by-admin.use-case';
import { ListAdminQuoteRequestsUseCase } from '../../../../src/modules/trading/application/use-cases/requests/list-admin-quote-requests.use-case';
import { AdminQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/admin-quote-request.controller';
import { buyerRequestDtoResponseSchema } from '../../../../src/modules/trading/adapters/http/dtos/create-draft-quote-request.dto';
import {
  CancelQuoteRequestByAdminDto,
  cancelQuoteRequestByAdminOperationResponseSchema,
  cancelQuoteRequestByAdminSchema,
} from '../../../../src/modules/trading/adapters/http/dtos/cancel-quote-request-by-admin.dto';
import { TRADING_MUTATION_METADATA_KEY } from '../../../../src/modules/trading/adapters/http/decorators/trading-mutation.decorator';
import {
  TRADING_CURRENT_STATE_RESOLVER,
  TradingCurrentStateResolver,
} from '../../../../src/modules/trading/adapters/http/interceptors/trading-current-state.resolver';
import { TradingMutationInterceptor } from '../../../../src/modules/trading/adapters/http/interceptors/trading-mutation.interceptor';
import { TradingModule } from '../../../../src/modules/trading/trading.module';
import {
  Allocation,
  ConcurrencyConflictError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  MAX_CANCEL_REASON_LENGTH,
  QuoteRequest,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
  type AllocationStatus,
  type RequestStatus,
  type StatusLogRecord,
} from '../../../../src/modules/trading/domain';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';

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
function createSampleRequest(
  overrides: Partial<{
    id: string;
    buyer_id: string;
    status: RequestStatus;
    version: number;
    bidding_deadline: Date | null;
    delivery_deadline: Date | null;
    bidding_closed_at: Date | null;
    cancelled_at: Date | null;
    cancelled_by: string | null;
    cancel_reason: string | null;
  }> = {},
): QuoteRequest {
  const baseNow = new Date('2026-11-10T08:00:00.000Z');
  return QuoteRequest.reconstitute({
    id: overrides.id ?? '10001',
    buyer_id: overrides.buyer_id ?? '101',
    category_id: '1',
    spec: '5.000 cốc gốm men trắng 300ml in logo Bát Tràng',
    quantity: 5000,
    unit: 'piece',
    unit_set_description: null,
    status: overrides.status ?? 'in_production',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Phường Cầu Giấy, TP. Hà Nội',
    delivery_address: 'Số 88 Phố Duy Tân, Cầu Giấy, Hà Nội',
    recipient_name: 'Nguyễn Văn An',
    recipient_phone: '0987654321',
    bidding_deadline:
      overrides.bidding_deadline !== undefined
        ? overrides.bidding_deadline
        : new Date('2026-11-15T17:00:00.000Z'),
    delivery_deadline:
      overrides.delivery_deadline !== undefined
        ? overrides.delivery_deadline
        : new Date('2026-12-15T17:00:00.000Z'),
    bidding_closed_at:
      overrides.bidding_closed_at !== undefined
        ? overrides.bidding_closed_at
        : new Date('2026-11-14T10:00:00.000Z'),
    version: overrides.version ?? 6,
    cancelled_at: overrides.cancelled_at ?? null,
    cancelled_by: overrides.cancelled_by ?? null,
    cancel_reason: overrides.cancel_reason ?? null,
    created_at: baseNow,
    updated_at: baseNow,
  });
}

function createSampleAllocation(
  overrides: Partial<{
    id: string;
    request_id: string;
    workshop_id: string;
    status: AllocationStatus;
    version: number;
  }> = {},
): Allocation {
  const baseNow = new Date('2026-11-14T10:00:00.000Z');
  const status = overrides.status ?? 'in_production';
  return Allocation.reconstitute({
    id: overrides.id ?? '12001',
    request_id: overrides.request_id ?? '10001',
    workshop_id: overrides.workshop_id ?? '301',
    quote_id: '401',
    quantity: 5000,
    unit_price: 45_000,
    committed_delivery_at: new Date('2026-12-10T17:00:00.000Z'),
    status,
    version: overrides.version ?? 2,
    started_at: status !== 'not_started' ? baseNow : null,
    started_by: status !== 'not_started' ? '201' : null,
    handed_over_at: status === 'handed_over' ? new Date('2026-11-20T09:00:00.000Z') : null,
    handed_over_by: status === 'handed_over' ? '201' : null,
    delivery_note: status === 'handed_over' ? 'Đã bàn giao đủ 5.000 cốc' : null,
    admin_handed_over: false,
    admin_handover_reason: null,
    admin_delivery_evidence: null,
    admin_handover_actual_at: null,
    created_at: baseNow,
    updated_at: baseNow,
  });
}

describe('Task 36: CancelQuoteRequestByAdmin (UC-27, BR-21, BR-22, BR-26, BR-27)', () => {
  // =========================================================================
  // Suite A: CancelQuoteRequestByAdminUseCase & Domain Invariants
  // =========================================================================
  describe('Suite A: CancelQuoteRequestByAdminUseCase', () => {
    let txRunner: MockTransactionRunner;
    let requestStore: Map<string, QuoteRequest>;
    let allocationStore: Map<string, Allocation>;
    let savedStatusLogs: StatusLogRecord[];

    let mockQuoteRequestRepo: {
      lockById: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      findDetailById: ReturnType<typeof vi.fn>;
    };
    let useCase: CancelQuoteRequestByAdminUseCase;

    beforeEach(() => {
      txRunner = new MockTransactionRunner();
      requestStore = new Map([['10001', createSampleRequest()]]);
      allocationStore = new Map([['12001', createSampleAllocation()]]);
      savedStatusLogs = [];

      mockQuoteRequestRepo = {
        lockById: vi.fn(async (id: string) => requestStore.get(id) ?? null),
        update: vi.fn(
          async (input: {
            request: QuoteRequest;
            expectedVersion?: number;
            statusLogs?: readonly StatusLogRecord[];
          }) => {
            const existing = requestStore.get(input.request.id);
            if (!existing || existing.version !== input.expectedVersion) {
              throw new ConcurrencyConflictError(
                'QuoteRequest version conflict.',
              );
            }
            requestStore.set(input.request.id, input.request);
            if (input.statusLogs) {
              savedStatusLogs.push(...input.statusLogs);
            }
            return input.request;
          },
        ),
        findDetailById: vi.fn(async (id: string) => {
          const req = requestStore.get(id);
          if (!req) return null;
          const persistedLogs: Array<{
            entity: PersistedStatusLogRecord;
            performedBy: { id: string; display_name: string | null } | null;
          }> = savedStatusLogs.map((l, idx) => ({
            entity: {
              id: String(7000 + idx),
              ...l,
            },
            performedBy: l.performed_by
              ? {
                  id: l.performed_by,
                  display_name: 'Ban quản lý làng gốm Bát Tràng',
                }
              : null,
          }));
          return {
            entity: req,
            category: { id: '1', name: 'Ấm, chén và cốc' },
            recipients: [],
            quotes: [],
            allocations: Array.from(allocationStore.values())
              .filter((a) => a.request_id === id)
              .map((entity) => ({ entity })),
            statusLogs: persistedLogs,
          };
        }),
      };

      useCase = new CancelQuoteRequestByAdminUseCase(
        txRunner,
        mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
      );
    });

    it('cancels QuoteRequest in in_production (even when all Allocations are handed_over), preserves primary status & allocations, records cancel_reason and goods_handling_note in StatusLog', async () => {
      allocationStore.set(
        '12001',
        createSampleAllocation({ status: 'handed_over', version: 3 }),
      );
      const fixedNow = new Date('2026-11-21T10:30:00.000Z');

      const result = await useCase.execute({
        actor: adminActor,
        requestId: '10001',
        expectedRequestVersion: 6,
        cancelReason: '  Sự cố bất khả kháng thiên tai ngập xưởng sản xuất  ',
        goodsHandlingNote:
          '  1.000 sản phẩm đã bàn giao được đối soát thanh toán ngoài hệ thống theo giá báo chào  ',
        now: fixedNow,
      });

      expect(result.request.id).toBe('10001');
      expect(result.request.status).toBe('in_production');
      expect(result.request.version).toBe(7);
      expect(result.request.cancelled_at).toBe(fixedNow.toISOString());
      expect(result.request.cancel_reason).toBe(
        'Sự cố bất khả kháng thiên tai ngập xưởng sản xuất',
      );
      expect(result.request.is_bidding_open).toBe(false);
      expect(result.request.no_valid_quotes).toBe(false);
      expect(result.request.delivery_confirmation).toBeNull();
      expect(result.request.category).toEqual({
        id: '1',
        name: 'Ấm, chén và cốc',
      });
      expect(result.currentState).toEqual({
        request: {
          id: '10001',
          status: 'in_production',
          version: 7,
          cancelled_at: fixedNow.toISOString(),
        },
      });

      const persisted = requestStore.get('10001')!;
      expect(persisted.cancelled_by).toBe('1');
      expect(persisted.isCancelled()).toBe(true);

      // BR-22: Allocations and recorded handover progress are preserved untouched
      const preservedAllocation = allocationStore.get('12001')!;
      expect(preservedAllocation.status).toBe('handed_over');
      expect(preservedAllocation.quantity).toBe(5000);

      expect(savedStatusLogs).toHaveLength(1);
      expect(savedStatusLogs[0]).toEqual({
        request_id: '10001',
        event_type: 'cancelled',
        prev_status: 'in_production',
        new_status: 'in_production',
        performed_by: '1',
        is_admin_action: true,
        note: 'Sự cố bất khả kháng thiên tai ngập xưởng sản xuất',
        evidence:
          '1.000 sản phẩm đã bàn giao được đối soát thanh toán ngoài hệ thống theo giá báo chào',
        created_at: fixedNow,
      });
    });

    it('cancels QuoteRequest in buyer_accepted with mandatory cancel_reason and goods_handling_note', async () => {
      requestStore.set(
        '10001',
        createSampleRequest({ status: 'buyer_accepted', version: 4 }),
      );
      const fixedNow = new Date('2026-11-16T09:00:00.000Z');

      const result = await useCase.execute({
        actor: adminActor,
        requestId: '10001',
        expectedRequestVersion: 4,
        cancelReason: 'Xưởng gặp hỏa hoạn trước khi khởi công sản xuất',
        goodsHandlingNote:
          'Chưa có hàng hóa sản xuất hoặc bàn giao; hai bên tự chốt hủy hợp đồng ngoài hệ thống',
        now: fixedNow,
      });

      expect(result.request.status).toBe('buyer_accepted');
      expect(result.request.version).toBe(5);
      expect(result.request.cancelled_at).toBe(fixedNow.toISOString());
      expect(savedStatusLogs).toHaveLength(1);
      expect(savedStatusLogs[0]).toEqual({
        request_id: '10001',
        event_type: 'cancelled',
        prev_status: 'buyer_accepted',
        new_status: 'buyer_accepted',
        performed_by: '1',
        is_admin_action: true,
        note: 'Xưởng gặp hỏa hoạn trước khi khởi công sản xuất',
        evidence:
          'Chưa có hàng hóa sản xuất hoặc bàn giao; hai bên tự chốt hủy hợp đồng ngoài hệ thống',
        created_at: fixedNow,
      });
    });

    it('blocks all subsequent mutations after Admin cancellation (BR-21, BR-22)', async () => {
      const fixedNow = new Date('2026-11-21T10:30:00.000Z');
      await useCase.execute({
        actor: adminActor,
        requestId: '10001',
        expectedRequestVersion: 6,
        cancelReason: 'Thiên tai ngập lụt xưởng',
        goodsHandlingNote: 'Không phát sinh bàn giao, xử lý ngoài hệ thống',
        now: fixedNow,
      });

      const cancelledRequest = requestStore.get('10001')!;
      const notStartedAllocation = createSampleAllocation({
        status: 'not_started',
        version: 1,
      });
      const inProdAllocation = createSampleAllocation({
        status: 'in_production',
        version: 2,
      });

      // 1. Artisan cannot start production
      expect(() =>
        notStartedAllocation.startProduction({
          request: cancelledRequest,
          actorId: '201',
          actorWorkshopId: '301',
          expectedVersion: 1,
          now: fixedNow,
        }),
      ).toThrow(InvalidStateTransitionError);

      // 2. Artisan cannot link batches
      expect(() =>
        inProdAllocation.replaceBatchLinks({
          request: cancelledRequest,
          actorId: '201',
          actorWorkshopId: '301',
          expectedVersion: 2,
          links: [{ batch_id: '901', linked_quantity: 1000 }],
          ownedBatchIds: new Set(['901']),
          now: fixedNow,
        }),
      ).toThrow(InvalidStateTransitionError);

      // 3. Artisan cannot hand over allocation
      expect(() =>
        inProdAllocation.recordArtisanHandover({
          request: cancelledRequest,
          actorId: '201',
          actorWorkshopId: '301',
          expectedVersion: 2,
          deliveryNote: 'Cố bàn giao sau hủy',
          now: fixedNow,
        }),
      ).toThrow(InvalidStateTransitionError);

      // 4. Buyer cannot confirm delivery
      expect(() =>
        cancelledRequest.confirmDelivered({
          actorId: '101',
          actorRole: 'buyer',
          expectedVersion: cancelledRequest.version,
          allocationStatuses: ['handed_over'],
          now: fixedNow,
        }),
      ).toThrow(InvalidStateTransitionError);

      // 5. Buyer cannot update recipient contact
      expect(() =>
        cancelledRequest.updateRecipientContact({
          buyerId: '101',
          expectedVersion: cancelledRequest.version,
          recipientName: 'Người nhận mới',
          now: fixedNow,
        }),
      ).toThrow(InvalidStateTransitionError);

      // 6. Admin cannot cancel a second time with a new operation
      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '10001',
          expectedRequestVersion: cancelledRequest.version,
          cancelReason: 'Hủy lần 2',
          goodsHandlingNote: 'Ghi chú lần 2',
          now: fixedNow,
        }),
      ).rejects.toBeInstanceOf(InvalidStateTransitionError);
    });

    it('falls back cleanly when findDetailById is not provided on repository mock', async () => {
      const minimalRepo = {
        lockById: mockQuoteRequestRepo.lockById,
        update: mockQuoteRequestRepo.update,
      } as unknown as IQuoteRequestRepository;
      const minimalUseCase = new CancelQuoteRequestByAdminUseCase(
        txRunner,
        minimalRepo,
      );

      const fixedNow = new Date('2026-11-21T11:00:00.000Z');
      const result = await minimalUseCase.execute({
        actor: adminActor,
        requestId: '10001',
        expectedRequestVersion: 6,
        cancelReason: 'Sự cố lò nung sập',
        goodsHandlingNote: 'Đền bù và thu hồi ngoài hệ thống',
        now: fixedNow,
      });

      expect(result.request.status).toBe('in_production');
      expect(result.request.cancelled_at).toBe(fixedNow.toISOString());
      expect(result.request.cancel_reason).toBe('Sự cố lò nung sập');
      expect(result.request.category).toEqual({ id: '1', name: '' });
    });

    it.each<RequestStatus>([
      'draft_request',
      'sent_to_artisans',
      'artisans_bidding',
      'delivered',
    ])(
      'rejects Admin cancellation when status is "%s" (422 INVALID_STATE)',
      async (status) => {
        requestStore.set('10001', createSampleRequest({ status, version: 6 }));

        await expect(
          useCase.execute({
            actor: adminActor,
            requestId: '10001',
            expectedRequestVersion: 6,
            cancelReason: 'Sự cố bất khả kháng',
            goodsHandlingNote: 'Xử lý ngoài hệ thống',
          }),
        ).rejects.toBeInstanceOf(InvalidStateTransitionError);

        expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();
        expect(savedStatusLogs).toHaveLength(0);
      },
    );

    it('rejects cancelling a missing QuoteRequest with 404 RESOURCE_NOT_FOUND', async () => {
      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '99999',
          expectedRequestVersion: 6,
          cancelReason: 'Sự cố',
          goodsHandlingNote: 'Xử lý ngoài hệ thống',
        }),
      ).rejects.toBeInstanceOf(QuoteRequestNotFoundError);

      expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();
    });

    it('rejects non-admin roles and temp_password sessions', async () => {
      await expect(
        useCase.execute({
          actor: buyerActor,
          requestId: '10001',
          expectedRequestVersion: 6,
          cancelReason: 'Sự cố',
          goodsHandlingNote: 'Xử lý ngoài hệ thống',
        }),
      ).rejects.toBeInstanceOf(TradingPermissionDeniedError);

      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRequestVersion: 6,
          cancelReason: 'Sự cố',
          goodsHandlingNote: 'Xử lý ngoài hệ thống',
        }),
      ).rejects.toBeInstanceOf(TradingPermissionDeniedError);

      await expect(
        useCase.execute({
          actor: tempPasswordAdminActor,
          requestId: '10001',
          expectedRequestVersion: 6,
          cancelReason: 'Sự cố',
          goodsHandlingNote: 'Xử lý ngoài hệ thống',
        }),
      ).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });
      await expect(
        useCase.execute({
          actor: tempPasswordAdminActor,
          requestId: '10001',
          expectedRequestVersion: 6,
          cancelReason: 'Sự cố',
          goodsHandlingNote: 'Xử lý ngoài hệ thống',
        }),
      ).rejects.toBeInstanceOf(TradingDomainError);
    });

    it('rejects stale expected_request_version with 409 CONCURRENCY_CONFLICT', async () => {
      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '10001',
          expectedRequestVersion: 5,
          cancelReason: 'Sự cố',
          goodsHandlingNote: 'Xử lý ngoài hệ thống',
        }),
      ).rejects.toBeInstanceOf(ConcurrencyConflictError);

      expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();
    });

    it('rejects missing/blank/oversized cancel_reason and goods_handling_note, invalid requestId, and invalid expected_request_version', async () => {
      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: 'abc',
          expectedRequestVersion: 6,
          cancelReason: 'Sự cố',
          goodsHandlingNote: 'Xử lý',
        }),
      ).rejects.toBeInstanceOf(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '10001',
          cancelReason: 'Sự cố',
          goodsHandlingNote: 'Xử lý',
        }),
      ).rejects.toBeInstanceOf(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '10001',
          expectedRequestVersion: 0,
          cancelReason: 'Sự cố',
          goodsHandlingNote: 'Xử lý',
        }),
      ).rejects.toBeInstanceOf(InvalidTradingInputError);

      // Missing / blank / oversized cancel_reason
      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '10001',
          expectedRequestVersion: 6,
          cancelReason: '   ',
          goodsHandlingNote: 'Xử lý ngoài hệ thống',
        }),
      ).rejects.toBeInstanceOf(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '10001',
          expectedRequestVersion: 6,
          cancelReason: 'a'.repeat(MAX_CANCEL_REASON_LENGTH + 1),
          goodsHandlingNote: 'Xử lý ngoài hệ thống',
        }),
      ).rejects.toBeInstanceOf(InvalidTradingInputError);

      // Missing / blank / oversized goods_handling_note (even in buyer_accepted)
      requestStore.set(
        '10001',
        createSampleRequest({ status: 'buyer_accepted', version: 6 }),
      );
      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '10001',
          expectedRequestVersion: 6,
          cancelReason: 'Sự cố bất khả kháng',
          goodsHandlingNote: undefined,
        }),
      ).rejects.toBeInstanceOf(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '10001',
          expectedRequestVersion: 6,
          cancelReason: 'Sự cố bất khả kháng',
          goodsHandlingNote: '   ',
        }),
      ).rejects.toBeInstanceOf(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '10001',
          expectedRequestVersion: 6,
          cancelReason: 'Sự cố bất khả kháng',
          goodsHandlingNote: 'b'.repeat(MAX_CANCEL_REASON_LENGTH + 1),
        }),
      ).rejects.toBeInstanceOf(InvalidTradingInputError);
    });
  });

  // =========================================================================
  // Suite B: DTO Schema, Controller Metadata & TradingModule DI
  // =========================================================================
  describe('Suite B: DTO, Controller Metadata & TradingModule DI', () => {
    it('validates CancelQuoteRequestByAdminDto strictly (requires non-empty cancel_reason and goods_handling_note, max 10000, rejects unknown fields)', () => {
      expect(
        cancelQuoteRequestByAdminSchema.parse({
          expected_request_version: 6,
          cancel_reason: '  Thiên tai ngập xưởng  ',
          goods_handling_note: '  Đối soát 1.000 chiếc đã bàn giao ngoài hệ thống  ',
        }),
      ).toEqual({
        expected_request_version: 6,
        cancel_reason: 'Thiên tai ngập xưởng',
        goods_handling_note: 'Đối soát 1.000 chiếc đã bàn giao ngoài hệ thống',
      });

      // Missing cancel_reason
      expect(() =>
        cancelQuoteRequestByAdminSchema.parse({
          expected_request_version: 6,
          goods_handling_note: 'Xử lý ngoài hệ thống',
        }),
      ).toThrow();

      // Blank cancel_reason
      expect(() =>
        cancelQuoteRequestByAdminSchema.parse({
          expected_request_version: 6,
          cancel_reason: '   ',
          goods_handling_note: 'Xử lý ngoài hệ thống',
        }),
      ).toThrow();

      // Missing goods_handling_note
      expect(() =>
        cancelQuoteRequestByAdminSchema.parse({
          expected_request_version: 6,
          cancel_reason: 'Sự cố bất khả kháng',
        }),
      ).toThrow();

      // Blank / null goods_handling_note
      expect(() =>
        cancelQuoteRequestByAdminSchema.parse({
          expected_request_version: 6,
          cancel_reason: 'Sự cố bất khả kháng',
          goods_handling_note: '   ',
        }),
      ).toThrow();

      expect(() =>
        cancelQuoteRequestByAdminSchema.parse({
          expected_request_version: 6,
          cancel_reason: 'Sự cố bất khả kháng',
          goods_handling_note: null,
        }),
      ).toThrow();

      // Oversized fields
      expect(() =>
        cancelQuoteRequestByAdminSchema.parse({
          expected_request_version: 6,
          cancel_reason: 'x'.repeat(MAX_CANCEL_REASON_LENGTH + 1),
          goods_handling_note: 'ok',
        }),
      ).toThrow();

      expect(() =>
        cancelQuoteRequestByAdminSchema.parse({
          expected_request_version: 6,
          cancel_reason: 'ok',
          goods_handling_note: 'y'.repeat(MAX_CANCEL_REASON_LENGTH + 1),
        }),
      ).toThrow();

      // Unknown extra field (mass assignment protection)
      expect(() =>
        cancelQuoteRequestByAdminSchema.parse({
          expected_request_version: 6,
          cancel_reason: 'Sự cố',
          goods_handling_note: 'Xử lý ngoài hệ thống',
          status: 'delivered',
        }),
      ).toThrow();

      // Invalid version
      expect(() =>
        cancelQuoteRequestByAdminSchema.parse({
          expected_request_version: 0,
          cancel_reason: 'Sự cố',
          goods_handling_note: 'Xử lý ngoài hệ thống',
        }),
      ).toThrow();
    });

    it('registers @TradingMutation metadata, design:paramtypes, and TradingModule exports', () => {
      const proto = AdminQuoteRequestController.prototype;
      const mutationMeta = Reflect.getMetadata(
        TRADING_MUTATION_METADATA_KEY,
        proto.cancelQuoteRequestByAdmin,
      );
      expect(mutationMeta).toEqual({
        action: 'cancel_request_by_admin',
        objectType: 'QuoteRequest',
        objectIdParam: 'id',
        expectedVersionField: 'expected_request_version',
      });

      const paramTypes = Reflect.getMetadata(
        'design:paramtypes',
        proto,
        'cancelQuoteRequestByAdmin',
      );
      expect(paramTypes).toHaveLength(4);
      expect(paramTypes[2]).toBe(CancelQuoteRequestByAdminDto);

      const moduleExports = Reflect.getMetadata(
        'exports',
        TradingModule,
      ) as unknown[];
      expect(moduleExports).toContain(CancelQuoteRequestByAdminUseCase);
    });
  });

  // =========================================================================
  // Suite C: HTTP Controller + Guards + TradingMutationInterceptor + Swagger
  // =========================================================================
  describe('Suite C: HTTP POST /api/v1/admin/quote-requests/:id/cancel-by-admin', () => {
    const identityMock = new MockIdentityContract();
    const txRunner = new MockTransactionRunner();

    let requestStore: Map<string, QuoteRequest>;
    let savedStatusLogs: StatusLogRecord[];
    let idempotencyStore: Map<string, PersistedIdempotencyRecord<unknown>>;
    let nextIdempotencyId: bigint;

    const mockQuoteRequestRepo = {
      findById: vi.fn(async (id: string) => requestStore.get(id) ?? null),
      lockById: vi.fn(async (id: string) => requestStore.get(id) ?? null),
      update: vi.fn(
        async (input: {
          request: QuoteRequest;
          expectedVersion?: number;
          statusLogs?: readonly StatusLogRecord[];
        }) => {
          const existing = requestStore.get(input.request.id);
          if (!existing || existing.version !== input.expectedVersion) {
            throw new ConcurrencyConflictError(
              'QuoteRequest version conflict.',
            );
          }
          requestStore.set(input.request.id, input.request);
          if (input.statusLogs) {
            savedStatusLogs.push(...input.statusLogs);
          }
          return input.request;
        },
      ),
      findDetailById: vi.fn(async (id: string) => {
        const req = requestStore.get(id);
        if (!req) return null;
        return {
          entity: req,
          category: { id: '1', name: 'Ấm, chén và cốc' },
          recipients: [],
          quotes: [],
          allocations: [],
          statusLogs: savedStatusLogs.map((l, idx) => ({
            entity: {
              id: String(7000 + idx),
              ...l,
            },
            performedBy: l.performed_by
              ? {
                  id: l.performed_by,
                  display_name: 'Ban quản lý làng gốm Bát Tràng',
                }
              : null,
          })),
        };
      }),
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
      controllers: [AdminQuoteRequestController],
      providers: [
        { provide: TRANSACTION_RUNNER, useValue: txRunner },
        { provide: QUOTE_REQUEST_REPOSITORY, useValue: mockQuoteRequestRepo },
        { provide: ALLOCATION_REPOSITORY, useValue: {} },
        { provide: QUOTE_REPOSITORY, useValue: {} },
        { provide: REQUEST_RECIPIENT_REPOSITORY, useValue: {} },
        {
          provide: IDEMPOTENCY_RECORD_REPOSITORY,
          useValue: mockIdempotencyRepo,
        },
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
          useFactory: (qrRepo: IQuoteRequestRepository) =>
            new TradingCurrentStateResolver(
              qrRepo,
              {} as any,
              {} as any,
              {} as any,
            ),
          inject: [QUOTE_REQUEST_REPOSITORY],
        },
        TradingMutationInterceptor,
        {
          provide: ListAdminQuoteRequestsUseCase,
          useFactory: (
            tr: TransactionRunner,
            qrRepo: IQuoteRequestRepository,
          ) => new ListAdminQuoteRequestsUseCase(tr, qrRepo),
          inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
        },
        {
          provide: CancelQuoteRequestByAdminUseCase,
          useFactory: (
            tr: TransactionRunner,
            qrRepo: IQuoteRequestRepository,
          ) => new CancelQuoteRequestByAdminUseCase(tr, qrRepo),
          inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
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
      requestStore = new Map([['10001', createSampleRequest()]]);
      savedStatusLogs = [];
      idempotencyStore = new Map();
      nextIdempotencyId = 40001n;

      identityMock.resolveSession.mockImplementation(async (token: string) => {
        if (token === 'session-admin-1') return adminActor;
        if (token === 'session-temp-admin') return tempPasswordAdminActor;
        if (token === 'session-buyer-101') return buyerActor;
        if (token === 'session-artisan-301') return artisanActor;
        return null;
      });
    });

    it('documents POST /api/v1/admin/quote-requests/{id}/cancel-by-admin in OpenAPI Swagger doc', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const endpoint =
        doc.paths?.['/api/v1/admin/quote-requests/{id}/cancel-by-admin'];
      expect(endpoint?.post).toBeDefined();
      expect(endpoint?.post?.tags).toContain('trading');
      expect(endpoint?.post).toHaveProperty('x-roles', ['admin']);
      expect(endpoint?.post?.parameters).toContainEqual(
        expect.objectContaining({
          name: 'X-Idempotency-Key',
          in: 'header',
          required: true,
        }),
      );
      expect(endpoint?.post?.responses?.['200']).toBeDefined();
    });

    it('returns 200 OK with AdminRequestDto (cancelled_at set, status preserved) + operation, persists audit StatusLog, and replays idempotently', async () => {
      const idempotencyKey = randomUUID();
      const requestBody = JSON.stringify({
        expected_request_version: 6,
        cancel_reason: 'Sự cố bất khả kháng thiên tai ngập xưởng sản xuất',
        goods_handling_note:
          '1.000 sản phẩm đã bàn giao được đối soát thanh toán ngoài hệ thống theo giá báo chào',
      });

      const res = await fetch(
        `${base}/admin/quote-requests/10001/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': idempotencyKey,
          },
          body: requestBody,
        },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(buyerRequestDtoResponseSchema.parse(json.data)).toEqual(json.data);
      expect(json.data.status).toBe('in_production');
      expect(json.data.version).toBe(7);
      expect(typeof json.data.cancelled_at).toBe('string');
      expect(json.data.cancel_reason).toBe(
        'Sự cố bất khả kháng thiên tai ngập xưởng sản xuất',
      );
      expect(json.data.is_bidding_open).toBe(false);
      expect(
        cancelQuoteRequestByAdminOperationResponseSchema.parse(json.operation),
      ).toEqual(json.operation);
      expect(json.operation.replayed).toBe(false);
      expect(json.operation.current_state).toEqual({
        request: {
          id: '10001',
          status: 'in_production',
          version: 7,
          cancelled_at: json.data.cancelled_at,
        },
      });
      expect(savedStatusLogs).toHaveLength(1);
      expect(savedStatusLogs[0]).toMatchObject({
        request_id: '10001',
        event_type: 'cancelled',
        prev_status: 'in_production',
        new_status: 'in_production',
        performed_by: '1',
        is_admin_action: true,
        note: 'Sự cố bất khả kháng thiên tai ngập xưởng sản xuất',
        evidence:
          '1.000 sản phẩm đã bàn giao được đối soát thanh toán ngoài hệ thống theo giá báo chào',
      });

      // Idempotency replay with same key + payload succeeds even though request is now cancelled & version is 7
      const replayRes = await fetch(
        `${base}/admin/quote-requests/10001/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': idempotencyKey,
          },
          body: requestBody,
        },
      );
      expect(replayRes.status).toBe(200);
      const replayJson = await replayRes.json();
      expect(replayJson.success).toBe(true);
      expect(replayJson.data).toEqual(json.data);
      expect(replayJson.operation.id).toBe(json.operation.id);
      expect(replayJson.operation.replayed).toBe(true);
      expect(replayJson.operation.current_state).toEqual({
        request: {
          id: '10001',
          status: 'in_production',
          version: 7,
          cancelled_at: json.data.cancelled_at,
        },
      });
      expect(mockQuoteRequestRepo.update).toHaveBeenCalledTimes(1);
      expect(savedStatusLogs).toHaveLength(1);

      // Same X-Idempotency-Key with different payload -> 409 IDEMPOTENCY_CONFLICT
      const conflictRes = await fetch(
        `${base}/admin/quote-requests/10001/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            expected_request_version: 6,
            cancel_reason: 'Lý do khác hoàn toàn',
            goods_handling_note: 'Phương án khác',
          }),
        },
      );
      expect(conflictRes.status).toBe(409);
      const conflictJson = await conflictRes.json();
      expect(conflictJson.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('rejects unauthenticated (401), wrong role (403), and temp_password session (403)', async () => {
      const key = randomUUID();
      const body = JSON.stringify({
        expected_request_version: 6,
        cancel_reason: 'Sự cố bất khả kháng',
        goods_handling_note: 'Xử lý hàng ngoài hệ thống',
      });

      const unauth = await fetch(
        `${base}/admin/quote-requests/10001/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': key,
          },
          body,
        },
      );
      expect(unauth.status).toBe(401);
      expect(((await unauth.json()) as any).code).toBe(
        'AUTHENTICATION_REQUIRED',
      );

      const buyerRes = await fetch(
        `${base}/admin/quote-requests/10001/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
            'X-Idempotency-Key': key,
          },
          body,
        },
      );
      expect(buyerRes.status).toBe(403);
      expect(((await buyerRes.json()) as any).code).toBe('PERMISSION_DENIED');

      const artisanRes = await fetch(
        `${base}/admin/quote-requests/10001/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-artisan-301',
            'X-Idempotency-Key': key,
          },
          body,
        },
      );
      expect(artisanRes.status).toBe(403);
      expect(((await artisanRes.json()) as any).code).toBe('PERMISSION_DENIED');

      const tempRes = await fetch(
        `${base}/admin/quote-requests/10001/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-temp-admin',
            'X-Idempotency-Key': key,
          },
          body,
        },
      );
      expect(tempRes.status).toBe(403);
      expect(((await tempRes.json()) as any).code).toBe(
        'TEMP_PASSWORD_RESTRICTED',
      );
    });

    it('returns 404 RESOURCE_NOT_FOUND for missing request without committing idempotency record', async () => {
      const res = await fetch(
        `${base}/admin/quote-requests/99999/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_request_version: 6,
            cancel_reason: 'Sự cố bất khả kháng',
            goods_handling_note: 'Xử lý ngoài hệ thống',
          }),
        },
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).code).toBe('RESOURCE_NOT_FOUND');
      expect(idempotencyStore.size).toBe(0);
    });

    it('rejects missing X-Idempotency-Key, missing/blank cancel_reason or goods_handling_note, extra fields, and invalid :id with 400 INVALID_INPUT', async () => {
      const validPayload = {
        expected_request_version: 6,
        cancel_reason: 'Sự cố thiên tai',
        goods_handling_note: 'Xử lý ngoài hệ thống',
      };

      const missingKeyRes = await fetch(
        `${base}/admin/quote-requests/10001/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
          },
          body: JSON.stringify(validPayload),
        },
      );
      expect(missingKeyRes.status).toBe(400);
      expect(((await missingKeyRes.json()) as any).code).toBe('INVALID_INPUT');

      const missingReasonRes = await fetch(
        `${base}/admin/quote-requests/10001/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_request_version: 6,
            goods_handling_note: 'Xử lý ngoài hệ thống',
          }),
        },
      );
      expect(missingReasonRes.status).toBe(400);
      expect(((await missingReasonRes.json()) as any).code).toBe('INVALID_INPUT');

      const missingNoteRes = await fetch(
        `${base}/admin/quote-requests/10001/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_request_version: 6,
            cancel_reason: 'Sự cố thiên tai',
          }),
        },
      );
      expect(missingNoteRes.status).toBe(400);
      expect(((await missingNoteRes.json()) as any).code).toBe('INVALID_INPUT');

      const blankNoteRes = await fetch(
        `${base}/admin/quote-requests/10001/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_request_version: 6,
            cancel_reason: 'Sự cố thiên tai',
            goods_handling_note: '    ',
          }),
        },
      );
      expect(blankNoteRes.status).toBe(400);
      expect(((await blankNoteRes.json()) as any).code).toBe('INVALID_INPUT');

      const extraFieldRes = await fetch(
        `${base}/admin/quote-requests/10001/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            ...validPayload,
            unexpected_field: true,
          }),
        },
      );
      expect(extraFieldRes.status).toBe(400);
      expect(((await extraFieldRes.json()) as any).code).toBe('INVALID_INPUT');

      const invalidIdRes = await fetch(
        `${base}/admin/quote-requests/not-a-number/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify(validPayload),
        },
      );
      expect(invalidIdRes.status).toBe(400);
      expect(((await invalidIdRes.json()) as any).code).toBe('INVALID_INPUT');
    });

    it('returns 409 CONCURRENCY_CONFLICT for stale version and 422 INVALID_STATE for draft, sent, bidding, delivered, or already cancelled', async () => {
      const staleRes = await fetch(
        `${base}/admin/quote-requests/10001/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_request_version: 5,
            cancel_reason: 'Sự cố bất khả kháng',
            goods_handling_note: 'Xử lý ngoài hệ thống',
          }),
        },
      );
      expect(staleRes.status).toBe(409);
      expect(((await staleRes.json()) as any).code).toBe(
        'CONCURRENCY_CONFLICT',
      );

      for (const forbiddenStatus of [
        'draft_request',
        'sent_to_artisans',
        'artisans_bidding',
        'delivered',
      ] as const) {
        requestStore.set(
          '10001',
          createSampleRequest({ status: forbiddenStatus, version: 6 }),
        );
        const stateRes = await fetch(
          `${base}/admin/quote-requests/10001/cancel-by-admin`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: 'vcraft-session=session-admin-1',
              'X-Idempotency-Key': randomUUID(),
            },
            body: JSON.stringify({
              expected_request_version: 6,
              cancel_reason: 'Sự cố bất khả kháng',
              goods_handling_note: 'Xử lý ngoài hệ thống',
            }),
          },
        );
        expect(stateRes.status).toBe(422);
        expect(((await stateRes.json()) as any).code).toBe('INVALID_STATE');
      }

      // Already cancelled with a brand-new idempotency key -> 422 INVALID_STATE
      requestStore.set(
        '10001',
        createSampleRequest({
          status: 'in_production',
          version: 7,
          cancelled_at: new Date('2026-11-20T08:00:00.000Z'),
          cancelled_by: '1',
          cancel_reason: 'Đã hủy trước đó',
        }),
      );
      const alreadyCancelledRes = await fetch(
        `${base}/admin/quote-requests/10001/cancel-by-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_request_version: 7,
            cancel_reason: 'Hủy lần 2',
            goods_handling_note: 'Ghi chú xử lý',
          }),
        },
      );
      expect(alreadyCancelledRes.status).toBe(422);
      expect(((await alreadyCancelledRes.json()) as any).code).toBe(
        'INVALID_STATE',
      );
    });
  });
});
