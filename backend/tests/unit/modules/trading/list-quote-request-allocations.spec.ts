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
  IAllocationRepository,
  IQuoteRequestRepository,
  QUOTE_REQUEST_REPOSITORY,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { GetQuoteRequestByIdUseCase } from '../../../../src/modules/trading/application/use-cases/requests/get-quote-request-by-id.use-case';
import { ListQuoteRequestAllocationsUseCase } from '../../../../src/modules/trading/application/use-cases/fulfillment/list-quote-request-allocations.use-case';
import { QuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/quote-request.controller';
import { Prisma } from '../../../../src/generated/prisma/client';
import { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import { PrismaAllocationRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/allocation.repository';
import type { PrismaService } from '../../../../src/infrastructure/database/prisma/prisma.service';
import {
  Allocation,
  AllocationBatchLink,
  type AllocationStatus,
  InvalidTradingInputError,
  QuoteRequest,
  QuoteRequestNotFoundError,
  type RequestStatus,
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

const otherBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '99',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-other-buyer',
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

const unassignedArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '29',
  role: 'artisan',
  workshopId: '299',
  authVersion: 1,
  sessionId: 'session-artisan-unassigned',
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

const tempPasswordBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-temp-buyer',
  sessionLevel: 'temp_password',
});

const tempPasswordArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '21',
  role: 'artisan',
  workshopId: '201',
  authVersion: 1,
  sessionId: 'session-temp-artisan',
  sessionLevel: 'temp_password',
});

const tempPasswordAdminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-temp-admin',
  sessionLevel: 'temp_password',
});

// ---------------------------------------------------------------------------
// Fixtures & Helpers
// ---------------------------------------------------------------------------
function createSampleQuoteRequest(
  overrides: Partial<{
    id: string;
    buyer_id: string;
    status: RequestStatus;
  }> = {},
): QuoteRequest {
  const nowMs = Date.now();
  return QuoteRequest.reconstitute({
    id: overrides.id ?? '100',
    buyer_id: overrides.buyer_id ?? '10',
    category_id: '1',
    spec: 'Bộ ấm chén men lam cổ Bát Tràng',
    quantity: 100,
    unit: 'set',
    unit_set_description: '1 ấm + 6 chén + 1 đĩa lót',
    status: overrides.status ?? 'buyer_accepted',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội',
    delivery_address: 'Kho Cảng Hải Phòng',
    recipient_name: 'Trần Văn Nhận',
    recipient_phone: '0912345678',
    bidding_deadline: new Date(nowMs + 86_400_000 * 2),
    delivery_deadline: new Date(nowMs + 86_400_000 * 14),
    bidding_closed_at: new Date(nowMs - 86_400_000),
    version: 3,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: new Date('2026-11-10T10:00:00.000Z'),
    updated_at: new Date('2026-11-15T10:00:00.000Z'),
  });
}

