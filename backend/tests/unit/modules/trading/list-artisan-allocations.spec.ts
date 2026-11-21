import 'reflect-metadata';
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
  type TransactionRunner,
} from '../../../../src/common/application/ports/transaction-runner';
import {
  ALLOCATION_REPOSITORY,
  type IAllocationRepository,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { ListArtisanAllocationsUseCase } from '../../../../src/modules/trading/application/use-cases/fulfillment/list-artisan-allocations.use-case';
import { ArtisanAllocationController } from '../../../../src/modules/trading/adapters/http/controllers/artisan-allocation.controller';
import { Prisma } from '../../../../src/generated/prisma/client';
import { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import { PrismaAllocationRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/allocation.repository';
import type { PrismaService } from '../../../../src/infrastructure/database/prisma/prisma.service';
import {
  Allocation,
  AllocationBatchLink,
  type AllocationStatus,
  InvalidTradingInputError,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import type { AllocationDto } from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';
import { HttpResult } from '../../../../src/common/http/interceptors/response-envelope.interceptor';

// ---------------------------------------------------------------------------
// Test Actors
// ---------------------------------------------------------------------------
const buyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-1',
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

const assignedArtisan1Actor: AuthenticatedActor = Object.freeze({
  accountId: '21',
  role: 'artisan',
  workshopId: '201',
  authVersion: 1,
  sessionId: 'session-artisan-201',
  sessionLevel: 'normal',
});

const assignedArtisan2Actor: AuthenticatedActor = Object.freeze({
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
function createSampleAllocation(
  overrides: Partial<{
    id: string;
    request_id: string;
    workshop_id: string;
    quote_id: string;
    quantity: number;
    unit_price: number;
    committed_delivery_at: Date;
    status: AllocationStatus;
    version: number;
    batch_links: readonly AllocationBatchLink[];
  }> = {},
): Allocation {
  return Allocation.reconstitute({
    id: overrides.id ?? '501',
    request_id: overrides.request_id ?? '100',
    workshop_id: overrides.workshop_id ?? '201',
    quote_id: overrides.quote_id ?? '401',
    quantity: overrides.quantity ?? 100,
    unit_price: overrides.unit_price ?? 450000,
    committed_delivery_at:
      overrides.committed_delivery_at ?? new Date('2026-12-01T10:00:00.000Z'),
    status: overrides.status ?? 'not_started',
    version: overrides.version ?? 1,
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
    batch_links: overrides.batch_links ?? [],
  });
}

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
    status: overrides.status ?? 'not_started',
    version: overrides.version ?? 1,
    started_at: overrides.started_at ?? null,
    started_by: overrides.started_by ?? null,
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

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
describe('Task 27 (UC-23): GET /api/v1/artisan/allocations', () => {
  const identityMock = new MockIdentityContract();
  const txRunner = new MockTransactionRunner();
  const mockAllocationRepo = {
    findArtisanAllocations: vi.fn(),
  };

  let useCase: ListArtisanAllocationsUseCase;
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
        provide: ListArtisanAllocationsUseCase,
        useFactory: (tr: TransactionRunner, allocRepo: IAllocationRepository) =>
          new ListArtisanAllocationsUseCase(tr, allocRepo),
        inject: [TRANSACTION_RUNNER, ALLOCATION_REPOSITORY],
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

    useCase = new ListArtisanAllocationsUseCase(
      txRunner,
      mockAllocationRepo as unknown as IAllocationRepository,
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
      if (token === 'session-buyer-1') return buyerActor;
      if (token === 'session-admin-1') return adminActor;
      if (token === 'session-artisan-201') return assignedArtisan1Actor;
      if (token === 'session-artisan-202') return assignedArtisan2Actor;
      if (token === 'session-artisan-no-ws') return artisanWithoutWorkshopActor;
      if (token === 'session-temp-artisan') return tempPasswordArtisanActor;
      return null;
    });
  });

  // =========================================================================
  // Suite A: UseCase Unit Tests (ListArtisanAllocationsUseCase)
  // =========================================================================
  describe('Suite A: ListArtisanAllocationsUseCase Unit Tests', () => {
    it('throws TEMP_PASSWORD_RESTRICTED when session level is temp_password (SEC-05)', async () => {
      await expect(
        useCase.execute({
          actor: tempPasswordArtisanActor,
        }),
      ).rejects.toThrow(TradingDomainError);

      try {
        await useCase.execute({ actor: tempPasswordArtisanActor });
      } catch (err: unknown) {
        expect((err as TradingDomainError).code).toBe('TEMP_PASSWORD_RESTRICTED');
      }
    });

    it('throws PERMISSION_DENIED when actor role is buyer', async () => {
      await expect(
        useCase.execute({
          actor: buyerActor,
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('throws PERMISSION_DENIED when actor role is admin', async () => {
      await expect(
        useCase.execute({
          actor: adminActor,
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('throws PERMISSION_DENIED when artisan has no workshopId', async () => {
      await expect(
        useCase.execute({
          actor: artisanWithoutWorkshopActor,
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('enforces Zero-IDOR: queries repository strictly with workshopId = actor.workshopId', async () => {
      const dtos = [createSampleAllocationDto({ id: '501' })];
      mockAllocationRepo.findArtisanAllocations.mockResolvedValueOnce({
        rows: dtos,
        totalRecords: 1,
      });

      const result = await useCase.execute({
        actor: assignedArtisan1Actor,
      });

      expect(mockAllocationRepo.findArtisanAllocations).toHaveBeenCalledWith(
        expect.objectContaining({
          workshopId: '201',
          page: 1,
          limit: 20,
        }),
        expect.anything(),
      );

      expect(result).toBeInstanceOf(HttpResult);
      expect(result.data).toEqual(dtos);
      expect(result.metadata.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 1,
        total_pages: 1,
      });
    });

    it('supports status filtering for not_started, in_production, and handed_over', async () => {
      mockAllocationRepo.findArtisanAllocations.mockResolvedValue({
        rows: [],
        totalRecords: 0,
      });

      await useCase.execute({
        actor: assignedArtisan1Actor,
        query: { status: 'in_production' },
      });

      expect(mockAllocationRepo.findArtisanAllocations).toHaveBeenCalledWith(
        expect.objectContaining({
          workshopId: '201',
          status: 'in_production',
        }),
        expect.anything(),
      );
    });

    it('rejects invalid status with InvalidTradingInputError', async () => {
      await expect(
        useCase.execute({
          actor: assignedArtisan1Actor,
          query: { status: 'invalid_status' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('supports delivery deadline filtering by parsing ISO string to Date', async () => {
      mockAllocationRepo.findArtisanAllocations.mockResolvedValue({
        rows: [],
        totalRecords: 0,
      });

      const deadlineStr = '2026-12-15T18:00:00.000Z';
      await useCase.execute({
        actor: assignedArtisan1Actor,
        query: { delivery_deadline: deadlineStr },
      });

      expect(mockAllocationRepo.findArtisanAllocations).toHaveBeenCalledWith(
        expect.objectContaining({
          workshopId: '201',
          deliveryDeadline: new Date(deadlineStr),
        }),
        expect.anything(),
      );
    });

    it('supports committed_delivery_at alias for delivery deadline', async () => {
      mockAllocationRepo.findArtisanAllocations.mockResolvedValue({
        rows: [],
        totalRecords: 0,
      });

      const deadlineStr = '2026-12-20T10:00:00.000Z';
      await useCase.execute({
        actor: assignedArtisan1Actor,
        query: { committed_delivery_at: deadlineStr },
      });

      expect(mockAllocationRepo.findArtisanAllocations).toHaveBeenCalledWith(
        expect.objectContaining({
          workshopId: '201',
          deliveryDeadline: new Date(deadlineStr),
        }),
        expect.anything(),
      );
    });

    it('rejects invalid delivery deadline format with InvalidTradingInputError', async () => {
      await expect(
        useCase.execute({
          actor: assignedArtisan1Actor,
          query: { delivery_deadline: 'not-a-valid-date' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('supports request_id filtering', async () => {
      mockAllocationRepo.findArtisanAllocations.mockResolvedValue({
        rows: [],
        totalRecords: 0,
      });

      await useCase.execute({
        actor: assignedArtisan1Actor,
        query: { request_id: '105' },
      });

      expect(mockAllocationRepo.findArtisanAllocations).toHaveBeenCalledWith(
        expect.objectContaining({
          workshopId: '201',
          requestId: '105',
        }),
        expect.anything(),
      );
    });

    it('rejects invalid pagination: page < 1', async () => {
      await expect(
        useCase.execute({
          actor: assignedArtisan1Actor,
          query: { page: 0 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('rejects invalid pagination: limit > maxLimit (100)', async () => {
      await expect(
        useCase.execute({
          actor: assignedArtisan1Actor,
          query: { limit: 101 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('rejects non-integer page or limit with InvalidTradingInputError', async () => {
      await expect(
        useCase.execute({
          actor: assignedArtisan1Actor,
          query: { page: 1.5 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: assignedArtisan1Actor,
          query: { limit: 10.2 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('rejects actor with empty string or whitespace workshopId', async () => {
      const emptyWsActor: AuthenticatedActor = {
        ...assignedArtisan1Actor,
        workshopId: '   ' as unknown as string,
      };

      await expect(
        useCase.execute({
          actor: emptyWsActor,
        }),
      ).rejects.toThrow();
    });

    it('correctly calculates total_pages in paginated response', async () => {
      mockAllocationRepo.findArtisanAllocations.mockResolvedValueOnce({
        rows: [createSampleAllocationDto({ id: '501' })],
        totalRecords: 45,
      });

      const result = await useCase.execute({
        actor: assignedArtisan1Actor,
        query: { page: 2, limit: 10 },
      });

      expect(result.metadata.pagination).toEqual({
        page: 2,
        limit: 10,
        total_records: 45,
        total_pages: 5,
      });
    });
  });

  // =========================================================================
  // Suite B: Controller Metadata & Swagger OpenAPI Document
  // =========================================================================
  describe('Suite B: Controller Metadata & Swagger OpenAPI Document', () => {
    it('serves OpenAPI documentation including GET /api/v1/artisan/allocations', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const endpoint = doc.paths?.['/api/v1/artisan/allocations'];
      expect(endpoint).toBeDefined();
      expect(endpoint?.get).toBeDefined();
      expect(endpoint?.get?.summary).toContain('phần việc');
      expect(endpoint?.get?.tags).toContain('trading');
    });

    it('verifies ArtisanAllocationController class and method decorators', () => {
      const policy = Reflect.getMetadata(
        ACCESS_POLICY,
        ArtisanAllocationController,
      );
      expect(policy).toEqual({ kind: 'roles', roles: ['artisan'] });

      const sessionMeta = Reflect.getMetadata(
        SESSION_LEVELS,
        ArtisanAllocationController,
      );
      expect(sessionMeta).toEqual(['normal']);

      const proto = ArtisanAllocationController.prototype;
      const headers = Reflect.getMetadata(
        '__headers__',
        proto.listAllocations,
      );
      expect(headers).toEqual(
        expect.arrayContaining([{ name: 'Cache-Control', value: 'no-store' }]),
      );

      const paramTypes = Reflect.getMetadata(
        'design:paramtypes',
        proto,
        'listAllocations',
      );
      expect(paramTypes).toBeDefined();
      expect(paramTypes).toHaveLength(2);
    });
  });

  // =========================================================================
  // Suite C: HTTP Controller Integration Tests
  // =========================================================================
  describe('Suite C: HTTP Controller Integration Tests', () => {
    it('returns HTTP 200 with Cache-Control: no-store and paginated data for Artisan', async () => {
      const dtos = [
        createSampleAllocationDto({ id: '501' }),
        createSampleAllocationDto({ id: '502' }),
      ];

      mockAllocationRepo.findArtisanAllocations.mockResolvedValueOnce({
        rows: dtos,
        totalRecords: 2,
      });

      const res = await fetch(`${base}/artisan/allocations?page=1&limit=10`, {
        headers: { Cookie: 'vcraft-session=session-artisan-201' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.data[0].id).toBe('501');
      expect(json.pagination).toEqual({
        page: 1,
        limit: 10,
        total_records: 2,
        total_pages: 1,
      });
    });

    it('returns HTTP 401 AUTHENTICATION_REQUIRED when no session cookie is provided', async () => {
      const res = await fetch(`${base}/artisan/allocations`);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns HTTP 403 PERMISSION_DENIED when actor role is buyer', async () => {
      const res = await fetch(`${base}/artisan/allocations`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('returns HTTP 403 PERMISSION_DENIED when actor role is admin', async () => {
      const res = await fetch(`${base}/artisan/allocations`, {
        headers: { Cookie: 'vcraft-session=session-admin-1' },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('returns HTTP 403 PERMISSION_DENIED when artisan has no workshopId', async () => {
      const res = await fetch(`${base}/artisan/allocations`, {
        headers: { Cookie: 'vcraft-session=session-artisan-no-ws' },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('returns HTTP 403 TEMP_PASSWORD_RESTRICTED for temporary password session', async () => {
      const res = await fetch(`${base}/artisan/allocations`, {
        headers: { Cookie: 'vcraft-session=session-temp-artisan' },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
    });

    it('returns HTTP 400 INVALID_INPUT for invalid query parameters (negative page)', async () => {
      const res = await fetch(`${base}/artisan/allocations?page=-1`, {
        headers: { Cookie: 'vcraft-session=session-artisan-201' },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('returns HTTP 400 INVALID_INPUT for invalid status filter', async () => {
      const res = await fetch(`${base}/artisan/allocations?status=unknown_state`, {
        headers: { Cookie: 'vcraft-session=session-artisan-201' },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('returns HTTP 400 INVALID_INPUT for malformed delivery_deadline', async () => {
      const res = await fetch(
        `${base}/artisan/allocations?delivery_deadline=invalid_date`,
        {
          headers: { Cookie: 'vcraft-session=session-artisan-201' },
        },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('returns HTTP 200 with filtered status and delivery deadline query', async () => {
      mockAllocationRepo.findArtisanAllocations.mockResolvedValueOnce({
        rows: [createSampleAllocationDto({ id: '501', status: 'in_production' })],
        totalRecords: 1,
      });

      const res = await fetch(
        `${base}/artisan/allocations?status=in_production&delivery_deadline=2026-12-31T23:59:59.000Z`,
        {
          headers: { Cookie: 'vcraft-session=session-artisan-201' },
        },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].status).toBe('in_production');
    });

    it('returns HTTP 400 INVALID_INPUT when attempting parameter injection (e.g. workshop_id override)', async () => {
      const res = await fetch(
        `${base}/artisan/allocations?workshop_id=999`,
        {
          headers: { Cookie: 'vcraft-session=session-artisan-201' },
        },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });
  });

  // =========================================================================
  // Suite D: Persistence Unit Tests (PrismaAllocationRepository.findArtisanAllocations)
  // =========================================================================
  describe('Suite D: PrismaAllocationRepository.findArtisanAllocations Persistence Unit Tests', () => {
    const NOW = new Date('2026-11-15T10:00:00.000Z');
    const DELIVERY_DATE = new Date('2026-12-01T10:00:00.000Z');

    it('strictly enforces Zero-IDOR with where: { workshop_id: 201n }', async () => {
      const mockClient = {
        allocation: {
          count: vi.fn().mockResolvedValue(1),
          findMany: vi.fn().mockResolvedValue([
            {
              id: 501n,
              request_id: 100n,
              workshop_id: 201n,
              quote_id: 401n,
              quantity: 100,
              unit_price: new Prisma.Decimal('450000'),
              committed_delivery_at: DELIVERY_DATE,
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
              created_at: NOW,
              updated_at: NOW,
              workshop: {
                id: 201n,
                name: 'Xưởng Gốm Bát Tràng',
              },
              startedBy: null,
              handedOverBy: null,
              allocationBatches: [],
            },
          ]),
        },
      };

      const mockPrisma = {
        $transaction: vi.fn(
          async (fn: (tx: unknown) => Promise<unknown>) => await fn(mockClient),
        ),
        ...mockClient,
      } as unknown as PrismaService;

      const prismaTxRunner = new PrismaTransactionRunner(mockPrisma);
      const repo = new PrismaAllocationRepository(prismaTxRunner, mockPrisma);

      const res = await prismaTxRunner.run((tx) =>
        repo.findArtisanAllocations(
          { workshopId: '201', page: 1, limit: 10 },
          tx,
        ),
      );

      expect(mockClient.allocation.count).toHaveBeenCalledWith({
        where: { workshop_id: 201n },
      });
      expect(mockClient.allocation.findMany).toHaveBeenCalledWith({
        where: { workshop_id: 201n },
        include: {
          workshop: { select: { id: true, name: true } },
          startedBy: { select: { id: true, display_name: true } },
          handedOverBy: { select: { id: true, display_name: true } },
          allocationBatches: {
            include: {
              batch: { select: { id: true, status: true } },
            },
            orderBy: { id: 'asc' },
          },
        },
        orderBy: { id: 'desc' },
        skip: 0,
        take: 10,
      });

      expect(res.totalRecords).toBe(1);
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].id).toBe('501');
      expect(res.rows[0].workshop).toEqual({
        id: '201',
        name: 'Xưởng Gốm Bát Tràng',
      });
      // Verification: NO_BATCH_LINK traceability warning derived when no batches linked
      expect(res.rows[0].traceability_warning).toBe('NO_BATCH_LINK');
    });

    it('queries with status filter, delivery deadline filter, and derives published batches', async () => {
      const mockClient = {
        allocation: {
          count: vi.fn().mockResolvedValue(1),
          findMany: vi.fn().mockResolvedValue([
            {
              id: 501n,
              request_id: 100n,
              workshop_id: 201n,
              quote_id: 401n,
              quantity: 100,
              unit_price: new Prisma.Decimal('450000'),
              committed_delivery_at: DELIVERY_DATE,
              status: 'in_production',
              version: 2,
              started_at: NOW,
              started_by: 21n,
              handed_over_at: null,
              handed_over_by: null,
              delivery_note: null,
              admin_handed_over: false,
              admin_delivery_evidence: null,
              admin_handover_reason: null,
              admin_handover_actual_at: null,
              created_at: NOW,
              updated_at: NOW,
              workshop: {
                id: 201n,
                name: 'Xưởng Gốm Bát Tràng',
              },
              startedBy: {
                id: 21n,
                display_name: 'Nghệ nhân Hưng Thịnh',
              },
              handedOverBy: null,
              allocationBatches: [
                {
                  id: 10n,
                  workshop_id: 201n,
                  allocation_id: 501n,
                  batch_id: 1001n,
                  linked_quantity: 100,
                  linked_at: NOW,
                  linked_by: 21n,
                  batch: {
                    id: 1001n,
                    status: 'published',
                  },
                },
              ],
            },
          ]),
        },
      };

      const mockPrisma = {
        $transaction: vi.fn(
          async (fn: (tx: unknown) => Promise<unknown>) => await fn(mockClient),
        ),
        ...mockClient,
      } as unknown as PrismaService;

      const prismaTxRunner = new PrismaTransactionRunner(mockPrisma);
      const repo = new PrismaAllocationRepository(prismaTxRunner, mockPrisma);

      const targetDeadline = new Date('2026-12-15T00:00:00.000Z');
      const res = await repo.findArtisanAllocations({
        workshopId: '201',
        status: 'in_production',
        deliveryDeadline: targetDeadline,
        requestId: '100',
      });

      expect(mockClient.allocation.count).toHaveBeenCalledWith({
        where: {
          workshop_id: 201n,
          status: 'in_production',
          committed_delivery_at: { lte: targetDeadline },
          request_id: 100n,
        },
      });

      expect(res.rows[0].started_by).toEqual({
        id: '21',
        display_name: 'Nghệ nhân Hưng Thịnh',
      });
      // Verification: traceability_warning is null when all linked batches are published and quantity is met
      expect(res.rows[0].traceability_warning).toBeNull();
    });

    it('derives INCOMPLETE_TRACEABILITY when batch is not published or linked quantity is insufficient', async () => {
      const mockClient = {
        allocation: {
          count: vi.fn().mockResolvedValue(1),
          findMany: vi.fn().mockResolvedValue([
            {
              id: 502n,
              request_id: 100n,
              workshop_id: 201n,
              quote_id: 402n,
              quantity: 100,
              unit_price: new Prisma.Decimal('450000'),
              committed_delivery_at: DELIVERY_DATE,
              status: 'in_production',
              version: 2,
              started_at: NOW,
              started_by: 21n,
              handed_over_at: null,
              handed_over_by: null,
              delivery_note: null,
              admin_handed_over: false,
              admin_delivery_evidence: null,
              admin_handover_reason: null,
              admin_handover_actual_at: null,
              created_at: NOW,
              updated_at: NOW,
              workshop: {
                id: 201n,
                name: 'Xưởng Gốm Bát Tràng',
              },
              startedBy: { id: 21n, display_name: 'Nghệ nhân' },
              handedOverBy: null,
              allocationBatches: [
                {
                  id: 11n,
                  workshop_id: 201n,
                  allocation_id: 502n,
                  batch_id: 1002n,
                  linked_quantity: 40, // only 40 out of 100
                  linked_at: NOW,
                  linked_by: 21n,
                  batch: {
                    id: 1002n,
                    status: 'draft', // not published
                  },
                },
              ],
            },
          ]),
        },
      };

      const mockPrisma = {
        $transaction: vi.fn(
          async (fn: (tx: unknown) => Promise<unknown>) => await fn(mockClient),
        ),
        ...mockClient,
      } as unknown as PrismaService;

      const prismaTxRunner = new PrismaTransactionRunner(mockPrisma);
      const repo = new PrismaAllocationRepository(prismaTxRunner, mockPrisma);

      const res = await repo.findArtisanAllocations({
        workshopId: '201',
      });

      expect(res.rows[0].traceability_warning).toBe('INCOMPLETE_TRACEABILITY');
    });
  });
});
