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
  type IAllocationRepository,
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
import { ConfirmDeliveryUseCase } from '../../../../src/modules/trading/application/use-cases/fulfillment/confirm-delivery.use-case';
import { CreateDraftQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/create-draft-quote-request.use-case';
import { BuyerQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/buyer-quote-request.controller';
import { buyerRequestDtoResponseSchema } from '../../../../src/modules/trading/adapters/http/dtos/create-draft-quote-request.dto';
import {
  ConfirmDeliveryDto,
  confirmDeliveryOperationResponseSchema,
  confirmDeliverySchema,
} from '../../../../src/modules/trading/adapters/http/dtos/confirm-delivery.dto';
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
const owningBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '101',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-buyer-101',
  sessionLevel: 'normal',
});

const otherBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '102',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-buyer-102',
  sessionLevel: 'normal',
});

const tempPasswordBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '101',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-temp-buyer',
  sessionLevel: 'temp_password',
});

const artisanActor: AuthenticatedActor = Object.freeze({
  accountId: '201',
  role: 'artisan',
  workshopId: '301',
  authVersion: 1,
  sessionId: 'sess-artisan-301',
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
// Fixtures
// ---------------------------------------------------------------------------
function createSampleRequest(
  overrides: Partial<{
    id: string;
    buyer_id: string;
    status: RequestStatus;
    version: number;
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
    bidding_deadline: new Date('2026-11-15T17:00:00.000Z'),
    delivery_deadline: new Date('2026-12-15T17:00:00.000Z'),
    bidding_closed_at: new Date('2026-11-12T10:00:00.000Z'),
    version: overrides.version ?? 5,
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
    quote_id: string;
    quantity: number;
    status: AllocationStatus;
    version: number;
    admin_handed_over: boolean;
  }> = {},
): Allocation {
  const baseNow = new Date('2026-11-10T08:00:00.000Z');
  const status = overrides.status ?? 'handed_over';
  const isStarted = status === 'in_production' || status === 'handed_over';
  const isHandedOver = status === 'handed_over';
  const isAdminHandover = overrides.admin_handed_over ?? false;

  return Allocation.reconstitute({
    id: overrides.id ?? '12001',
    request_id: overrides.request_id ?? '10001',
    workshop_id: overrides.workshop_id ?? '301',
    quote_id: overrides.quote_id ?? '401',
    quantity: overrides.quantity ?? 5000,
    unit_price: 35000,
    committed_delivery_at: new Date('2026-12-10T17:00:00.000Z'),
    status,
    version: overrides.version ?? (isHandedOver ? 3 : isStarted ? 2 : 1),
    started_at: isStarted ? new Date('2026-11-13T09:00:00.000Z') : null,
    started_by: isStarted ? '201' : null,
    handed_over_at: isHandedOver ? new Date('2026-11-18T15:00:00.000Z') : null,
    handed_over_by: isHandedOver ? (isAdminHandover ? '1' : '201') : null,
    delivery_note: isHandedOver && !isAdminHandover ? 'Đã giao đủ 5.000 cốc' : null,
    admin_handed_over: isHandedOver && isAdminHandover,
    admin_handover_reason:
      isHandedOver && isAdminHandover ? 'Hộ mất mạng khi giao hàng' : null,
    admin_delivery_evidence:
      isHandedOver && isAdminHandover ? 'Biên bản ký nhận số BB-01' : null,
    admin_handover_actual_at:
      isHandedOver && isAdminHandover ? new Date('2026-11-18T14:00:00.000Z') : null,
    created_at: baseNow,
    updated_at: baseNow,
    batch_links: [],
  });
}

describe('Task 34: ConfirmDelivery (UC-25, BR-25, BR-26, BR-27)', () => {
  // =========================================================================
  // Suite A: ConfirmDeliveryUseCase & Domain Invariants
  // =========================================================================
  describe('Suite A: ConfirmDeliveryUseCase', () => {
    let txRunner: MockTransactionRunner;
    let requestStore: Map<string, QuoteRequest>;
    let allocationStore: Map<string, Allocation>;
    let savedStatusLogs: StatusLogRecord[];

    let mockQuoteRequestRepo: {
      lockById: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      findDetailById: ReturnType<typeof vi.fn>;
    };
    let mockAllocationRepo: {
      lockByRequestId: ReturnType<typeof vi.fn>;
    };
    let useCase: ConfirmDeliveryUseCase;

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
              throw new ConcurrencyConflictError('QuoteRequest version conflict.');
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
                  display_name: 'Công ty Gốm Sứ An Nam',
                }
              : null,
          }));
          return {
            entity: req,
            category: { id: '1', name: 'Ấm, chén và cốc' },
            recipients: [],
            quotes: [],
            allocations: [],
            statusLogs: persistedLogs,
          };
        }),
      };

      mockAllocationRepo = {
        lockByRequestId: vi.fn(async (requestId: string) =>
          Array.from(allocationStore.values())
            .filter((a) => a.request_id === requestId)
            .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id))),
        ),
      };

      useCase = new ConfirmDeliveryUseCase(
        txRunner,
        mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
        mockAllocationRepo as unknown as IAllocationRepository,
      );
    });

    it('transitions QuoteRequest in_production -> delivered when all allocations are handed_over and logs received_by_buyer', async () => {
      const fixedNow = new Date('2026-11-21T08:15:00.000Z');
      const result = await useCase.execute({
        actor: owningBuyerActor,
        requestId: '10001',
        expectedRequestVersion: 5,
        now: fixedNow,
      });

      expect(result.request.id).toBe('10001');
      expect(result.request.status).toBe('delivered');
      expect(result.request.version).toBe(6);
      expect(result.request.category).toEqual({
        id: '1',
        name: 'Ấm, chén và cốc',
      });
      expect(result.request.delivery_confirmation).toEqual({
        performed_by: {
          id: '101',
          display_name: 'Công ty Gốm Sứ An Nam',
        },
        performed_at: fixedNow.toISOString(),
        is_admin_action: false,
        reason: null,
        evidence: null,
      });
      expect(result.currentState).toEqual({
        request: {
          id: '10001',
          status: 'delivered',
          version: 6,
          cancelled_at: null,
        },
      });

      // Verify lock order: QuoteRequest.lockById BEFORE Allocation.lockByRequestId
      const qrLockOrder =
        mockQuoteRequestRepo.lockById.mock.invocationCallOrder[0];
      const allocLockOrder =
        mockAllocationRepo.lockByRequestId.mock.invocationCallOrder[0];
      expect(qrLockOrder).toBeLessThan(allocLockOrder);

      // Verify StatusLog persisted atomically
      expect(savedStatusLogs).toHaveLength(1);
      expect(savedStatusLogs[0]).toEqual({
        request_id: '10001',
        event_type: 'received_by_buyer',
        prev_status: 'in_production',
        new_status: 'delivered',
        performed_by: '101',
        is_admin_action: false,
        note: null,
        evidence: null,
        created_at: fixedNow,
      });
    });

    it('succeeds when multiple allocations exist (including admin-handed-over) and all are handed_over', async () => {
      allocationStore.set(
        '12002',
        createSampleAllocation({
          id: '12002',
          workshop_id: '302',
          quote_id: '402',
          quantity: 2000,
          status: 'handed_over',
          admin_handed_over: true,
        }),
      );

      const result = await useCase.execute({
        actor: owningBuyerActor,
        requestId: '10001',
        expectedRequestVersion: 5,
      });

      expect(result.request.status).toBe('delivered');
      expect(result.request.version).toBe(6);
      expect(savedStatusLogs).toHaveLength(1);
    });

    it('falls back cleanly when findDetailById is not provided on repository mock', async () => {
      const minimalRepo = {
        lockById: mockQuoteRequestRepo.lockById,
        update: mockQuoteRequestRepo.update,
      } as unknown as IQuoteRequestRepository;
      const minimalUseCase = new ConfirmDeliveryUseCase(
        txRunner,
        minimalRepo,
        mockAllocationRepo as unknown as IAllocationRepository,
      );

      const fixedNow = new Date('2026-11-21T09:00:00.000Z');
      const result = await minimalUseCase.execute({
        actor: owningBuyerActor,
        requestId: '10001',
        expectedRequestVersion: 5,
        now: fixedNow,
      });

      expect(result.request.status).toBe('delivered');
      expect(result.request.delivery_confirmation).toEqual({
        performed_by: { id: '101', display_name: null },
        performed_at: fixedNow.toISOString(),
        is_admin_action: false,
        reason: null,
        evidence: null,
      });
    });

    it('rejects when an allocation is still in_production or not_started (422 INVALID_STATE)', async () => {
      allocationStore.set(
        '12002',
        createSampleAllocation({
          id: '12002',
          workshop_id: '302',
          quote_id: '402',
          status: 'in_production',
        }),
      );

      await expect(
        useCase.execute({
          actor: owningBuyerActor,
          requestId: '10001',
          expectedRequestVersion: 5,
        }),
      ).rejects.toBeInstanceOf(InvalidStateTransitionError);

      expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();
      expect(savedStatusLogs).toHaveLength(0);
      expect(requestStore.get('10001')!.status).toBe('in_production');
    });

    it('rejects when there are zero allocations (422 INVALID_STATE)', async () => {
      allocationStore.clear();

      await expect(
        useCase.execute({
          actor: owningBuyerActor,
          requestId: '10001',
          expectedRequestVersion: 5,
        }),
      ).rejects.toBeInstanceOf(InvalidStateTransitionError);

      expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();
    });

    it('rejects when QuoteRequest is cancelled even if allocations are handed_over (422 INVALID_STATE)', async () => {
      requestStore.set(
        '10001',
        createSampleRequest({
          status: 'in_production',
          cancelled_at: new Date('2026-11-19T12:00:00.000Z'),
          cancelled_by: '1',
          cancel_reason: 'Sự cố bất khả kháng',
        }),
      );

      await expect(
        useCase.execute({
          actor: owningBuyerActor,
          requestId: '10001',
          expectedRequestVersion: 5,
        }),
      ).rejects.toBeInstanceOf(InvalidStateTransitionError);

      expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();
    });

    it.each<RequestStatus>([
      'draft_request',
      'sent_to_artisans',
      'artisans_bidding',
      'buyer_accepted',
      'delivered',
    ])(
      'rejects QuoteRequest in "%s" status (422 INVALID_STATE)',
      async (status) => {
        requestStore.set('10001', createSampleRequest({ status }));

        await expect(
          useCase.execute({
            actor: owningBuyerActor,
            requestId: '10001',
            expectedRequestVersion: 5,
          }),
        ).rejects.toBeInstanceOf(InvalidStateTransitionError);

        expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();
      },
    );

    it('enforces anti-IDOR 404 RESOURCE_NOT_FOUND for non-owner Buyer without locking Allocations', async () => {
      await expect(
        useCase.execute({
          actor: otherBuyerActor,
          requestId: '10001',
          expectedRequestVersion: 5,
        }),
      ).rejects.toBeInstanceOf(QuoteRequestNotFoundError);

      expect(mockAllocationRepo.lockByRequestId).not.toHaveBeenCalled();
      expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();
    });

    it('throws 404 RESOURCE_NOT_FOUND when QuoteRequest does not exist', async () => {
      await expect(
        useCase.execute({
          actor: owningBuyerActor,
          requestId: '99999',
          expectedRequestVersion: 5,
        }),
      ).rejects.toBeInstanceOf(QuoteRequestNotFoundError);

      expect(mockAllocationRepo.lockByRequestId).not.toHaveBeenCalled();
    });

    it('rejects non-buyer roles and temp_password sessions', async () => {
      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRequestVersion: 5,
        }),
      ).rejects.toBeInstanceOf(TradingPermissionDeniedError);

      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '10001',
          expectedRequestVersion: 5,
        }),
      ).rejects.toBeInstanceOf(TradingPermissionDeniedError);

      await expect(
        useCase.execute({
          actor: tempPasswordBuyerActor,
          requestId: '10001',
          expectedRequestVersion: 5,
        }),
      ).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });
      await expect(
        useCase.execute({
          actor: tempPasswordBuyerActor,
          requestId: '10001',
          expectedRequestVersion: 5,
        }),
      ).rejects.toBeInstanceOf(TradingDomainError);
    });

    it('rejects stale expected_request_version with 409 CONCURRENCY_CONFLICT', async () => {
      await expect(
        useCase.execute({
          actor: owningBuyerActor,
          requestId: '10001',
          expectedRequestVersion: 4,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyConflictError);

      expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();
    });

    it('rejects invalid requestId or missing/invalid expected_request_version', async () => {
      await expect(
        useCase.execute({
          actor: owningBuyerActor,
          requestId: 'abc',
          expectedRequestVersion: 5,
        }),
      ).rejects.toBeInstanceOf(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: owningBuyerActor,
          requestId: '10001',
        }),
      ).rejects.toBeInstanceOf(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: owningBuyerActor,
          requestId: '10001',
          expectedRequestVersion: 0,
        }),
      ).rejects.toBeInstanceOf(InvalidTradingInputError);
    });
  });

  // =========================================================================
  // Suite B: DTO Schema, Controller Metadata & TradingModule Wiring
  // =========================================================================
  describe('Suite B: DTO, Controller Metadata & TradingModule DI', () => {
    it('validates ConfirmDeliveryDto strictly (rejects unknown fields and invalid versions)', () => {
      expect(confirmDeliverySchema.parse({ expected_request_version: 5 })).toEqual({
        expected_request_version: 5,
      });

      expect(() =>
        confirmDeliverySchema.parse({
          expected_request_version: 5,
          extra_field: 'forbidden',
        }),
      ).toThrow();

      expect(() =>
        confirmDeliverySchema.parse({ expected_request_version: 0 }),
      ).toThrow();

      expect(() =>
        confirmDeliverySchema.parse({ expected_request_version: 1.5 }),
      ).toThrow();
    });

    it('registers @TradingMutation metadata, design:paramtypes, and TradingModule exports', () => {
      const proto = BuyerQuoteRequestController.prototype;
      const mutationMeta = Reflect.getMetadata(
        TRADING_MUTATION_METADATA_KEY,
        proto.confirmDelivery,
      );
      expect(mutationMeta).toEqual({
        action: 'confirm_delivery',
        objectType: 'QuoteRequest',
        objectIdParam: 'id',
        expectedVersionField: 'expected_request_version',
      });

      const paramTypes = Reflect.getMetadata(
        'design:paramtypes',
        proto,
        'confirmDelivery',
      );
      expect(paramTypes).toHaveLength(4);
      expect(paramTypes[2]).toBe(ConfirmDeliveryDto);

      const moduleExports = Reflect.getMetadata('exports', TradingModule) as unknown[];
      expect(moduleExports).toContain(ConfirmDeliveryUseCase);
    });
  });

  // =========================================================================
  // Suite C: HTTP Controller + Guards + TradingMutationInterceptor + Swagger
  // =========================================================================
  describe('Suite C: HTTP POST /api/v1/buyer/quote-requests/:id/confirm-delivery', () => {
    const identityMock = new MockIdentityContract();
    const txRunner = new MockTransactionRunner();

    let requestStore: Map<string, QuoteRequest>;
    let allocationStore: Map<string, Allocation>;
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
            throw new ConcurrencyConflictError('QuoteRequest version conflict.');
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
                  display_name: 'Công ty Gốm Sứ An Nam',
                }
              : null,
          })),
        };
      }),
    };

    const mockAllocationRepo = {
      lockByRequestId: vi.fn(async (requestId: string) =>
        Array.from(allocationStore.values())
          .filter((a) => a.request_id === requestId)
          .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id))),
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
      controllers: [BuyerQuoteRequestController],
      providers: [
        { provide: TRANSACTION_RUNNER, useValue: txRunner },
        { provide: QUOTE_REQUEST_REPOSITORY, useValue: mockQuoteRequestRepo },
        { provide: ALLOCATION_REPOSITORY, useValue: mockAllocationRepo },
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
          provide: CreateDraftQuoteRequestUseCase,
          useFactory: (
            tr: TransactionRunner,
            qrRepo: IQuoteRequestRepository,
          ) => new CreateDraftQuoteRequestUseCase(tr, qrRepo),
          inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
        },
        {
          provide: ConfirmDeliveryUseCase,
          useFactory: (
            tr: TransactionRunner,
            qrRepo: IQuoteRequestRepository,
            allocRepo: IAllocationRepository,
          ) => new ConfirmDeliveryUseCase(tr, qrRepo, allocRepo),
          inject: [
            TRANSACTION_RUNNER,
            QUOTE_REQUEST_REPOSITORY,
            ALLOCATION_REPOSITORY,
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
      requestStore = new Map([['10001', createSampleRequest()]]);
      allocationStore = new Map([['12001', createSampleAllocation()]]);
      savedStatusLogs = [];
      idempotencyStore = new Map();
      nextIdempotencyId = 20001n;

      identityMock.resolveSession.mockImplementation(async (token: string) => {
        if (token === 'session-buyer-101') return owningBuyerActor;
        if (token === 'session-buyer-102') return otherBuyerActor;
        if (token === 'session-temp-buyer') return tempPasswordBuyerActor;
        if (token === 'session-artisan-301') return artisanActor;
        if (token === 'session-admin-1') return adminActor;
        return null;
      });
    });

    it('documents POST /api/v1/buyer/quote-requests/{id}/confirm-delivery in OpenAPI Swagger doc', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const endpoint =
        doc.paths?.['/api/v1/buyer/quote-requests/{id}/confirm-delivery'];
      expect(endpoint?.post).toBeDefined();
      expect(endpoint?.post?.tags).toContain('trading');
      expect(endpoint?.post).toHaveProperty('x-roles', ['buyer']);
      expect(endpoint?.post?.parameters).toContainEqual(
        expect.objectContaining({
          name: 'X-Idempotency-Key',
          in: 'header',
          required: true,
        }),
      );
      expect(endpoint?.post?.responses?.['200']).toBeDefined();
    });

    it('returns 200 OK with BuyerRequestDto (delivered) + operation metadata and replays idempotently', async () => {
      const idempotencyKey = randomUUID();
      const requestBody = JSON.stringify({ expected_request_version: 5 });

      const res = await fetch(
        `${base}/buyer/quote-requests/10001/confirm-delivery`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
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
      expect(json.data.status).toBe('delivered');
      expect(json.data.version).toBe(6);
      expect(json.data.delivery_confirmation).toMatchObject({
        performed_by: { id: '101', display_name: 'Công ty Gốm Sứ An Nam' },
        is_admin_action: false,
        reason: null,
        evidence: null,
      });
      expect(
        confirmDeliveryOperationResponseSchema.parse(json.operation),
      ).toEqual(json.operation);
      expect(json.operation.replayed).toBe(false);
      expect(json.operation.current_state).toEqual({
        request: {
          id: '10001',
          status: 'delivered',
          version: 6,
          cancelled_at: null,
        },
      });
      expect(savedStatusLogs).toHaveLength(1);
      expect(savedStatusLogs[0].event_type).toBe('received_by_buyer');

      // Replay with identical X-Idempotency-Key and payload (now version is 6 in DB, still replays)
      const replayRes = await fetch(
        `${base}/buyer/quote-requests/10001/confirm-delivery`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
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
          status: 'delivered',
          version: 6,
          cancelled_at: null,
        },
      });
      expect(mockQuoteRequestRepo.update).toHaveBeenCalledTimes(1);
      expect(savedStatusLogs).toHaveLength(1);

      // Same X-Idempotency-Key with different payload -> 409 IDEMPOTENCY_CONFLICT
      const conflictRes = await fetch(
        `${base}/buyer/quote-requests/10001/confirm-delivery`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
            'X-Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({ expected_request_version: 6 }),
        },
      );
      expect(conflictRes.status).toBe(409);
      const conflictJson = await conflictRes.json();
      expect(conflictJson.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('rejects unauthenticated (401), wrong role (403), and temp_password session (403)', async () => {
      const key = randomUUID();
      const body = JSON.stringify({ expected_request_version: 5 });

      const unauth = await fetch(
        `${base}/buyer/quote-requests/10001/confirm-delivery`,
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
      expect(((await unauth.json()) as any).code).toBe('AUTHENTICATION_REQUIRED');

      const artisanRes = await fetch(
        `${base}/buyer/quote-requests/10001/confirm-delivery`,
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

      const adminRes = await fetch(
        `${base}/buyer/quote-requests/10001/confirm-delivery`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-admin-1',
            'X-Idempotency-Key': key,
          },
          body,
        },
      );
      expect(adminRes.status).toBe(403);
      expect(((await adminRes.json()) as any).code).toBe('PERMISSION_DENIED');

      const tempRes = await fetch(
        `${base}/buyer/quote-requests/10001/confirm-delivery`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-temp-buyer',
            'X-Idempotency-Key': key,
          },
          body,
        },
      );
      expect(tempRes.status).toBe(403);
      expect(((await tempRes.json()) as any).code).toBe('TEMP_PASSWORD_RESTRICTED');
    });

    it('returns identical 404 RESOURCE_NOT_FOUND for non-owner Buyer and missing request (SEC-06 / AT-01)', async () => {
      const key = randomUUID();
      const body = JSON.stringify({ expected_request_version: 5 });

      const nonOwnerRes = await fetch(
        `${base}/buyer/quote-requests/10001/confirm-delivery`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-102',
            'X-Idempotency-Key': key,
          },
          body,
        },
      );
      expect(nonOwnerRes.status).toBe(404);
      const nonOwnerProblem = (await nonOwnerRes.json()) as any;

      const missingRes = await fetch(
        `${base}/buyer/quote-requests/99999/confirm-delivery`,
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
      expect(missingRes.status).toBe(404);
      const missingProblem = (await missingRes.json()) as any;

      expect({
        type: nonOwnerProblem.type,
        title: nonOwnerProblem.title,
        status: nonOwnerProblem.status,
        detail: nonOwnerProblem.detail,
        code: nonOwnerProblem.code,
      }).toEqual({
        type: missingProblem.type,
        title: missingProblem.title,
        status: missingProblem.status,
        detail: missingProblem.detail,
        code: missingProblem.code,
      });
      expect(nonOwnerProblem.code).toBe('RESOURCE_NOT_FOUND');
      expect(idempotencyStore.size).toBe(0);
    });

    it('rejects missing/invalid X-Idempotency-Key, extra DTO properties, and invalid version with 400 INVALID_INPUT', async () => {
      const missingKeyRes = await fetch(
        `${base}/buyer/quote-requests/10001/confirm-delivery`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
          },
          body: JSON.stringify({ expected_request_version: 5 }),
        },
      );
      expect(missingKeyRes.status).toBe(400);
      expect(((await missingKeyRes.json()) as any).code).toBe('INVALID_INPUT');

      const extraFieldRes = await fetch(
        `${base}/buyer/quote-requests/10001/confirm-delivery`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_request_version: 5,
            reason: 'not allowed for buyer',
          }),
        },
      );
      expect(extraFieldRes.status).toBe(400);
      expect(((await extraFieldRes.json()) as any).code).toBe('INVALID_INPUT');

      const invalidIdRes = await fetch(
        `${base}/buyer/quote-requests/not-a-number/confirm-delivery`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({ expected_request_version: 5 }),
        },
      );
      expect(invalidIdRes.status).toBe(400);
      expect(((await invalidIdRes.json()) as any).code).toBe('INVALID_INPUT');
    });

    it('returns 409 CONCURRENCY_CONFLICT for stale version and 422 INVALID_STATE when allocation not handed_over or request cancelled', async () => {
      const staleRes = await fetch(
        `${base}/buyer/quote-requests/10001/confirm-delivery`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({ expected_request_version: 4 }),
        },
      );
      expect(staleRes.status).toBe(409);
      expect(((await staleRes.json()) as any).code).toBe('CONCURRENCY_CONFLICT');

      allocationStore.set(
        '12002',
        createSampleAllocation({
          id: '12002',
          workshop_id: '302',
          quote_id: '402',
          status: 'in_production',
        }),
      );
      const notHandedOverRes = await fetch(
        `${base}/buyer/quote-requests/10001/confirm-delivery`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({ expected_request_version: 5 }),
        },
      );
      expect(notHandedOverRes.status).toBe(422);
      expect(((await notHandedOverRes.json()) as any).code).toBe('INVALID_STATE');

      // Cancelled request -> 422 INVALID_STATE
      allocationStore.delete('12002');
      requestStore.set(
        '10001',
        createSampleRequest({
          status: 'in_production',
          cancelled_at: new Date('2026-11-19T12:00:00.000Z'),
          cancelled_by: '1',
          cancel_reason: 'Hủy do thiên tai',
        }),
      );
      const cancelledRes = await fetch(
        `${base}/buyer/quote-requests/10001/confirm-delivery`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({ expected_request_version: 5 }),
        },
      );
      expect(cancelledRes.status).toBe(422);
      expect(((await cancelledRes.json()) as any).code).toBe('INVALID_STATE');
    });
  });
});