function createSampleAllocation(
  overrides: Partial<{
    id: string;
    request_id: string;
    workshop_id: string;
    quote_id: string;
    quantity: number;
    unit_price: number;
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
    committed_delivery_at: new Date('2026-12-01T10:00:00.000Z'),
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
        name: 'Xưởng Gốm Minh Long',
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
describe('GET /api/v1/quote-requests/:id/allocations (Task 26: UC-23, BR-04, BR-20, BR-24, SEC-05, SEC-06)', () => {
  const identityMock = new MockIdentityContract();
  const txRunner = new MockTransactionRunner();

  const mockQuoteRequestRepo = {
    findById: vi.fn(),
    findDetailById: vi.fn(),
  };

  const mockAllocationRepo = {
    findByRequestAndWorkshop: vi.fn(),
    findAllocationsWithDetails: vi.fn(),
  };

  let useCase: ListQuoteRequestAllocationsUseCase;
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
    controllers: [QuoteRequestController],
    providers: [
      { provide: TRANSACTION_RUNNER, useValue: txRunner },
      { provide: QUOTE_REQUEST_REPOSITORY, useValue: mockQuoteRequestRepo },
      { provide: ALLOCATION_REPOSITORY, useValue: mockAllocationRepo },
      {
        provide: GetQuoteRequestByIdUseCase,
        useFactory: (
          tr: TransactionRunner,
          qrRepo: IQuoteRequestRepository,
        ) => new GetQuoteRequestByIdUseCase(tr, qrRepo),
        inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
      },
      {
        provide: ListQuoteRequestAllocationsUseCase,
        useFactory: (
          tr: TransactionRunner,
          qrRepo: IQuoteRequestRepository,
          allocRepo: IAllocationRepository,
        ) => new ListQuoteRequestAllocationsUseCase(tr, qrRepo, allocRepo),
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

    useCase = new ListQuoteRequestAllocationsUseCase(
      txRunner,
      mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
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
      if (token === 'session-other-buyer') return otherBuyerActor;
      if (token === 'session-admin-1') return adminActor;
      if (token === 'session-artisan-201') return assignedArtisan1Actor;
      if (token === 'session-artisan-202') return assignedArtisan2Actor;
      if (token === 'session-artisan-unassigned') return unassignedArtisanActor;
      if (token === 'session-artisan-no-ws') return artisanWithoutWorkshopActor;
      if (token === 'session-temp-buyer') return tempPasswordBuyerActor;
      if (token === 'session-temp-artisan') return tempPasswordArtisanActor;
      if (token === 'session-temp-admin') return tempPasswordAdminActor;
      return null;
    });
  });

  // =========================================================================
  // Suite A: Use-Case Unit Tests
  // =========================================================================
  describe('Suite A: ListQuoteRequestAllocationsUseCase Unit Tests', () => {
    it('allows owner Buyer to retrieve all allocations of their quote request with pagination', async () => {
      const request = createSampleQuoteRequest({ id: '100', buyer_id: '10' });
      const dtos = [
        createSampleAllocationDto({ id: '501', workshop: { id: '201', name: 'Xưởng 201' } }),
        createSampleAllocationDto({ id: '502', workshop: { id: '202', name: 'Xưởng 202' } }),
      ];

      mockQuoteRequestRepo.findById.mockResolvedValue(request);
      mockAllocationRepo.findAllocationsWithDetails.mockResolvedValue({
        rows: dtos,
        totalRecords: 2,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
        query: { page: 1, limit: 10 },
      });

      expect(result).toBeInstanceOf(HttpResult);
      expect(mockAllocationRepo.findAllocationsWithDetails).toHaveBeenCalledWith(
        {
          requestId: '100',
          workshopId: undefined,
          status: undefined,
          page: 1,
          limit: 10,
        },
        expect.anything(),
      );
      expect(result.data).toHaveLength(2);
      expect(result.metadata.pagination).toEqual({
        page: 1,
        limit: 10,
        total_records: 2,
        total_pages: 1,
      });
    });

    it('returns empty array when quote request exists but has no allocations yet (for owner Buyer)', async () => {
      const request = createSampleQuoteRequest({ id: '100', buyer_id: '10', status: 'draft_request' });

      mockQuoteRequestRepo.findById.mockResolvedValue(request);
      mockAllocationRepo.findAllocationsWithDetails.mockResolvedValue({
        rows: [],
        totalRecords: 0,
      });

      const result = await useCase.execute({
        actor: buyerActor,
        requestId: '100',
      });

      expect(result.data).toEqual([]);
      expect(result.metadata.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 0,
        total_pages: 0,
      });
    });

    it('allows Admin to retrieve all allocations across workshops without workshopId filter', async () => {
      const request = createSampleQuoteRequest({ id: '100', buyer_id: '10' });
      const dtos = [
        createSampleAllocationDto({ id: '501' }),
        createSampleAllocationDto({ id: '502' }),
      ];

      mockQuoteRequestRepo.findById.mockResolvedValue(request);
      mockAllocationRepo.findAllocationsWithDetails.mockResolvedValue({
        rows: [dtos[1]],
        totalRecords: 2,
      });

      const result = await useCase.execute({
        actor: adminActor,
        requestId: '100',
        query: { status: 'not_started', page: 2, limit: 1 },
      });

      expect(mockAllocationRepo.findAllocationsWithDetails).toHaveBeenCalledWith(
        {
          requestId: '100',
          workshopId: undefined,
          status: 'not_started',
          page: 2,
          limit: 1,
        },
        expect.anything(),
      );
      expect(result.data).toHaveLength(1);
      expect(result.metadata.pagination).toEqual({
        page: 2,
        limit: 1,
        total_records: 2,
        total_pages: 2,
      });
    });

    it('SEC-06 anti-IDOR: throws QuoteRequestNotFoundError when non-owner Buyer accesses allocations', async () => {
      const request = createSampleQuoteRequest({ id: '100', buyer_id: '10' });
      mockQuoteRequestRepo.findById.mockResolvedValue(request);

      await expect(
        useCase.execute({
          actor: otherBuyerActor, // accountId = '99'
          requestId: '100',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(mockAllocationRepo.findAllocationsWithDetails).not.toHaveBeenCalled();
    });

    it('BR-04: allows assigned Artisan to retrieve ONLY their own workshop allocation (totalRecords = 1)', async () => {
      const request = createSampleQuoteRequest({ id: '100' });
      const ownAllocation = createSampleAllocation({
        id: '501',
        request_id: '100',
        workshop_id: '201',
      });
      const dtos = [
        createSampleAllocationDto({
          id: '501',
          workshop: { id: '201', name: 'Xưởng Gốm 201' },
        }),
      ];

      mockQuoteRequestRepo.findById.mockResolvedValue(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValue(ownAllocation);
      mockAllocationRepo.findAllocationsWithDetails.mockResolvedValue({
        rows: dtos,
        totalRecords: 1,
      });

      const result = await useCase.execute({
        actor: assignedArtisan1Actor, // workshopId = '201'
        requestId: '100',
      });

      expect(mockAllocationRepo.findByRequestAndWorkshop).toHaveBeenCalledWith(
        '100',
        '201',
        expect.anything(),
      );
      expect(mockAllocationRepo.findAllocationsWithDetails).toHaveBeenCalledWith(
        {
          requestId: '100',
          workshopId: '201', // strictly scoped to their workshop
          status: undefined,
          page: 1,
          limit: 20,
        },
        expect.anything(),
      );
      expect(result.data).toHaveLength(1);
      expect(result.data[0].workshop.id).toBe('201');
      expect(result.metadata.pagination.total_records).toBe(1);
    });

    it('SEC-06 anti-IDOR: throws QuoteRequestNotFoundError when unassigned Artisan accesses allocations', async () => {
      const request = createSampleQuoteRequest({ id: '100' });
      mockQuoteRequestRepo.findById.mockResolvedValue(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValue(null);

      await expect(
        useCase.execute({
          actor: unassignedArtisanActor, // workshopId = '299'
          requestId: '100',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      expect(mockAllocationRepo.findAllocationsWithDetails).not.toHaveBeenCalled();
    });

    it('throws TradingPermissionDeniedError when Artisan has no workshopId', async () => {
      const request = createSampleQuoteRequest({ id: '100' });
      mockQuoteRequestRepo.findById.mockResolvedValue(request);

      await expect(
        useCase.execute({
          actor: artisanWithoutWorkshopActor, // workshopId = null
          requestId: '100',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('SEC-05: throws TEMP_PASSWORD_RESTRICTED for any actor in temp_password session', async () => {
      for (const actor of [
        tempPasswordBuyerActor,
        tempPasswordArtisanActor,
        tempPasswordAdminActor,
      ]) {
        await expect(
          useCase.execute({
            actor,
            requestId: '100',
          }),
        ).rejects.toThrowError(
          expect.objectContaining({
            code: 'TEMP_PASSWORD_RESTRICTED',
          }),
        );
      }
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('throws QuoteRequestNotFoundError when quote request does not exist', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValue(null);

      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '999',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);
    });

    it('throws InvalidTradingInputError when requestId is non-numeric or malformed', async () => {
      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: 'invalid-id',
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '-5',
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('throws InvalidTradingInputError when page < 1', async () => {
      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '100',
          query: { page: 0 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('throws InvalidTradingInputError when limit > 100', async () => {
      await expect(
        useCase.execute({
          actor: adminActor,
          requestId: '100',
          query: { limit: 101 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });
  });

  // =========================================================================
  // Suite B: Traceability Warning Derivation Tests
  // =========================================================================
  describe('Suite B: Traceability Warning Derivation Logic', () => {
    it('derives NO_BATCH_LINK when allocation has no batch links', () => {
      const allocation = createSampleAllocation({
        quantity: 100,
        batch_links: [],
      });
      const publishedBatchIds = new Set<string>(['1001', '1002']);

      expect(allocation.deriveTraceabilityWarning(publishedBatchIds)).toBe(
        'NO_BATCH_LINK',
      );
    });

    it('derives INCOMPLETE_TRACEABILITY when a linked batch is not published', () => {
      const link = AllocationBatchLink.reconstitute({
        id: '1',
        workshop_id: '201',
        allocation_id: '501',
        batch_id: '1001',
        linked_quantity: 100,
        linked_at: new Date('2026-11-16T10:00:00.000Z'),
        linked_by: '21',
      });
      const allocation = createSampleAllocation({
        quantity: 100,
        batch_links: [link],
      });
      const publishedBatchIds = new Set<string>(); // 1001 is NOT published

      expect(allocation.deriveTraceabilityWarning(publishedBatchIds)).toBe(
        'INCOMPLETE_TRACEABILITY',
      );
    });

    it('derives INCOMPLETE_TRACEABILITY when total linked quantity is less than allocation quantity', () => {
      const link = AllocationBatchLink.reconstitute({
        id: '1',
        workshop_id: '201',
        allocation_id: '501',
        batch_id: '1001',
        linked_quantity: 60, // 60 < 100
        linked_at: new Date('2026-11-16T10:00:00.000Z'),
        linked_by: '21',
      });
      const allocation = createSampleAllocation({
        quantity: 100,
        batch_links: [link],
      });
      const publishedBatchIds = new Set<string>(['1001']);

      expect(allocation.deriveTraceabilityWarning(publishedBatchIds)).toBe(
        'INCOMPLETE_TRACEABILITY',
      );
    });

    it('derives null when all linked batches are published and total quantity is fully covered', () => {
      const link1 = AllocationBatchLink.reconstitute({
        id: '1',
        workshop_id: '201',
        allocation_id: '501',
        batch_id: '1001',
        linked_quantity: 60,
        linked_at: new Date('2026-11-16T10:00:00.000Z'),
        linked_by: '21',
      });
      const link2 = AllocationBatchLink.reconstitute({
        id: '2',
        workshop_id: '201',
        allocation_id: '501',
        batch_id: '1002',
        linked_quantity: 40,
        linked_at: new Date('2026-11-16T10:00:00.000Z'),
        linked_by: '21',
      });
      const allocation = createSampleAllocation({
        quantity: 100,
        batch_links: [link1, link2],
      });
      const publishedBatchIds = new Set<string>(['1001', '1002']);

      expect(allocation.deriveTraceabilityWarning(publishedBatchIds)).toBeNull();
    });
  });

  // =========================================================================
  // Suite C: HTTP Controller Integration Tests
  // =========================================================================
  describe('Suite C: HTTP Controller Integration Tests (GET /api/v1/quote-requests/:id/allocations)', () => {
    it('serves OpenAPI documentation including the allocations endpoint', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const endpoint = doc.paths?.['/api/v1/quote-requests/{id}/allocations'];
      expect(endpoint).toBeDefined();
      expect(endpoint?.get).toBeDefined();
      expect(endpoint?.get?.summary).toContain('phần việc');
    });

    it('returns HTTP 200 with Cache-Control: no-store and paginated data for Admin', async () => {
      const request = createSampleQuoteRequest({ id: '100' });
      const dtos = [
        createSampleAllocationDto({ id: '501' }),
        createSampleAllocationDto({ id: '502' }),
      ];

      mockQuoteRequestRepo.findById.mockResolvedValue(request);
      mockAllocationRepo.findAllocationsWithDetails.mockResolvedValue({
        rows: dtos,
        totalRecords: 2,
      });

      const res = await fetch(`${base}/quote-requests/100/allocations?page=1&limit=10`, {
        headers: { Cookie: 'vcraft-session=session-admin-1' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.pagination).toEqual({
        page: 1,
        limit: 10,
        total_records: 2,
        total_pages: 1,
      });
    });

    it('returns HTTP 200 for owner Buyer', async () => {
      const request = createSampleQuoteRequest({ id: '100', buyer_id: '10' });
      const dtos = [createSampleAllocationDto({ id: '501' })];

      mockQuoteRequestRepo.findById.mockResolvedValue(request);
      mockAllocationRepo.findAllocationsWithDetails.mockResolvedValue({
        rows: dtos,
        totalRecords: 1,
      });

      const res = await fetch(`${base}/quote-requests/100/allocations`, {
        headers: { Cookie: 'vcraft-session=session-buyer-1' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('501');
    });

    it('returns HTTP 404 RESOURCE_NOT_FOUND for non-owner Buyer (anti-IDOR)', async () => {
      const request = createSampleQuoteRequest({ id: '100', buyer_id: '10' });
      mockQuoteRequestRepo.findById.mockResolvedValue(request);

      const res = await fetch(`${base}/quote-requests/100/allocations`, {
        headers: { Cookie: 'vcraft-session=session-other-buyer' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns HTTP 200 for assigned Artisan with 1 scoped allocation', async () => {
      const request = createSampleQuoteRequest({ id: '100' });
      const ownAllocation = createSampleAllocation({
        id: '501',
        workshop_id: '201',
      });
      const dtos = [
        createSampleAllocationDto({
          id: '501',
          workshop: { id: '201', name: 'Xưởng 201' },
        }),
      ];

      mockQuoteRequestRepo.findById.mockResolvedValue(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValue(ownAllocation);
      mockAllocationRepo.findAllocationsWithDetails.mockResolvedValue({
        rows: dtos,
        totalRecords: 1,
      });

      const res = await fetch(`${base}/quote-requests/100/allocations`, {
        headers: { Cookie: 'vcraft-session=session-artisan-201' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].workshop.id).toBe('201');
      expect(json.pagination.total_records).toBe(1);
    });

    it('returns HTTP 404 RESOURCE_NOT_FOUND for unassigned Artisan (anti-IDOR)', async () => {
      const request = createSampleQuoteRequest({ id: '100' });
      mockQuoteRequestRepo.findById.mockResolvedValue(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValue(null);

      const res = await fetch(`${base}/quote-requests/100/allocations`, {
        headers: { Cookie: 'vcraft-session=session-artisan-unassigned' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns HTTP 403 PERMISSION_DENIED for Artisan without workshopId', async () => {
      const request = createSampleQuoteRequest({ id: '100' });
      mockQuoteRequestRepo.findById.mockResolvedValue(request);

      const res = await fetch(`${base}/quote-requests/100/allocations`, {
        headers: { Cookie: 'vcraft-session=session-artisan-no-ws' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('returns HTTP 403 TEMP_PASSWORD_RESTRICTED for temporary password session', async () => {
      const res = await fetch(`${base}/quote-requests/100/allocations`, {
        headers: { Cookie: 'vcraft-session=session-temp-buyer' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
    });

    it('returns HTTP 400 INVALID_INPUT for invalid query parameters', async () => {
      const res = await fetch(`${base}/quote-requests/100/allocations?page=-1`, {
        headers: { Cookie: 'vcraft-session=session-admin-1' },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('returns HTTP 401 AUTHENTICATION_REQUIRED when no bearer token is supplied', async () => {
      const res = await fetch(`${base}/quote-requests/100/allocations`);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });

  // =========================================================================
  // Suite D: Persistence Unit Tests (PrismaAllocationRepository.findAllocationsWithDetails)
  // =========================================================================
  describe('Suite D: PrismaAllocationRepository.findAllocationsWithDetails Persistence Unit Tests', () => {
    const NOW = new Date('2026-11-15T10:00:00.000Z');
    const DELIVERY_DATE = new Date('2026-12-01T10:00:00.000Z');

    it('queries with unscoped where={request_id}, deterministic pagination and joins', async () => {
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
                name: 'Xưởng Gốm Minh Long',
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
        repo.findAllocationsWithDetails(
          { requestId: '100', page: 1, limit: 10 },
          tx,
        ),
      );

      expect(mockClient.allocation.count).toHaveBeenCalledWith({
        where: { request_id: 100n },
      });
      expect(mockClient.allocation.findMany).toHaveBeenCalledWith({
        where: { request_id: 100n },
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
        orderBy: { id: 'asc' },
        skip: 0,
        take: 10,
      });

      expect(res.totalRecords).toBe(1);
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].id).toBe('501');
      expect(res.rows[0].workshop).toEqual({
        id: '201',
        name: 'Xưởng Gốm Minh Long',
      });
      expect(res.rows[0].traceability_warning).toBe('NO_BATCH_LINK');
    });

    it('queries with scoped workshopId, status filter, and derives published batches', async () => {
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
                name: 'Xưởng Gốm Minh Long',
              },
              startedBy: {
                id: 21n,
                display_name: 'Nghệ nhân Minh Long',
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

      const res = await repo.findAllocationsWithDetails({
        requestId: '100',
        workshopId: '201',
        status: 'in_production',
      });

      expect(mockClient.allocation.count).toHaveBeenCalledWith({
        where: {
          request_id: 100n,
          workshop_id: 201n,
          status: 'in_production',
        },
      });
      expect(res.rows[0].started_by).toEqual({
        id: '21',
        display_name: 'Nghệ nhân Minh Long',
      });
      expect(res.rows[0].traceability_warning).toBeNull();
    });
  });
});
