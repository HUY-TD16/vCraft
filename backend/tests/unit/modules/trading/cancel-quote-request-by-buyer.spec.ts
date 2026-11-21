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
import { CancelQuoteRequestByBuyerUseCase } from '../../../../src/modules/trading/application/use-cases/requests/cancel-quote-request-by-buyer.use-case';
import { CreateDraftQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/create-draft-quote-request.use-case';
import { BuyerQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/buyer-quote-request.controller';
import { buyerRequestDtoResponseSchema } from '../../../../src/modules/trading/adapters/http/dtos/create-draft-quote-request.dto';
import {
  CancelQuoteRequestDto,
  cancelQuoteRequestOperationResponseSchema,
  cancelQuoteRequestSchema,
} from '../../../../src/modules/trading/adapters/http/dtos/cancel-quote-request.dto';
import { TRADING_MUTATION_METADATA_KEY } from '../../../../src/modules/trading/adapters/http/decorators/trading-mutation.decorator';
import {
  TRADING_CURRENT_STATE_RESOLVER,
  TradingCurrentStateResolver,
} from '../../../../src/modules/trading/adapters/http/interceptors/trading-current-state.resolver';
import { TradingMutationInterceptor } from '../../../../src/modules/trading/adapters/http/interceptors/trading-mutation.interceptor';
import { TradingModule } from '../../../../src/modules/trading/trading.module';
import {
  ConcurrencyConflictError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  MAX_CANCEL_REASON_LENGTH,
  QuoteRequest,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
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
    status: overrides.status ?? 'artisans_bidding',
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
        : null,
    version: overrides.version ?? 3,
    cancelled_at: overrides.cancelled_at ?? null,
    cancelled_by: overrides.cancelled_by ?? null,
    cancel_reason: overrides.cancel_reason ?? null,
    created_at: baseNow,
    updated_at: baseNow,
  });
}

