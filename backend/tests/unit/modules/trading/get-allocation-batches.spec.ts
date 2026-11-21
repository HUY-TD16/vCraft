import 'reflect-metadata';
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
import { AppLogger } from '../../../../src/common/observability/app-logger';
import { AppConfigModule } from '../../../../src/common/config/app-config';
import { SecurityModule } from '../../../../src/common/security/security.module';
import {
  ACCESS_POLICY,
  SESSION_LEVELS,
} from '../../../../src/common/security/decorators/access-policy';
import { createApiDocument } from '../../../../src/common/http/swagger/configure-swagger';
import { IDENTITY_CONTRACT } from '../../../../src/modules/identity/public/contracts/identity.contract';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import {
  TRANSACTION_RUNNER,
  type TransactionContext,
  type TransactionRunner,
} from '../../../../src/common/application/ports/transaction-runner';
import {
  ALLOCATION_BATCH_REPOSITORY,
  ALLOCATION_LOG_REPOSITORY,
  ALLOCATION_REPOSITORY,
  type AllocationDetailRecord,
  type IAllocationBatchRepository,
  type IAllocationLogRepository,
  type IAllocationRepository,
  type IQuoteRequestRepository,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { GetAllocationByIdUseCase } from '../../../../src/modules/trading/application/use-cases/fulfillment/get-allocation-by-id.use-case';
import { GetAllocationHistoryUseCase } from '../../../../src/modules/trading/application/use-cases/fulfillment/get-allocation-history.use-case';
import { GetAllocationBatchesUseCase } from '../../../../src/modules/trading/application/use-cases/fulfillment/get-allocation-batches.use-case';
import { AllocationController } from '../../../../src/modules/trading/adapters/http/controllers/allocation.controller';
import {
  allocationBatchDtoResponseSchema,
  GetAllocationBatchesQueryDto,
} from '../../../../src/modules/trading/adapters/http/dtos/get-allocation-batches.dto';
import { TradingModule } from '../../../../src/modules/trading/trading.module';
import { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import { PrismaAllocationBatchRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/allocation-batch.repository';
import { AllocationBatchMapper } from '../../../../src/modules/trading/adapters/persistence/mappers/allocation-batch.mapper';
import {
  Allocation,
  AllocationNotFoundError,
  InvalidTradingInputError,
  QuoteRequest,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import type {
  AllocationBatchDto,
  AllocationDto,
} from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';

// ---------------------------------------------------------------------------
// Test Actors
// ---------------------------------------------------------------------------
const ownerBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-owner',
  sessionLevel: 'normal',
});

const otherBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '11',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-other',
  sessionLevel: 'normal',
});

const adminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-admin-1',
  sessionLevel: 'normal',
});

const owningArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '21',
  role: 'artisan',
  workshopId: '201',
  authVersion: 1,
  sessionId: 'session-artisan-201',
  sessionLevel: 'normal',
});

const otherArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '22',
  role: 'artisan',
  workshopId: '202',
  authVersion: 1,
  sessionId: 'session-artisan-202',
  sessionLevel: 'normal',
});

const artisanWithoutWorkshopActor: AuthenticatedActor = Object.freeze({
  accountId: '30',
  role: 'artisan',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-artisan-no-ws',
  sessionLevel: 'normal',
});

const tempPasswordArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '21',
  role: 'artisan',
  workshopId: '201',
  authVersion: 1,
  sessionId: 'session-temp-artisan',
  sessionLevel: 'temp_password',
});

// ---------------------------------------------------------------------------
// Helpers & Fixtures
// ---------------------------------------------------------------------------
function createSampleAllocationDto(
  overrides: Partial<AllocationDto> = {},
): AllocationDto {
  return Object.freeze({
    id: overrides.id ?? '12001',
    request_id: overrides.request_id ?? '100',
    workshop: Object.freeze(
      overrides.workshop ?? {
        id: '201',
        name: 'Xưởng Gốm Bát Tràng Hưng Thịnh',
      },
    ),
    quote_id: overrides.quote_id ?? '401',
    quantity: overrides.quantity ?? 5000,
    unit_price: overrides.unit_price ?? 35000,
    committed_delivery_at:
      overrides.committed_delivery_at ?? '2026-12-01T10:00:00.000Z',
    status: overrides.status ?? 'in_production',
    version: overrides.version ?? 3,
    started_at: overrides.started_at ?? '2026-11-10T07:00:00.000Z',
    started_by: overrides.started_by ?? {
      id: '21',
      display_name: 'Nghệ nhân Hưng Thịnh',
    },
    handed_over_at: overrides.handed_over_at ?? null,
    handed_over_by: overrides.handed_over_by ?? null,
    delivery_note: overrides.delivery_note ?? null,
    admin_handed_over: overrides.admin_handed_over ?? false,
    admin_handover_reason: overrides.admin_handover_reason ?? null,
    admin_delivery_evidence: overrides.admin_delivery_evidence ?? null,
    admin_handover_actual_at: overrides.admin_handover_actual_at ?? null,
    traceability_warning:
      overrides.traceability_warning !== undefined
        ? overrides.traceability_warning
        : 'INCOMPLETE_TRACEABILITY',
  });
}

