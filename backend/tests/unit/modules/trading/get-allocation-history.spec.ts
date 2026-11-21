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
  ALLOCATION_LOG_REPOSITORY,
  ALLOCATION_REPOSITORY,
  type AllocationDetailRecord,
  type IAllocationLogRepository,
  type IAllocationRepository,
  type IQuoteRequestRepository,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { GetAllocationByIdUseCase } from '../../../../src/modules/trading/application/use-cases/fulfillment/get-allocation-by-id.use-case';
import { GetAllocationHistoryUseCase } from '../../../../src/modules/trading/application/use-cases/fulfillment/get-allocation-history.use-case';
import { AllocationController } from '../../../../src/modules/trading/adapters/http/controllers/allocation.controller';
import {
  allocationEventDtoResponseSchema,
  GetAllocationHistoryQueryDto,
} from '../../../../src/modules/trading/adapters/http/dtos/get-allocation-history.dto';
import { TradingModule } from '../../../../src/modules/trading/trading.module';
import { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import { PrismaAllocationLogRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/allocation-log.repository';
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
  AllocationDto,
  AllocationEventDto,
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
    id: overrides.id ?? '501',
    request_id: overrides.request_id ?? '100',
    workshop: Object.freeze(
      overrides.workshop ?? {
        id: '201',
        name: 'Xưởng Gốm Bát Tràng Hưng Thịnh',
      },
    ),
    quote_id: overrides.quote_id ?? '401',
    quantity: overrides.quantity ?? 100,
    unit_price: overrides.unit_price ?? 450000,
    committed_delivery_at:
      overrides.committed_delivery_at ?? '2026-12-01T10:00:00.000Z',
    status: overrides.status ?? 'in_production',
    version: overrides.version ?? 2,
    started_at: overrides.started_at ?? '2026-11-16T08:00:00.000Z',
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
        : 'NO_BATCH_LINK',
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

function createSampleAllocationEvents(): readonly AllocationEventDto[] {
  return Object.freeze([
    Object.freeze({
      id: '16001',
      event_type: 'created',
      prev_status: null,
      new_status: 'not_started',
      performed_by: Object.freeze({
        id: '10',
        display_name: 'Nguyễn Văn An',
      }),
      created_at: '2026-11-15T10:00:00.000Z',
      is_admin_action: false,
      note: null,
      evidence: null,
    }),
    Object.freeze({
      id: '16002',
      event_type: 'production_started',
      prev_status: 'not_started',
      new_status: 'in_production',
      performed_by: Object.freeze({
        id: '21',
        display_name: 'Nghệ nhân Hưng Thịnh',
      }),
      created_at: '2026-11-16T08:00:00.000Z',
      is_admin_action: false,
      note: null,
      evidence: null,
    }),
    Object.freeze({
      id: '16003',
      event_type: 'batch_links_changed',
      prev_status: 'in_production',
      new_status: 'in_production',
      performed_by: Object.freeze({
        id: '21',
        display_name: 'Nghệ nhân Hưng Thịnh',
      }),
      created_at: '2026-11-17T09:30:00.000Z',
      is_admin_action: false,
      note: null,
      evidence: null,
    }),
    Object.freeze({
      id: '16004',
      event_type: 'handover_recorded',
      prev_status: 'in_production',
      new_status: 'handed_over',
      performed_by: Object.freeze({
        id: '21',
        display_name: 'Nghệ nhân Hưng Thịnh',
      }),
      created_at: '2026-11-20T10:00:00.000Z',
      is_admin_action: false,
      note: 'Đã bàn giao đủ 100 bộ tại xưởng',
      evidence: null,
    }),
  ]);
}

function createSampleAdminHandoverEvent(): AllocationEventDto {
  return Object.freeze({
    id: '16005',
    event_type: 'handover_by_admin',
    prev_status: 'in_production',
    new_status: 'handed_over',
    performed_by: Object.freeze({
      id: '1',
      display_name: 'Ban Quản Lý Làng Nghề',
    }),
    created_at: '2026-11-20T11:30:00.000Z',
    is_admin_action: true,
    note: 'Hộ đã bàn giao đủ nhưng mất điện không truy cập được phần mềm',
    evidence:
      'Biên bản ký nhận bàn giao hàng giấy số BB-012/2026 có chữ ký thủ kho Buyer',
  });
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
describe('Task 29 (UC-23, BR-26): GET /api/v1/allocations/:id/history', () => {
  const identityMock = new MockIdentityContract();
  const txRunner = new MockTransactionRunner();
  const mockAllocationRepo = {
    findDetailById: vi.fn(),
    findById: vi.fn(),
  };
  const mockAllocationLogRepo = {
    findEventsWithPagination: vi.fn(),
  };

  let useCase: GetAllocationHistoryUseCase;
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
    ],
  })(TestAppModule);

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/test');
    vi.stubEnv(
      'SESSION_SECRET',
      'test_secret_32_chars_for_development_purposes',
    );
    vi.stubEnv('NODE_ENV', 'development');

    useCase = new GetAllocationHistoryUseCase(
      txRunner,
      mockAllocationRepo as unknown as IAllocationRepository,
      mockAllocationLogRepo as unknown as IAllocationLogRepository,
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
  // Suite A: UseCase Unit Tests (GetAllocationHistoryUseCase)
  // =========================================================================
  describe('Suite A: GetAllocationHistoryUseCase Unit Tests', () => {
    it('returns paginated AllocationEventDto list for owning Artisan with default pagination (UC-23, BR-26)', async () => {
      const record = createSampleAllocationDetailRecord();
      const events = createSampleAllocationEvents();
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);
      mockAllocationLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const result = await useCase.execute({
        actor: owningArtisanActor,
        id: '501',
      });

      expect(mockAllocationRepo.findDetailById).toHaveBeenCalledWith(
        '501',
        expect.anything(),
      );
      expect(
        mockAllocationLogRepo.findEventsWithPagination,
      ).toHaveBeenCalledWith(
        { allocationId: '501', page: 1, limit: 20 },
        expect.anything(),
      );
      expect(result.data).toEqual(events);
      expect(result.metadata.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 4,
        total_pages: 1,
      });
    });

    it('returns full history for owning Buyer including handover_by_admin reason (note), verification evidence, and performer (BR-24, BR-26)', async () => {
      const record = createSampleAllocationDetailRecord();
      const adminEvent = createSampleAdminHandoverEvent();
      const events = [
        ...createSampleAllocationEvents().slice(0, 3),
        adminEvent,
      ];
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);
      mockAllocationLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const result = await useCase.execute({
        actor: ownerBuyerActor,
        id: '501',
      });

      expect(result.data).toHaveLength(4);
      const handoverEvent = result.data[3];
      expect(handoverEvent).toEqual({
        id: '16005',
        event_type: 'handover_by_admin',
        prev_status: 'in_production',
        new_status: 'handed_over',
        performed_by: {
          id: '1',
          display_name: 'Ban Quản Lý Làng Nghề',
        },
        created_at: '2026-11-20T11:30:00.000Z',
        is_admin_action: true,
        note: 'Hộ đã bàn giao đủ nhưng mất điện không truy cập được phần mềm',
        evidence:
          'Biên bản ký nhận bàn giao hàng giấy số BB-012/2026 có chữ ký thủ kho Buyer',
      });
    });

    it('allows Admin to view allocation history for any workshop and request', async () => {
      const record = createSampleAllocationDetailRecord({
        requestBuyerId: '999',
        allocation: {
          workshop: { id: '299', name: 'Xưởng Gốm 299' },
        },
      });
      const events = [createSampleAdminHandoverEvent()];
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);
      mockAllocationLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: 1,
      });

      const result = await useCase.execute({
        actor: adminActor,
        id: '501',
      });

      expect(result.data).toEqual(events);
      expect(result.metadata.pagination?.total_records).toBe(1);
    });

    it('supports fallback verification via allocationRepo.findById + quoteRequestRepo.findById when findDetailById is not used', async () => {
      const sampleAllocation = Allocation.reconstitute({
        id: '501',
        request_id: '100',
        workshop_id: '201',
        quote_id: '401',
        quantity: 100,
        unit_price: 450000,
        committed_delivery_at: new Date('2026-12-01T10:00:00.000Z'),
        status: 'in_production',
        version: 2,
        started_at: new Date('2026-11-16T08:00:00.000Z'),
        started_by: '21',
        handed_over_at: null,
        handed_over_by: null,
        delivery_note: null,
        admin_handed_over: false,
        admin_delivery_evidence: null,
        admin_handover_reason: null,
        admin_handover_actual_at: null,
        created_at: new Date('2026-11-15T10:00:00.000Z'),
        updated_at: new Date('2026-11-16T08:00:00.000Z'),
      });
      const sampleRequest = QuoteRequest.reconstitute({
        id: '100',
        buyer_id: '10',
        category_id: '1',
        spec: 'Bộ ấm chén Bát Tràng',
        quantity: 100,
        unit: 'set',
        unit_set_description: '1 ấm 6 chén',
        status: 'in_production',
        delivery_mode: 'at_workshop',
        delivery_region: null,
        delivery_address: null,
        recipient_name: 'Nguyễn Văn An',
        recipient_phone: '0912345678',
        bidding_deadline: new Date('2026-11-13T10:00:00.000Z'),
        delivery_deadline: new Date('2026-12-05T10:00:00.000Z'),
        bidding_closed_at: new Date('2026-11-13T10:00:00.000Z'),
        version: 4,
        cancelled_at: null,
        cancelled_by: null,
        cancel_reason: null,
        created_at: new Date('2026-11-10T10:00:00.000Z'),
        updated_at: new Date('2026-11-16T08:00:00.000Z'),
      });

      const findByIdOnlyAllocationRepo = {
        findById: vi.fn().mockResolvedValueOnce(sampleAllocation),
      } as unknown as IAllocationRepository;
      const mockQuoteRequestRepo = {
        findById: vi.fn().mockResolvedValueOnce(sampleRequest),
      } as unknown as IQuoteRequestRepository;

      const fallbackUseCase = new GetAllocationHistoryUseCase(
        txRunner,
        findByIdOnlyAllocationRepo,
        mockAllocationLogRepo as unknown as IAllocationLogRepository,
        mockQuoteRequestRepo,
      );

      const events = createSampleAllocationEvents();
      mockAllocationLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const result = await fallbackUseCase.execute({
        actor: ownerBuyerActor,
        allocationId: '501',
      });

      expect(result.data).toHaveLength(4);
      expect(mockQuoteRequestRepo.findById).toHaveBeenCalledWith(
        '100',
        expect.anything(),
      );
    });

    it('throws AllocationNotFoundError (404 anti-IDOR) when non-owner Artisan requests another workshop allocation history', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        createSampleAllocationDetailRecord({
          allocation: { workshop: { id: '201', name: 'Xưởng Gốm 201' } },
        }),
      );

      await expect(
        useCase.execute({
          actor: otherArtisanActor,
          id: '501',
        }),
      ).rejects.toThrow(AllocationNotFoundError);

      expect(
        mockAllocationLogRepo.findEventsWithPagination,
      ).not.toHaveBeenCalled();
    });

    it('throws AllocationNotFoundError (404 anti-IDOR) when non-owner Buyer requests another Buyer allocation history', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        createSampleAllocationDetailRecord({ requestBuyerId: '10' }),
      );

      await expect(
        useCase.execute({
          actor: otherBuyerActor,
          id: '501',
        }),
      ).rejects.toThrow(AllocationNotFoundError);

      expect(
        mockAllocationLogRepo.findEventsWithPagination,
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
        mockAllocationLogRepo.findEventsWithPagination,
      ).not.toHaveBeenCalled();
    });

    it('throws PERMISSION_DENIED when artisan actor has no workshopId without querying repositories', async () => {
      await expect(
        useCase.execute({
          actor: artisanWithoutWorkshopActor,
          id: '501',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(mockAllocationRepo.findDetailById).not.toHaveBeenCalled();
      expect(
        mockAllocationLogRepo.findEventsWithPagination,
      ).not.toHaveBeenCalled();
    });

    it('throws TEMP_PASSWORD_RESTRICTED for temp_password session without querying repositories (SEC-05)', async () => {
      await expect(
        useCase.execute({
          actor: tempPasswordArtisanActor,
          id: '501',
        }),
      ).rejects.toThrow(TradingDomainError);

      try {
        await useCase.execute({
          actor: tempPasswordArtisanActor,
          id: '501',
        });
      } catch (err: unknown) {
        expect((err as TradingDomainError).code).toBe(
          'TEMP_PASSWORD_RESTRICTED',
        );
      }

      expect(mockAllocationRepo.findDetailById).not.toHaveBeenCalled();
      expect(
        mockAllocationLogRepo.findEventsWithPagination,
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
          id: '501',
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
            id: '501',
            query: badQuery,
          }),
        ).rejects.toThrow(InvalidTradingInputError);

        expect(mockAllocationRepo.findDetailById).not.toHaveBeenCalled();
      },
    );

    it('reuses caller-supplied TransactionContext without opening a nested transaction', async () => {
      const runSpy = vi.spyOn(txRunner, 'run');
      const externalTx = { txId: 'ext-tx-29' } as unknown as TransactionContext;
      const record = createSampleAllocationDetailRecord();
      const events = createSampleAllocationEvents();
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);
      mockAllocationLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const result = await useCase.execute({
        actor: owningArtisanActor,
        id: '501',
        tx: externalTx,
      });

      expect(result.data).toHaveLength(4);
      expect(mockAllocationRepo.findDetailById).toHaveBeenCalledWith(
        '501',
        externalTx,
      );
      expect(
        mockAllocationLogRepo.findEventsWithPagination,
      ).toHaveBeenCalledWith(
        { allocationId: '501', page: 1, limit: 20 },
        externalTx,
      );
      expect(runSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Suite B: Controller Metadata, Zod Schema & Swagger OpenAPI Document
  // =========================================================================
  describe('Suite B: Controller Metadata, Zod Schema & Swagger OpenAPI Document', () => {
    it('serves OpenAPI documentation including GET /api/v1/allocations/{id}/history with paginated AllocationEventDto', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const endpoint = doc.paths?.['/api/v1/allocations/{id}/history'];
      expect(endpoint).toBeDefined();
      expect(endpoint?.get).toBeDefined();
      expect(endpoint?.get?.tags).toContain('trading');
      expect(endpoint?.get?.summary).toContain('lịch sử tiến độ');

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

    it('verifies AllocationController.getAllocationHistory decorators and TradingModule exports', () => {
      expect(Reflect.getMetadata(PATH_METADATA, AllocationController)).toBe(
        'allocations',
      );

      const proto = AllocationController.prototype;
      const methodPolicy = Reflect.getMetadata(
        ACCESS_POLICY,
        proto.getAllocationHistory,
      );
      expect(methodPolicy).toEqual({
        kind: 'roles',
        roles: ['buyer', 'artisan', 'admin'],
      });

      const sessionMeta = Reflect.getMetadata(
        SESSION_LEVELS,
        proto.getAllocationHistory,
      );
      expect(sessionMeta).toEqual(['normal']);

      const headers = Reflect.getMetadata(
        '__headers__',
        proto.getAllocationHistory,
      );
      expect(headers).toEqual(
        expect.arrayContaining([{ name: 'Cache-Control', value: 'no-store' }]),
      );

      const paramTypes = Reflect.getMetadata(
        'design:paramtypes',
        proto,
        'getAllocationHistory',
      );
      expect(paramTypes).toEqual([
        Object,
        String,
        GetAllocationHistoryQueryDto,
      ]);

      const moduleExports = Reflect.getMetadata(
        'exports',
        TradingModule,
      ) as unknown[];
      expect(moduleExports).toContain(GetAllocationHistoryUseCase);
    });

    it('validates AllocationEventDto strictly with Allocation statuses/event_types and rejects QuoteRequest statuses or extra fields', () => {
      for (const ev of [
        ...createSampleAllocationEvents(),
        createSampleAdminHandoverEvent(),
      ]) {
        expect(() => allocationEventDtoResponseSchema.parse(ev)).not.toThrow();
      }

      // Rejects QuoteRequest status in AllocationEventDto (`api-dtos.md` §2.3)
      expect(() =>
        allocationEventDtoResponseSchema.parse({
          ...createSampleAllocationEvents()[0],
          new_status: 'buyer_accepted',
        }),
      ).toThrow();

      // Rejects extra unallowlisted fields
      expect(() =>
        allocationEventDtoResponseSchema.parse({
          ...createSampleAllocationEvents()[0],
          allocation_id: '501',
        }),
      ).toThrow();
    });
  });

  // =========================================================================
  // Suite C: HTTP Controller Pipeline & Pagination Integration Tests
  // =========================================================================
  describe('Suite C: HTTP Controller Pipeline & Pagination Integration Tests', () => {
    it('returns HTTP 200 with Cache-Control: no-store and paginated AllocationEventDto list for owning Buyer', async () => {
      const record = createSampleAllocationDetailRecord();
      const events = createSampleAllocationEvents();
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);
      mockAllocationLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const res = await fetch(`${base}/allocations/501/history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(4);
      for (const item of json.data) {
        expect(item).toEqual(allocationEventDtoResponseSchema.parse(item));
      }
      expect(json.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 4,
        total_pages: 1,
      });
    });

    it('returns HTTP 200 with Cache-Control: no-store for owning Artisan', async () => {
      const record = createSampleAllocationDetailRecord();
      const events = createSampleAllocationEvents();
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);
      mockAllocationLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: events.length,
      });

      const res = await fetch(`${base}/allocations/501/history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-201' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(4);
      expect(json.data[1].event_type).toBe('production_started');
      expect(json.data[2].event_type).toBe('batch_links_changed');
      expect(json.data[3].event_type).toBe('handover_recorded');
    });

    it('returns HTTP 200 for Admin including handover_by_admin reason (note) and verification evidence (BR-24, BR-26)', async () => {
      const record = createSampleAllocationDetailRecord({
        requestBuyerId: '999',
        allocation: {
          workshop: { id: '299', name: 'Xưởng Gốm 299' },
        },
      });
      const adminEvent = createSampleAdminHandoverEvent();
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);
      mockAllocationLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [adminEvent],
        totalRecords: 1,
      });

      const res = await fetch(`${base}/allocations/501/history`, {
        headers: { Cookie: 'vcraft-session=session-admin-1' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0]).toEqual({
        id: '16005',
        event_type: 'handover_by_admin',
        prev_status: 'in_production',
        new_status: 'handed_over',
        performed_by: {
          id: '1',
          display_name: 'Ban Quản Lý Làng Nghề',
        },
        created_at: '2026-11-20T11:30:00.000Z',
        is_admin_action: true,
        note: 'Hộ đã bàn giao đủ nhưng mất điện không truy cập được phần mềm',
        evidence:
          'Biên bản ký nhận bàn giao hàng giấy số BB-012/2026 có chữ ký thủ kho Buyer',
      });
    });

    it('supports custom pagination (?page=2&limit=5) and empty results (total_pages: 0)', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        createSampleAllocationDetailRecord(),
      );
      mockAllocationLogRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const res = await fetch(
        `${base}/allocations/501/history?page=2&limit=5`,
        {
          headers: { Cookie: 'vcraft-session=session-buyer-owner' },
        },
      );

      expect(res.status).toBe(200);
      expect(
        mockAllocationLogRepo.findEventsWithPagination,
      ).toHaveBeenCalledWith(
        { allocationId: '501', page: 2, limit: 5 },
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
        const res = await fetch(`${base}/allocations/501/history?${queryStr}`, {
          headers: { Cookie: 'vcraft-session=session-buyer-owner' },
        });

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.code).toBe('INVALID_INPUT');
      },
    );

    it.each(['abc', '0', '9223372036854775808'])(
      'returns HTTP 400 INVALID_INPUT for invalid :id "%s"',
      async (badId) => {
        const res = await fetch(`${base}/allocations/${badId}/history`, {
          headers: { Cookie: 'vcraft-session=session-artisan-201' },
        });

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.code).toBe('INVALID_INPUT');
      },
    );

    it('returns HTTP 404 RESOURCE_NOT_FOUND without leaking history for non-owner Artisan (SEC-06)', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        createSampleAllocationDetailRecord(),
      );

      const res = await fetch(`${base}/allocations/501/history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-202' },
      });

      expect(res.status).toBe(404);
      const rawText = await res.text();
      expect(rawText).not.toContain('BB-012/2026');
      expect(rawText).not.toContain('Nghệ nhân Hưng Thịnh');
      const json = JSON.parse(rawText);
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns HTTP 404 RESOURCE_NOT_FOUND without leaking history for non-owner Buyer (SEC-06)', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        createSampleAllocationDetailRecord(),
      );

      const res = await fetch(`${base}/allocations/501/history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-other' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns HTTP 404 RESOURCE_NOT_FOUND when allocation ID does not exist', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/allocations/99999/history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-201' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns HTTP 403 PERMISSION_DENIED when Artisan has no workshopId', async () => {
      const res = await fetch(`${base}/allocations/501/history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-no-ws' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('returns HTTP 403 TEMP_PASSWORD_RESTRICTED for temp_password session', async () => {
      const res = await fetch(`${base}/allocations/501/history`, {
        headers: { Cookie: 'vcraft-session=session-temp-artisan' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
    });

    it('returns HTTP 401 AUTHENTICATION_REQUIRED when unauthenticated', async () => {
      const res = await fetch(`${base}/allocations/501/history`);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });

  // =========================================================================
  // Suite D: Persistence Unit Tests (PrismaAllocationLogRepository.findEventsWithPagination)
  // =========================================================================
  describe('Suite D: PrismaAllocationLogRepository.findEventsWithPagination Persistence Unit Tests', () => {
    it('executes count and findMany with ascending chronological order and actor projection without leaking Account PII', async () => {
      const mockRows = [
        {
          id: 16001n,
          allocation_id: 501n,
          event_type: 'created',
          evidence: null,
          prev_status: null,
          new_status: 'not_started',
          performed_by: 10n,
          note: null,
          is_admin_action: false,
          created_at: new Date('2026-11-15T10:00:00.000Z'),
          performedBy: {
            id: 10n,
            display_name: 'Nguyễn Văn An',
            username: 'buyer_an_should_be_stripped',
            password_hash: 'secret_hash_should_be_stripped',
          },
        },
        {
          id: 16002n,
          allocation_id: 501n,
          event_type: 'handover_by_admin',
          evidence: 'Biên bản BB-012/2026',
          prev_status: 'in_production',
          new_status: 'handed_over',
          performed_by: 1n,
          note: 'Hộ mất điện đã xác minh bàn giao',
          is_admin_action: true,
          created_at: new Date('2026-11-20T11:30:00.000Z'),
          performedBy: {
            id: 1n,
            display_name: null,
          },
        },
      ];

      const mockPrismaClient = {
        allocationLog: {
          count: vi.fn().mockResolvedValue(2),
          findMany: vi.fn().mockResolvedValue(mockRows),
        },
      };

      const mockTxRunner = {
        getClient: vi.fn().mockReturnValue(mockPrismaClient),
        run: vi.fn().mockImplementation(async (cb: any) => cb({} as any)),
      } as unknown as PrismaTransactionRunner;

      const repo = new PrismaAllocationLogRepository(mockTxRunner);

      const result = await repo.findEventsWithPagination({
        allocationId: '501',
        page: 1,
        limit: 20,
      });

      expect(mockPrismaClient.allocationLog.count).toHaveBeenCalledWith({
        where: { allocation_id: 501n },
      });
      expect(mockPrismaClient.allocationLog.findMany).toHaveBeenCalledWith({
        where: { allocation_id: 501n },
        include: {
          performedBy: {
            select: {
              id: true,
              display_name: true,
            },
          },
        },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        skip: 0,
        take: 20,
      });

      expect(result.totalRecords).toBe(2);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual({
        id: '16001',
        event_type: 'created',
        prev_status: null,
        new_status: 'not_started',
        performed_by: {
          id: '10',
          display_name: 'Nguyễn Văn An',
        },
        created_at: '2026-11-15T10:00:00.000Z',
        is_admin_action: false,
        note: null,
        evidence: null,
      });
      expect('username' in (result.rows[0].performed_by as object)).toBe(false);
      expect('password_hash' in (result.rows[0].performed_by as object)).toBe(
        false,
      );
      expect(result.rows[1]).toEqual({
        id: '16002',
        event_type: 'handover_by_admin',
        prev_status: 'in_production',
        new_status: 'handed_over',
        performed_by: {
          id: '1',
          display_name: null,
        },
        created_at: '2026-11-20T11:30:00.000Z',
        is_admin_action: true,
        note: 'Hộ mất điện đã xác minh bàn giao',
        evidence: 'Biên bản BB-012/2026',
      });
    });

    it('executes within existing TransactionContext when tx is supplied without calling txRunner.run', async () => {
      const mockPrismaClient = {
        allocationLog: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };

      const mockTxRunner = {
        getClient: vi.fn().mockReturnValue(mockPrismaClient),
        run: vi.fn(),
      } as unknown as PrismaTransactionRunner;

      const repo = new PrismaAllocationLogRepository(mockTxRunner);
      const fakeTx = {} as TransactionContext;

      const result = await repo.findEventsWithPagination(
        {
          allocationId: '501',
          page: 3,
          limit: 10,
        },
        fakeTx,
      );

      expect(mockTxRunner.getClient).toHaveBeenCalledWith(fakeTx);
      expect(mockTxRunner.run).not.toHaveBeenCalled();
      expect(mockPrismaClient.allocationLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 10,
        }),
      );
      expect(result.totalRecords).toBe(0);
      expect(result.rows).toEqual([]);
    });
  });
});