describe('Task 35: CancelQuoteRequestByBuyer (UC-27, BR-21, BR-22, BR-26, BR-27)', () => {
  // =========================================================================
  // Suite A: CancelQuoteRequestByBuyerUseCase & Domain Invariants
  // =========================================================================
  describe('Suite A: CancelQuoteRequestByBuyerUseCase', () => {
    let txRunner: MockTransactionRunner;
    let requestStore: Map<string, QuoteRequest>;
    let savedStatusLogs: StatusLogRecord[];

    let mockQuoteRequestRepo: {
      lockById: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      findDetailById: ReturnType<typeof vi.fn>;
    };
    let useCase: CancelQuoteRequestByBuyerUseCase;

    beforeEach(() => {
      txRunner = new MockTransactionRunner();
      requestStore = new Map([['10001', createSampleRequest()]]);
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

      useCase = new CancelQuoteRequestByBuyerUseCase(
        txRunner,
        mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
      );
    });

    it('cancels QuoteRequest in sent_to_artisans, preserves primary status, stores trimmed cancel_reason and StatusLog', async () => {
      requestStore.set(
        '10001',
        createSampleRequest({ status: 'sent_to_artisans', version: 2 }),
      );
      const fixedNow = new Date('2026-11-12T10:30:00.000Z');

      const result = await useCase.execute({
        actor: owningBuyerActor,
        requestId: '10001',
        expectedRequestVersion: 2,
        cancelReason: '  Thay đổi kế hoạch kinh doanh cuối năm  ',
        now: fixedNow,
      });

      expect(result.request.id).toBe('10001');
      expect(result.request.status).toBe('sent_to_artisans');
      expect(result.request.version).toBe(3);
      expect(result.request.cancelled_at).toBe(fixedNow.toISOString());
      expect(result.request.cancel_reason).toBe(
        'Thay đổi kế hoạch kinh doanh cuối năm',
      );
      expect(result.request.bidding_closed_at).toBe(fixedNow.toISOString());
      expect(result.request.is_bidding_open).toBe(false);
      expect(result.request.no_valid_quotes).toBe(false);
      expect(result.request.nearest_accept_deadline).toBeNull();
      expect(result.request.delivery_confirmation).toBeNull();
      expect(result.request.category).toEqual({
        id: '1',
        name: 'Ấm, chén và cốc',
      });
      expect(result.currentState).toEqual({
        request: {
          id: '10001',
          status: 'sent_to_artisans',
          version: 3,
          cancelled_at: fixedNow.toISOString(),
        },
      });

      const persisted = requestStore.get('10001')!;
      expect(persisted.cancelled_by).toBe('101');
      expect(persisted.isCancelled()).toBe(true);

      expect(savedStatusLogs).toHaveLength(1);
      expect(savedStatusLogs[0]).toEqual({
        request_id: '10001',
        event_type: 'cancelled',
        prev_status: 'sent_to_artisans',
        new_status: 'sent_to_artisans',
        performed_by: '101',
        is_admin_action: false,
        note: 'Thay đổi kế hoạch kinh doanh cuối năm',
        evidence: null,
        created_at: fixedNow,
      });
    });

    it('cancels QuoteRequest in artisans_bidding when cancel_reason is omitted, null, or whitespace-only', async () => {
      const fixedNow = new Date('2026-11-13T09:00:00.000Z');

      const result = await useCase.execute({
        actor: owningBuyerActor,
        requestId: '10001',
        expectedRequestVersion: 3,
        cancelReason: '   ',
        now: fixedNow,
      });

      expect(result.request.status).toBe('artisans_bidding');
      expect(result.request.version).toBe(4);
      expect(result.request.cancelled_at).toBe(fixedNow.toISOString());
      expect(result.request.cancel_reason).toBeNull();
      expect(savedStatusLogs).toHaveLength(1);
      expect(savedStatusLogs[0]).toEqual({
        request_id: '10001',
        event_type: 'cancelled',
        prev_status: 'artisans_bidding',
        new_status: 'artisans_bidding',
        performed_by: '101',
        is_admin_action: false,
        note: null,
        evidence: null,
        created_at: fixedNow,
      });
    });

    it('uses bidding_deadline as bidding_closed_at when cancelling after deadline (BR-12), and preserves existing early close', async () => {
      const deadline = new Date('2026-11-15T17:00:00.000Z');
      const afterDeadline = new Date('2026-11-16T08:00:00.000Z');
      requestStore.set(
        '10001',
        createSampleRequest({
          status: 'artisans_bidding',
          version: 3,
          bidding_deadline: deadline,
          bidding_closed_at: null,
        }),
      );

      const resAfterDeadline = await useCase.execute({
        actor: owningBuyerActor,
        requestId: '10001',
        expectedRequestVersion: 3,
        now: afterDeadline,
      });
      expect(resAfterDeadline.request.bidding_closed_at).toBe(
        deadline.toISOString(),
      );

      const earlyClosedAt = new Date('2026-11-12T12:00:00.000Z');
      requestStore.set(
        '10002',
        createSampleRequest({
          id: '10002',
          status: 'artisans_bidding',
          version: 4,
          bidding_deadline: deadline,
          bidding_closed_at: earlyClosedAt,
        }),
      );
      const resAlreadyClosed = await useCase.execute({
        actor: owningBuyerActor,
        requestId: '10002',
        expectedRequestVersion: 4,
        now: afterDeadline,
      });
      expect(resAlreadyClosed.request.bidding_closed_at).toBe(
        earlyClosedAt.toISOString(),
      );
    });

    it('falls back cleanly when findDetailById is not provided on repository mock', async () => {
      const minimalRepo = {
        lockById: mockQuoteRequestRepo.lockById,
        update: mockQuoteRequestRepo.update,
      } as unknown as IQuoteRequestRepository;
      const minimalUseCase = new CancelQuoteRequestByBuyerUseCase(
        txRunner,
        minimalRepo,
      );

      const fixedNow = new Date('2026-11-13T09:00:00.000Z');
      const result = await minimalUseCase.execute({
        actor: owningBuyerActor,
        requestId: '10001',
        expectedRequestVersion: 3,
        cancelReason: 'Không còn nhu cầu',
        now: fixedNow,
      });

      expect(result.request.status).toBe('artisans_bidding');
      expect(result.request.cancelled_at).toBe(fixedNow.toISOString());
      expect(result.request.cancel_reason).toBe('Không còn nhu cầu');
      expect(result.request.category).toEqual({ id: '1', name: '' });
    });

    it.each<RequestStatus>([
      'draft_request',
      'buyer_accepted',
      'in_production',
      'delivered',
    ])(
      'rejects Buyer cancellation when status is "%s" (422 INVALID_STATE)',
      async (status) => {
        requestStore.set('10001', createSampleRequest({ status, version: 3 }));

        await expect(
          useCase.execute({
            actor: owningBuyerActor,
            requestId: '10001',
            expectedRequestVersion: 3,
            cancelReason: 'Lý do hủy',
          }),
        ).rejects.toBeInstanceOf(InvalidStateTransitionError);

        expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();
        expect(savedStatusLogs).toHaveLength(0);
      },
    );

    it('rejects cancelling an already-cancelled QuoteRequest (422 INVALID_STATE)', async () => {
      requestStore.set(
        '10001',
        createSampleRequest({
          status: 'artisans_bidding',
          version: 4,
          cancelled_at: new Date('2026-11-13T10:00:00.000Z'),
          cancelled_by: '101',
          cancel_reason: 'Đã hủy trước đó',
        }),
      );

      await expect(
        useCase.execute({
          actor: owningBuyerActor,
          requestId: '10001',
          expectedRequestVersion: 4,
          cancelReason: 'Hủy lần 2',
        }),
      ).rejects.toBeInstanceOf(InvalidStateTransitionError);

      expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();
    });

    it('enforces anti-IDOR 404 RESOURCE_NOT_FOUND for non-owner Buyer and missing request', async () => {
      await expect(
        useCase.execute({
          actor: otherBuyerActor,
          requestId: '10001',
          expectedRequestVersion: 3,
        }),
      ).rejects.toBeInstanceOf(QuoteRequestNotFoundError);

      await expect(
        useCase.execute({
          actor: owningBuyerActor,
          requestId: '99999',
          expectedRequestVersion: 3,
        }),
      ).rejects.toBeInstanceOf(QuoteRequestNotFoundError);

      expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();
    });

    it('rejects non-buyer roles and temp_password sessions', async () => {
      await expect(
        useCase.execute({
          actor: artisanActor,
          requestId: '10001',
          expectedRequestVersion: 3,
        }),
      ).rejects.toBeInstanceOf(TradingPermissionDeniedError);

      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '10001',
          expectedRequestVersion: 3,
        }),
      ).rejects.toBeInstanceOf(TradingPermissionDeniedError);

      await expect(
        useCase.execute({
          actor: tempPasswordBuyerActor,
          requestId: '10001',
          expectedRequestVersion: 3,
        }),
      ).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });
      await expect(
        useCase.execute({
          actor: tempPasswordBuyerActor,
          requestId: '10001',
          expectedRequestVersion: 3,
        }),
      ).rejects.toBeInstanceOf(TradingDomainError);
    });

    it('rejects stale expected_request_version with 409 CONCURRENCY_CONFLICT', async () => {
      await expect(
        useCase.execute({
          actor: owningBuyerActor,
          requestId: '10001',
          expectedRequestVersion: 2,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyConflictError);

      expect(mockQuoteRequestRepo.update).not.toHaveBeenCalled();
    });

    it('rejects invalid requestId, missing/invalid expected_request_version, and oversized cancel_reason', async () => {
      await expect(
        useCase.execute({
          actor: owningBuyerActor,
          requestId: 'abc',
          expectedRequestVersion: 3,
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

      await expect(
        useCase.execute({
          actor: owningBuyerActor,
          requestId: '10001',
          expectedRequestVersion: 3,
          cancelReason: 'a'.repeat(MAX_CANCEL_REASON_LENGTH + 1),
        }),
      ).rejects.toBeInstanceOf(InvalidTradingInputError);
    });
  });

  // =========================================================================
  // Suite B: DTO Schema, Controller Metadata & TradingModule DI
  // =========================================================================
  describe('Suite B: DTO, Controller Metadata & TradingModule DI', () => {
    it('validates CancelQuoteRequestDto strictly (optional/nullable reason, max 10000, rejects unknown fields)', () => {
      expect(
        cancelQuoteRequestSchema.parse({ expected_request_version: 3 }),
      ).toEqual({ expected_request_version: 3 });

      expect(
        cancelQuoteRequestSchema.parse({
          expected_request_version: 3,
          cancel_reason: '  Đổi kế hoạch  ',
        }),
      ).toEqual({
        expected_request_version: 3,
        cancel_reason: 'Đổi kế hoạch',
      });

      expect(
        cancelQuoteRequestSchema.parse({
          expected_request_version: 3,
          cancel_reason: null,
        }),
      ).toEqual({
        expected_request_version: 3,
        cancel_reason: null,
      });

      expect(() =>
        cancelQuoteRequestSchema.parse({
          expected_request_version: 3,
          goods_handling_note: 'admin-only field',
        }),
      ).toThrow();

      expect(() =>
        cancelQuoteRequestSchema.parse({
          expected_request_version: 3,
          cancel_reason: 'x'.repeat(MAX_CANCEL_REASON_LENGTH + 1),
        }),
      ).toThrow();

      expect(() =>
        cancelQuoteRequestSchema.parse({ expected_request_version: 0 }),
      ).toThrow();

      expect(() =>
        cancelQuoteRequestSchema.parse({ expected_request_version: 1.5 }),
      ).toThrow();
    });

    it('registers @TradingMutation metadata, design:paramtypes, and TradingModule exports', () => {
      const proto = BuyerQuoteRequestController.prototype;
      const mutationMeta = Reflect.getMetadata(
        TRADING_MUTATION_METADATA_KEY,
        proto.cancelQuoteRequest,
      );
      expect(mutationMeta).toEqual({
        action: 'cancel_request',
        objectType: 'QuoteRequest',
        objectIdParam: 'id',
        expectedVersionField: 'expected_request_version',
      });

      const paramTypes = Reflect.getMetadata(
        'design:paramtypes',
        proto,
        'cancelQuoteRequest',
      );
      expect(paramTypes).toHaveLength(4);
      expect(paramTypes[2]).toBe(CancelQuoteRequestDto);

      const moduleExports = Reflect.getMetadata(
        'exports',
        TradingModule,
      ) as unknown[];
      expect(moduleExports).toContain(CancelQuoteRequestByBuyerUseCase);
    });
  });

  // =========================================================================
  // Suite C: HTTP Controller + Guards + TradingMutationInterceptor + Swagger
  // =========================================================================
  describe('Suite C: HTTP POST /api/v1/buyer/quote-requests/:id/cancel', () => {
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
                  display_name: 'Công ty Gốm Sứ An Nam',
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
      controllers: [BuyerQuoteRequestController],
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
          provide: CreateDraftQuoteRequestUseCase,
          useFactory: (
            tr: TransactionRunner,
            qrRepo: IQuoteRequestRepository,
          ) => new CreateDraftQuoteRequestUseCase(tr, qrRepo),
          inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
        },
        {
          provide: CancelQuoteRequestByBuyerUseCase,
          useFactory: (
            tr: TransactionRunner,
            qrRepo: IQuoteRequestRepository,
          ) => new CancelQuoteRequestByBuyerUseCase(tr, qrRepo),
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
      nextIdempotencyId = 30001n;

      identityMock.resolveSession.mockImplementation(async (token: string) => {
        if (token === 'session-buyer-101') return owningBuyerActor;
        if (token === 'session-buyer-102') return otherBuyerActor;
        if (token === 'session-temp-buyer') return tempPasswordBuyerActor;
        if (token === 'session-artisan-301') return artisanActor;
        if (token === 'session-admin-1') return adminActor;
        return null;
      });
    });

    it('documents POST /api/v1/buyer/quote-requests/{id}/cancel in OpenAPI Swagger doc', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const endpoint =
        doc.paths?.['/api/v1/buyer/quote-requests/{id}/cancel'];
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

    it('returns 200 OK with BuyerRequestDto (cancelled_at set, status preserved) + operation and replays idempotently', async () => {
      const idempotencyKey = randomUUID();
      const requestBody = JSON.stringify({
        expected_request_version: 3,
        cancel_reason: 'Thay đổi kế hoạch kinh doanh cuối năm',
      });

      const res = await fetch(`${base}/buyer/quote-requests/10001/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-buyer-101',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: requestBody,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(buyerRequestDtoResponseSchema.parse(json.data)).toEqual(json.data);
      expect(json.data.status).toBe('artisans_bidding');
      expect(json.data.version).toBe(4);
      expect(typeof json.data.cancelled_at).toBe('string');
      expect(json.data.cancel_reason).toBe(
        'Thay đổi kế hoạch kinh doanh cuối năm',
      );
      expect(json.data.is_bidding_open).toBe(false);
      expect(
        cancelQuoteRequestOperationResponseSchema.parse(json.operation),
      ).toEqual(json.operation);
      expect(json.operation.replayed).toBe(false);
      expect(json.operation.current_state).toEqual({
        request: {
          id: '10001',
          status: 'artisans_bidding',
          version: 4,
          cancelled_at: json.data.cancelled_at,
        },
      });
      expect(savedStatusLogs).toHaveLength(1);
      expect(savedStatusLogs[0].event_type).toBe('cancelled');
      expect(savedStatusLogs[0].prev_status).toBe('artisans_bidding');
      expect(savedStatusLogs[0].new_status).toBe('artisans_bidding');
      expect(savedStatusLogs[0].is_admin_action).toBe(false);

      // Idempotency replay with same key + payload succeeds even though request is now cancelled & version is 4
      const replayRes = await fetch(
        `${base}/buyer/quote-requests/10001/cancel`,
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
          status: 'artisans_bidding',
          version: 4,
          cancelled_at: json.data.cancelled_at,
        },
      });
      expect(mockQuoteRequestRepo.update).toHaveBeenCalledTimes(1);
      expect(savedStatusLogs).toHaveLength(1);

      // Same X-Idempotency-Key with different payload -> 409 IDEMPOTENCY_CONFLICT
      const conflictRes = await fetch(
        `${base}/buyer/quote-requests/10001/cancel`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
            'X-Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            expected_request_version: 3,
            cancel_reason: 'Lý do khác hoàn toàn',
          }),
        },
      );
      expect(conflictRes.status).toBe(409);
      const conflictJson = await conflictRes.json();
      expect(conflictJson.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('rejects unauthenticated (401), wrong role (403), and temp_password session (403)', async () => {
      const key = randomUUID();
      const body = JSON.stringify({ expected_request_version: 3 });

      const unauth = await fetch(`${base}/buyer/quote-requests/10001/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': key,
        },
        body,
      });
      expect(unauth.status).toBe(401);
      expect(((await unauth.json()) as any).code).toBe(
        'AUTHENTICATION_REQUIRED',
      );

      const artisanRes = await fetch(
        `${base}/buyer/quote-requests/10001/cancel`,
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
        `${base}/buyer/quote-requests/10001/cancel`,
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

      const tempRes = await fetch(`${base}/buyer/quote-requests/10001/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=session-temp-buyer',
          'X-Idempotency-Key': key,
        },
        body,
      });
      expect(tempRes.status).toBe(403);
      expect(((await tempRes.json()) as any).code).toBe(
        'TEMP_PASSWORD_RESTRICTED',
      );
    });

    it('returns identical 404 RESOURCE_NOT_FOUND for non-owner Buyer and missing request (SEC-06 / AT-01)', async () => {
      const key = randomUUID();
      const body = JSON.stringify({ expected_request_version: 3 });

      const nonOwnerRes = await fetch(
        `${base}/buyer/quote-requests/10001/cancel`,
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
        `${base}/buyer/quote-requests/99999/cancel`,
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

    it('rejects missing/invalid X-Idempotency-Key, extra DTO properties, invalid :id, and oversized cancel_reason with 400 INVALID_INPUT', async () => {
      const missingKeyRes = await fetch(
        `${base}/buyer/quote-requests/10001/cancel`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
          },
          body: JSON.stringify({ expected_request_version: 3 }),
        },
      );
      expect(missingKeyRes.status).toBe(400);
      expect(((await missingKeyRes.json()) as any).code).toBe('INVALID_INPUT');

      const extraFieldRes = await fetch(
        `${base}/buyer/quote-requests/10001/cancel`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_request_version: 3,
            goods_handling_note: 'forbidden on buyer cancel',
          }),
        },
      );
      expect(extraFieldRes.status).toBe(400);
      expect(((await extraFieldRes.json()) as any).code).toBe('INVALID_INPUT');

      const invalidIdRes = await fetch(
        `${base}/buyer/quote-requests/not-a-number/cancel`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({ expected_request_version: 3 }),
        },
      );
      expect(invalidIdRes.status).toBe(400);
      expect(((await invalidIdRes.json()) as any).code).toBe('INVALID_INPUT');

      const tooLongReasonRes = await fetch(
        `${base}/buyer/quote-requests/10001/cancel`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            expected_request_version: 3,
            cancel_reason: 'z'.repeat(MAX_CANCEL_REASON_LENGTH + 1),
          }),
        },
      );
      expect(tooLongReasonRes.status).toBe(400);
      expect(((await tooLongReasonRes.json()) as any).code).toBe(
        'INVALID_INPUT',
      );
    });

    it('returns 409 CONCURRENCY_CONFLICT for stale version and 422 INVALID_STATE for draft, accepted, in_production, delivered, or already cancelled', async () => {
      const staleRes = await fetch(
        `${base}/buyer/quote-requests/10001/cancel`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=session-buyer-101',
            'X-Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({ expected_request_version: 2 }),
        },
      );
      expect(staleRes.status).toBe(409);
      expect(((await staleRes.json()) as any).code).toBe(
        'CONCURRENCY_CONFLICT',
      );

      for (const forbiddenStatus of [
        'draft_request',
        'buyer_accepted',
        'in_production',
        'delivered',
      ] as const) {
        requestStore.set(
          '10001',
          createSampleRequest({ status: forbiddenStatus, version: 3 }),
        );
        const stateRes = await fetch(
          `${base}/buyer/quote-requests/10001/cancel`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: 'vcraft-session=session-buyer-101',
              'X-Idempotency-Key': randomUUID(),
            },
            body: JSON.stringify({ expected_request_version: 3 }),
          },
        );
        expect(stateRes.status).toBe(422);
        expect(((await stateRes.json()) as any).code).toBe('INVALID_STATE');
      }

      // Already cancelled with a brand-new idempotency key -> 422 INVALID_STATE
      requestStore.set(
        '10001',
        createSampleRequest({
          status: 'artisans_bidding',
          version: 4,
          cancelled_at: new Date('2026-11-14T08:00:00.000Z'),
          cancelled_by: '101',
          cancel_reason: 'Đã hủy trước đó',
        }),
      );
      const alreadyCancelledRes = await fetch(
        `${base}/buyer/quote-requests/10001/cancel`,
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
      expect(alreadyCancelledRes.status).toBe(422);
      expect(((await alreadyCancelledRes.json()) as any).code).toBe(
        'INVALID_STATE',
      );
    });
  });
});