function createSampleAllocationDetailRecord(
  overrides: Partial<{
    allocation: Partial<AllocationDto>;
    requestBuyerId: string;
    recipientName: string | null;
    recipientPhone: string | null;
    deliveryAddress: string | null;
  }> = {},
): AllocationDetailRecord {
  return {
    allocation: createSampleAllocationDto(overrides.allocation),
    requestBuyerId: overrides.requestBuyerId ?? '10',
    recipientName:
      overrides.recipientName !== undefined
        ? overrides.recipientName
        : 'Nguyễn Văn An',
    recipientPhone:
      overrides.recipientPhone !== undefined
        ? overrides.recipientPhone
        : '0912345678',
    deliveryAddress:
      overrides.deliveryAddress !== undefined
        ? overrides.deliveryAddress
        : 'Số 45 Phố Hàng Đào, Hoàn Kiếm, Hà Nội',
  };
}

function createSampleAllocationBatches(): readonly AllocationBatchDto[] {
  return Object.freeze([
    Object.freeze({
      batch_id: '901',
      batch_name: 'Lô cốc mẫu',
      linked_quantity: 3000,
      is_trace_public: true,
      trace_url: '/api/v1/trace/demo-bat-trang-901',
      linked_at: '2026-11-10T08:00:00.000Z',
    }),
    Object.freeze({
      batch_id: '902',
      batch_name: 'Lô cốc men trắng đợt 2 (đang nung nháp)',
      linked_quantity: 2000,
      is_trace_public: false,
      trace_url: null,
      linked_at: '2026-11-11T09:30:00.000Z',
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
describe('Task 30 (UC-23, BR-24): GET /api/v1/allocations/:id/batches', () => {
  const identityMock = new MockIdentityContract();
  const txRunner = new MockTransactionRunner();
  const mockAllocationRepo = {
    findDetailById: vi.fn(),
    findById: vi.fn(),
  };
  const mockAllocationLogRepo = {
    findEventsWithPagination: vi.fn(),
  };
  const mockAllocationBatchRepo = {
    findBatchesWithPagination: vi.fn(),
  };

  let useCase: GetAllocationBatchesUseCase;
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
    controllers: [AllocationController],
    providers: [
      { provide: TRANSACTION_RUNNER, useValue: txRunner },
      { provide: ALLOCATION_REPOSITORY, useValue: mockAllocationRepo },
      { provide: ALLOCATION_LOG_REPOSITORY, useValue: mockAllocationLogRepo },
      {
        provide: ALLOCATION_BATCH_REPOSITORY,
        useValue: mockAllocationBatchRepo,
      },
      {
        provide: GetAllocationByIdUseCase,
        useFactory: (tr: TransactionRunner, allocRepo: IAllocationRepository) =>
          new GetAllocationByIdUseCase(tr, allocRepo),
        inject: [TRANSACTION_RUNNER, ALLOCATION_REPOSITORY],
      },
      {
        provide: GetAllocationHistoryUseCase,
        useFactory: (
          tr: TransactionRunner,
          allocRepo: IAllocationRepository,
          allocLogRepo: IAllocationLogRepository,
        ) => new GetAllocationHistoryUseCase(tr, allocRepo, allocLogRepo),
        inject: [
          TRANSACTION_RUNNER,
          ALLOCATION_REPOSITORY,
          ALLOCATION_LOG_REPOSITORY,
        ],
      },
      {
        provide: GetAllocationBatchesUseCase,
        useFactory: (
          tr: TransactionRunner,
          allocRepo: IAllocationRepository,
          allocBatchRepo: IAllocationBatchRepository,
        ) => new GetAllocationBatchesUseCase(tr, allocRepo, allocBatchRepo),
        inject: [
          TRANSACTION_RUNNER,
          ALLOCATION_REPOSITORY,
          ALLOCATION_BATCH_REPOSITORY,
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

    useCase = new GetAllocationBatchesUseCase(
      txRunner,
      mockAllocationRepo as unknown as IAllocationRepository,
      mockAllocationBatchRepo as unknown as IAllocationBatchRepository,
    );

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

    identityMock.resolveSession.mockImplementation(async (token: string) => {
      if (token === 'session-buyer-owner') return ownerBuyerActor;
      if (token === 'session-buyer-other') return otherBuyerActor;
      if (token === 'session-admin-1') return adminActor;
      if (token === 'session-artisan-201') return owningArtisanActor;
      if (token === 'session-artisan-202') return otherArtisanActor;
      if (token === 'session-artisan-no-ws') return artisanWithoutWorkshopActor;
      if (token === 'session-temp-artisan') return tempPasswordArtisanActor;
      return null;
    });
  });

  // =========================================================================
  // Suite A: UseCase Unit Tests (GetAllocationBatchesUseCase)
  // =========================================================================
  describe('Suite A: GetAllocationBatchesUseCase Unit Tests', () => {
    it('returns paginated AllocationBatchDto list for owning Buyer with trace_url exposed only for published batches (UC-23, BR-09, BR-24)', async () => {
      const record = createSampleAllocationDetailRecord();
      const batches = createSampleAllocationBatches();
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);
      mockAllocationBatchRepo.findBatchesWithPagination.mockResolvedValueOnce({
        rows: batches,
        totalRecords: batches.length,
      });

      const result = await useCase.execute({
        actor: ownerBuyerActor,
        id: '12001',
      });

      expect(mockAllocationRepo.findDetailById).toHaveBeenCalledWith(
        '12001',
        expect.anything(),
      );
      expect(
        mockAllocationBatchRepo.findBatchesWithPagination,
      ).toHaveBeenCalledWith(
        { allocationId: '12001', page: 1, limit: 20 },
        expect.anything(),
      );
      expect(result.data).toEqual(batches);
      expect(result.data[0].is_trace_public).toBe(true);
      expect(result.data[0].trace_url).toBe(
        '/api/v1/trace/demo-bat-trang-901',
      );
      expect(result.data[1].is_trace_public).toBe(false);
      expect(result.data[1].trace_url).toBeNull();
      expect(result.metadata.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 2,
        total_pages: 1,
      });
    });

    it('returns paginated AllocationBatchDto list for owning Artisan across in_production and handed_over states (BR-04, BR-05, BR-24)', async () => {
      const record = createSampleAllocationDetailRecord({
        allocation: { status: 'handed_over', version: 4 },
      });
      const batches = createSampleAllocationBatches();
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);
      mockAllocationBatchRepo.findBatchesWithPagination.mockResolvedValueOnce({
        rows: batches,
        totalRecords: batches.length,
      });

      const result = await useCase.execute({
        actor: owningArtisanActor,
        id: '12001',
      });

      expect(result.data).toHaveLength(2);
      expect(result.data[0].batch_id).toBe('901');
      expect(result.data[0].linked_quantity).toBe(3000);
      expect(result.data[1].batch_id).toBe('902');
      expect(result.data[1].linked_quantity).toBe(2000);
    });

    it('allows Admin to view linked batches for any workshop and request', async () => {
      const record = createSampleAllocationDetailRecord({
        requestBuyerId: '999',
        allocation: {
          workshop: { id: '299', name: 'Xưởng Gốm 299' },
        },
      });
      const batches = [createSampleAllocationBatches()[0]];
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);
      mockAllocationBatchRepo.findBatchesWithPagination.mockResolvedValueOnce({
        rows: batches,
        totalRecords: 1,
      });

      const result = await useCase.execute({
        actor: adminActor,
        id: '12001',
      });

      expect(result.data).toEqual(batches);
      expect(result.metadata.pagination?.total_records).toBe(1);
    });

    it('supports fallback verification via allocationRepo.findById + quoteRequestRepo.findById when findDetailById is not used', async () => {
      const sampleAllocation = Allocation.reconstitute({
        id: '12001',
        request_id: '100',
        workshop_id: '201',
        quote_id: '401',
        quantity: 5000,
        unit_price: 35000,
        committed_delivery_at: new Date('2026-12-01T10:00:00.000Z'),
        status: 'in_production',
        version: 3,
        started_at: new Date('2026-11-10T07:00:00.000Z'),
        started_by: '21',
        handed_over_at: null,
        handed_over_by: null,
        delivery_note: null,
        admin_handed_over: false,
        admin_delivery_evidence: null,
        admin_handover_reason: null,
        admin_handover_actual_at: null,
        created_at: new Date('2026-11-09T10:00:00.000Z'),
        updated_at: new Date('2026-11-10T08:00:00.000Z'),
      });
      const sampleRequest = QuoteRequest.reconstitute({
        id: '100',
        buyer_id: '10',
        category_id: '1',
        spec: '5.000 cốc gốm men trắng',
        quantity: 5000,
        unit: 'piece',
        unit_set_description: null,
        status: 'in_production',
        delivery_mode: 'at_workshop',
        delivery_region: null,
        delivery_address: null,
        recipient_name: 'Nguyễn Văn An',
        recipient_phone: '0912345678',
        bidding_deadline: new Date('2026-11-08T10:00:00.000Z'),
        delivery_deadline: new Date('2026-12-05T10:00:00.000Z'),
        bidding_closed_at: new Date('2026-11-08T10:00:00.000Z'),
        version: 4,
        cancelled_at: null,
        cancelled_by: null,
        cancel_reason: null,
        created_at: new Date('2026-11-05T10:00:00.000Z'),
        updated_at: new Date('2026-11-10T08:00:00.000Z'),
      });

      const findByIdOnlyAllocationRepo = {
        findById: vi.fn().mockResolvedValueOnce(sampleAllocation),
      } as unknown as IAllocationRepository;
      const mockQuoteRequestRepo = {
        findById: vi.fn().mockResolvedValueOnce(sampleRequest),
      } as unknown as IQuoteRequestRepository;

      const fallbackUseCase = new GetAllocationBatchesUseCase(
        txRunner,
        findByIdOnlyAllocationRepo,
        mockAllocationBatchRepo as unknown as IAllocationBatchRepository,
        mockQuoteRequestRepo,
      );

      const batches = createSampleAllocationBatches();
      mockAllocationBatchRepo.findBatchesWithPagination.mockResolvedValueOnce({
        rows: batches,
        totalRecords: batches.length,
      });

      const result = await fallbackUseCase.execute({
        actor: ownerBuyerActor,
        allocationId: '12001',
      });

      expect(result.data).toHaveLength(2);
      expect(mockQuoteRequestRepo.findById).toHaveBeenCalledWith(
        '100',
        expect.anything(),
      );
    });

    it('throws AllocationNotFoundError (404 anti-IDOR) when non-owner Artisan requests another workshop allocation batches', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        createSampleAllocationDetailRecord({
          allocation: { workshop: { id: '201', name: 'Xưởng Gốm 201' } },
        }),
      );

      await expect(
        useCase.execute({
          actor: otherArtisanActor,
          id: '12001',
        }),
      ).rejects.toThrow(AllocationNotFoundError);

      expect(
        mockAllocationBatchRepo.findBatchesWithPagination,
      ).not.toHaveBeenCalled();
    });

    it('throws AllocationNotFoundError (404 anti-IDOR) when non-owner Buyer requests another Buyer allocation batches', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        createSampleAllocationDetailRecord({ requestBuyerId: '10' }),
      );

      await expect(
        useCase.execute({
          actor: otherBuyerActor,
          id: '12001',
        }),
      ).rejects.toThrow(AllocationNotFoundError);

      expect(
        mockAllocationBatchRepo.findBatchesWithPagination,
      ).not.toHaveBeenCalled();
    });

    it('throws AllocationNotFoundError when allocation does not exist', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(null);

      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          id: '99999',
        }),
      ).rejects.toThrow(AllocationNotFoundError);

      expect(
        mockAllocationBatchRepo.findBatchesWithPagination,
      ).not.toHaveBeenCalled();
    });

    it('throws PERMISSION_DENIED when artisan actor has no workshopId without querying repositories', async () => {
      await expect(
        useCase.execute({
          actor: artisanWithoutWorkshopActor,
          id: '12001',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(mockAllocationRepo.findDetailById).not.toHaveBeenCalled();
      expect(
        mockAllocationBatchRepo.findBatchesWithPagination,
      ).not.toHaveBeenCalled();
    });

    it('throws TEMP_PASSWORD_RESTRICTED for temp_password session without querying repositories (SEC-05)', async () => {
      await expect(
        useCase.execute({
          actor: tempPasswordArtisanActor,
          id: '12001',
        }),
      ).rejects.toThrow(TradingDomainError);

      try {
        await useCase.execute({
          actor: tempPasswordArtisanActor,
          id: '12001',
        });
      } catch (err: unknown) {
        expect((err as TradingDomainError).code).toBe(
          'TEMP_PASSWORD_RESTRICTED',
        );
      }

      expect(mockAllocationRepo.findDetailById).not.toHaveBeenCalled();
      expect(
        mockAllocationBatchRepo.findBatchesWithPagination,
      ).not.toHaveBeenCalled();
    });

    it('throws PERMISSION_DENIED for unknown role without querying repositories', async () => {
      const unknownActor = {
        ...ownerBuyerActor,
        role: 'guest',
      } as unknown as AuthenticatedActor;

      await expect(
        useCase.execute({
          actor: unknownActor,
          id: '12001',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(mockAllocationRepo.findDetailById).not.toHaveBeenCalled();
    });

    it.each(['0', '-1', 'abc', '9223372036854775808', '12.5', ''])(
      'throws InvalidTradingInputError (INVALID_INPUT) for malformed :id %j without querying repositories',
      async (invalidId) => {
        await expect(
          useCase.execute({
            actor: owningArtisanActor,
            id: invalidId,
          }),
        ).rejects.toThrow(InvalidTradingInputError);

        expect(mockAllocationRepo.findDetailById).not.toHaveBeenCalled();
      },
    );

    it.each([
      { page: 0, limit: 20 },
      { page: -2, limit: 20 },
      { page: 1, limit: 0 },
      { page: 1, limit: 101 },
    ])(
      'throws InvalidTradingInputError for out-of-bounds pagination %j without querying repositories',
      async (badQuery) => {
        await expect(
          useCase.execute({
            actor: owningArtisanActor,
            id: '12001',
            query: badQuery,
          }),
        ).rejects.toThrow(InvalidTradingInputError);

        expect(mockAllocationRepo.findDetailById).not.toHaveBeenCalled();
      },
    );

    it('reuses caller-supplied TransactionContext without opening a nested transaction', async () => {
      const runSpy = vi.spyOn(txRunner, 'run');
      const externalTx = { txId: 'ext-tx-30' } as unknown as TransactionContext;
      const record = createSampleAllocationDetailRecord();
      const batches = createSampleAllocationBatches();
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);
      mockAllocationBatchRepo.findBatchesWithPagination.mockResolvedValueOnce({
        rows: batches,
        totalRecords: batches.length,
      });

      const result = await useCase.execute({
        actor: owningArtisanActor,
        id: '12001',
        tx: externalTx,
      });

      expect(result.data).toHaveLength(2);
      expect(mockAllocationRepo.findDetailById).toHaveBeenCalledWith(
        '12001',
        externalTx,
      );
      expect(
        mockAllocationBatchRepo.findBatchesWithPagination,
      ).toHaveBeenCalledWith(
        { allocationId: '12001', page: 1, limit: 20 },
        externalTx,
      );
      expect(runSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Suite B: Controller Metadata, Zod Schema & Swagger OpenAPI Document
  // =========================================================================
  describe('Suite B: Controller Metadata, Zod Schema & Swagger OpenAPI Document', () => {
    it('serves OpenAPI documentation including GET /api/v1/allocations/{id}/batches with paginated AllocationBatchDto', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const endpoint = doc.paths?.['/api/v1/allocations/{id}/batches'];
      expect(endpoint).toBeDefined();
      expect(endpoint?.get).toBeDefined();
      expect(endpoint?.get?.tags).toContain('trading');
      expect(endpoint?.get?.summary).toContain('lô sản xuất');

      const idParam = endpoint?.get?.parameters?.find(
        (p) => 'name' in p && p.name === 'id' && p.in === 'path',
      );
      expect(idParam).toBeDefined();

      const pageParam = endpoint?.get?.parameters?.find(
        (p) => 'name' in p && p.name === 'page' && p.in === 'query',
      );
      const limitParam = endpoint?.get?.parameters?.find(
        (p) => 'name' in p && p.name === 'limit' && p.in === 'query',
      );
      expect(pageParam).toBeDefined();
      expect(limitParam).toBeDefined();

      const okResponse = endpoint?.get?.responses?.['200'];
      expect(okResponse && 'content' in okResponse).toBe(true);
      const responseSchema =
        okResponse && 'content' in okResponse
          ? okResponse.content?.['application/json']?.schema
          : undefined;
      expect(responseSchema && 'properties' in responseSchema).toBe(true);
      if (
        responseSchema &&
        'properties' in responseSchema &&
        responseSchema.properties
      ) {
        expect(responseSchema.properties.data).toBeDefined();
        expect(responseSchema.properties.pagination).toBeDefined();
      }
    });

    it('verifies AllocationController.getAllocationBatches decorators and TradingModule exports', () => {
      expect(Reflect.getMetadata(PATH_METADATA, AllocationController)).toBe(
        'allocations',
      );

      const proto = AllocationController.prototype;
      const methodPolicy = Reflect.getMetadata(
        ACCESS_POLICY,
        proto.getAllocationBatches,
      );
      expect(methodPolicy).toEqual({
        kind: 'roles',
        roles: ['buyer', 'artisan', 'admin'],
      });

      const sessionMeta = Reflect.getMetadata(
        SESSION_LEVELS,
        proto.getAllocationBatches,
      );
      expect(sessionMeta).toEqual(['normal']);

      const headers = Reflect.getMetadata(
        '__headers__',
        proto.getAllocationBatches,
      );
      expect(headers).toEqual(
        expect.arrayContaining([{ name: 'Cache-Control', value: 'no-store' }]),
      );

      const paramTypes = Reflect.getMetadata(
        'design:paramtypes',
        proto,
        'getAllocationBatches',
      );
      expect(paramTypes).toEqual([
        Object,
        String,
        GetAllocationBatchesQueryDto,
      ]);

      const moduleExports = Reflect.getMetadata(
        'exports',
        TradingModule,
      ) as unknown[];
      expect(moduleExports).toContain(GetAllocationBatchesUseCase);
    });

    it('validates AllocationBatchDto strictly and rejects extra fields such as qr_token or draft journal entries', () => {
      for (const batchItem of createSampleAllocationBatches()) {
        expect(() =>
          allocationBatchDtoResponseSchema.parse(batchItem),
        ).not.toThrow();
      }

      // Rejects extra unallowlisted fields (`api-dtos.md` §1 & §2.3)
      expect(() =>
        allocationBatchDtoResponseSchema.parse({
          ...createSampleAllocationBatches()[0],
          qr_token: 'demo-bat-trang-901',
        }),
      ).toThrow();

      expect(() =>
        allocationBatchDtoResponseSchema.parse({
          ...createSampleAllocationBatches()[1],
          journal_entries: [],
        }),
      ).toThrow();

      // Rejects invalid trace_url prefix (`api-dtos.md` §1: *_url must start with /api/v1/)
      expect(() =>
        allocationBatchDtoResponseSchema.parse({
          ...createSampleAllocationBatches()[0],
          trace_url: 'http://evil.example.com/trace/123',
        }),
      ).toThrow();
    });
  });

  // =========================================================================
  // Suite C: HTTP Controller Pipeline & Pagination Integration Tests
  // =========================================================================
  describe('Suite C: HTTP Controller Pipeline & Pagination Integration Tests', () => {
    it('returns HTTP 200 with Cache-Control: no-store and paginated AllocationBatchDto list for owning Buyer (matching fixtures.json allocation-batches)', async () => {
      const record = createSampleAllocationDetailRecord();
      const batches = createSampleAllocationBatches();
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);
      mockAllocationBatchRepo.findBatchesWithPagination.mockResolvedValueOnce({
        rows: batches,
        totalRecords: batches.length,
      });

      const res = await fetch(
        `${base}/allocations/12001/batches?page=1&limit=20`,
        {
          headers: { Cookie: 'vcraft-session=session-buyer-owner' },
        },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
      for (const item of json.data) {
        expect(item).toEqual(allocationBatchDtoResponseSchema.parse(item));
      }
      expect(json.data[0]).toEqual({
        batch_id: '901',
        batch_name: 'Lô cốc mẫu',
        linked_quantity: 3000,
        is_trace_public: true,
        trace_url: '/api/v1/trace/demo-bat-trang-901',
        linked_at: '2026-11-10T08:00:00.000Z',
      });
      expect(json.data[1]).toEqual({
        batch_id: '902',
        batch_name: 'Lô cốc men trắng đợt 2 (đang nung nháp)',
        linked_quantity: 2000,
        is_trace_public: false,
        trace_url: null,
        linked_at: '2026-11-11T09:30:00.000Z',
      });
      expect(json.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 2,
        total_pages: 1,
      });
    });

    it('returns HTTP 200 with Cache-Control: no-store for owning Artisan', async () => {
      const record = createSampleAllocationDetailRecord();
      const batches = createSampleAllocationBatches();
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);
      mockAllocationBatchRepo.findBatchesWithPagination.mockResolvedValueOnce({
        rows: batches,
        totalRecords: batches.length,
      });

      const res = await fetch(`${base}/allocations/12001/batches`, {
        headers: { Cookie: 'vcraft-session=session-artisan-201' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.data[0].batch_id).toBe('901');
      expect(json.data[1].batch_id).toBe('902');
    });

    it('returns HTTP 200 for Admin viewing any allocation batches', async () => {
      const record = createSampleAllocationDetailRecord({
        requestBuyerId: '999',
        allocation: {
          workshop: { id: '299', name: 'Xưởng Gốm 299' },
        },
      });
      const batches = [createSampleAllocationBatches()[0]];
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);
      mockAllocationBatchRepo.findBatchesWithPagination.mockResolvedValueOnce({
        rows: batches,
        totalRecords: 1,
      });

      const res = await fetch(`${base}/allocations/12001/batches`, {
        headers: { Cookie: 'vcraft-session=session-admin-1' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].batch_id).toBe('901');
    });

    it('supports custom pagination (?page=2&limit=5) and empty results (total_pages: 0)', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        createSampleAllocationDetailRecord(),
      );
      mockAllocationBatchRepo.findBatchesWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const res = await fetch(
        `${base}/allocations/12001/batches?page=2&limit=5`,
        {
          headers: { Cookie: 'vcraft-session=session-buyer-owner' },
        },
      );

      expect(res.status).toBe(200);
      expect(
        mockAllocationBatchRepo.findBatchesWithPagination,
      ).toHaveBeenCalledWith(
        { allocationId: '12001', page: 2, limit: 5 },
        expect.anything(),
      );
      const json = await res.json();
      expect(json.data).toEqual([]);
      expect(json.pagination).toEqual({
        page: 2,
        limit: 5,
        total_records: 0,
        total_pages: 0,
      });
    });

    it.each([
      'page=0',
      'page=-1',
      'page=abc',
      'limit=0',
      'limit=101',
      'unexpected=123',
    ])(
      'returns HTTP 400 INVALID_INPUT for invalid query string "?%s"',
      async (queryStr) => {
        const res = await fetch(
          `${base}/allocations/12001/batches?${queryStr}`,
          {
            headers: { Cookie: 'vcraft-session=session-buyer-owner' },
          },
        );

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.code).toBe('INVALID_INPUT');
      },
    );

    it.each(['abc', '0', '9223372036854775808'])(
      'returns HTTP 400 INVALID_INPUT for invalid :id "%s"',
      async (badId) => {
        const res = await fetch(`${base}/allocations/${badId}/batches`, {
          headers: { Cookie: 'vcraft-session=session-artisan-201' },
        });

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.code).toBe('INVALID_INPUT');
      },
    );

    it('returns HTTP 404 RESOURCE_NOT_FOUND without leaking batches for non-owner Artisan (SEC-06)', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        createSampleAllocationDetailRecord(),
      );

      const res = await fetch(`${base}/allocations/12001/batches`, {
        headers: { Cookie: 'vcraft-session=session-artisan-202' },
      });

      expect(res.status).toBe(404);
      const rawText = await res.text();
      expect(rawText).not.toContain('demo-bat-trang-901');
      expect(rawText).not.toContain('Lô cốc mẫu');
      const json = JSON.parse(rawText);
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns HTTP 404 RESOURCE_NOT_FOUND without leaking batches for non-owner Buyer (SEC-06)', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        createSampleAllocationDetailRecord(),
      );

      const res = await fetch(`${base}/allocations/12001/batches`, {
        headers: { Cookie: 'vcraft-session=session-buyer-other' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns HTTP 404 RESOURCE_NOT_FOUND when allocation ID does not exist', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/allocations/99999/batches`, {
        headers: { Cookie: 'vcraft-session=session-artisan-201' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns HTTP 403 PERMISSION_DENIED when Artisan has no workshopId', async () => {
      const res = await fetch(`${base}/allocations/12001/batches`, {
        headers: { Cookie: 'vcraft-session=session-artisan-no-ws' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('returns HTTP 403 TEMP_PASSWORD_RESTRICTED for temp_password session', async () => {
      const res = await fetch(`${base}/allocations/12001/batches`, {
        headers: { Cookie: 'vcraft-session=session-temp-artisan' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
    });

    it('returns HTTP 401 AUTHENTICATION_REQUIRED when unauthenticated', async () => {
      const res = await fetch(`${base}/allocations/12001/batches`);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });

  // =========================================================================
  // Suite D: Persistence Unit Tests (PrismaAllocationBatchRepository.findBatchesWithPagination)
  // =========================================================================
  describe('Suite D: PrismaAllocationBatchRepository.findBatchesWithPagination Persistence Unit Tests', () => {
    it('executes count and findMany with ascending linked_at/id order, projects batch metadata, and masks draft trace_url (BR-09, UC-23)', async () => {
      const mockRows = [
        {
          id: 801n,
          workshop_id: 201n,
          allocation_id: 12001n,
          batch_id: 901n,
          linked_quantity: 3000,
          linked_at: new Date('2026-11-10T08:00:00.000Z'),
          linked_by: 21n,
          batch: {
            id: 901n,
            name: 'Lô cốc mẫu',
            status: 'published',
            qr_token: 'demo-bat-trang-901',
          },
        },
        {
          id: 802n,
          workshop_id: 201n,
          allocation_id: 12001n,
          batch_id: 902n,
          linked_quantity: 2000,
          linked_at: new Date('2026-11-11T09:30:00.000Z'),
          linked_by: 21n,
          batch: {
            id: 902n,
            name: 'Lô cốc men trắng đợt 2',
            status: 'draft',
            qr_token: 'secret-draft-token-902',
          },
        },
      ];

      const mockPrismaClient = {
        allocationBatch: {
          count: vi.fn().mockResolvedValue(2),
          findMany: vi.fn().mockResolvedValue(mockRows),
        },
      };

      const mockTxRunner = {
        getClient: vi.fn().mockReturnValue(mockPrismaClient),
        run: vi.fn().mockImplementation(async (cb: any) => cb({} as any)),
      } as unknown as PrismaTransactionRunner;

      const repo = new PrismaAllocationBatchRepository(mockTxRunner);

      const result = await repo.findBatchesWithPagination({
        allocationId: '12001',
        page: 1,
        limit: 20,
      });

      expect(mockPrismaClient.allocationBatch.count).toHaveBeenCalledWith({
        where: { allocation_id: 12001n },
      });
      expect(mockPrismaClient.allocationBatch.findMany).toHaveBeenCalledWith({
        where: { allocation_id: 12001n },
        include: {
          batch: {
            select: {
              id: true,
              name: true,
              status: true,
              qr_token: true,
            },
          },
        },
        orderBy: [{ linked_at: 'asc' }, { id: 'asc' }],
        skip: 0,
        take: 20,
      });

      expect(result.totalRecords).toBe(2);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual({
        batch_id: '901',
        batch_name: 'Lô cốc mẫu',
        linked_quantity: 3000,
        is_trace_public: true,
        trace_url: '/api/v1/trace/demo-bat-trang-901',
        linked_at: '2026-11-10T08:00:00.000Z',
      });
      expect(result.rows[1]).toEqual({
        batch_id: '902',
        batch_name: 'Lô cốc men trắng đợt 2',
        linked_quantity: 2000,
        is_trace_public: false,
        trace_url: null,
        linked_at: '2026-11-11T09:30:00.000Z',
      });
      expect('qr_token' in (result.rows[0] as object)).toBe(false);
      expect('qr_token' in (result.rows[1] as object)).toBe(false);
      expect(JSON.stringify(result.rows[1])).not.toContain(
        'secret-draft-token-902',
      );
    });

    it('executes within existing TransactionContext when tx is supplied without calling txRunner.run', async () => {
      const mockPrismaClient = {
        allocationBatch: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };

      const mockTxRunner = {
        getClient: vi.fn().mockReturnValue(mockPrismaClient),
        run: vi.fn(),
      } as unknown as PrismaTransactionRunner;

      const repo = new PrismaAllocationBatchRepository(mockTxRunner);
      const fakeTx = {} as TransactionContext;

      const result = await repo.findBatchesWithPagination(
        {
          allocationId: '12001',
          page: 3,
          limit: 10,
        },
        fakeTx,
      );

      expect(mockTxRunner.getClient).toHaveBeenCalledWith(fakeTx);
      expect(mockTxRunner.run).not.toHaveBeenCalled();
      expect(mockPrismaClient.allocationBatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 10,
        }),
      );
      expect(result.totalRecords).toBe(0);
      expect(result.rows).toEqual([]);
    });

    it('rejects unknown batch status in AllocationBatchMapper.fromPrismaWithBatchToDto', () => {
      expect(() =>
        AllocationBatchMapper.fromPrismaWithBatchToDto({
          id: 801n,
          workshop_id: 201n,
          allocation_id: 12001n,
          batch_id: 901n,
          linked_quantity: 100,
          linked_at: new Date('2026-11-10T08:00:00.000Z'),
          linked_by: 21n,
          batch: {
            id: 901n,
            name: 'Lô lỗi trạng thái',
            status: 'invalid_status',
            qr_token: 'demo-bat-trang-901',
          },
        }),
      ).toThrow(InvalidTradingInputError);
    });
  });
});
