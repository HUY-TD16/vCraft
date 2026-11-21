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
  ALLOCATION_REPOSITORY,
  type AllocationDetailRecord,
  type IAllocationRepository,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { GetAllocationByIdUseCase } from '../../../../src/modules/trading/application/use-cases/fulfillment/get-allocation-by-id.use-case';
import { AllocationController } from '../../../../src/modules/trading/adapters/http/controllers/allocation.controller';
import { allocationDetailDtoResponseSchema } from '../../../../src/modules/trading/adapters/http/dtos/get-allocation-detail.dto';
import { TradingModule } from '../../../../src/modules/trading/trading.module';
import { Prisma } from '../../../../src/generated/prisma/client';
import { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import { PrismaAllocationRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/allocation.repository';
import type { PrismaService } from '../../../../src/infrastructure/database/prisma/prisma.service';
import {
  AllocationNotFoundError,
  InvalidTradingInputError,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import type { AllocationDto } from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';

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

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
describe('Task 28 (UC-23, BR-04): GET /api/v1/allocations/:id', () => {
  const identityMock = new MockIdentityContract();
  const txRunner = new MockTransactionRunner();
  const mockAllocationRepo = {
    findDetailById: vi.fn(),
  };

  let useCase: GetAllocationByIdUseCase;
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
      {
        provide: GetAllocationByIdUseCase,
        useFactory: (tr: TransactionRunner, allocRepo: IAllocationRepository) =>
          new GetAllocationByIdUseCase(tr, allocRepo),
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

    useCase = new GetAllocationByIdUseCase(
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
  // Suite A: UseCase Unit Tests (GetAllocationByIdUseCase)
  // =========================================================================
  describe('Suite A: GetAllocationByIdUseCase Unit Tests', () => {
    it('unlocks full recipient_name, recipient_phone, delivery_address and allocation fields for owning Artisan (BR-04, UC-23)', async () => {
      const record = createSampleAllocationDetailRecord();
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);

      const result = await useCase.execute({
        actor: owningArtisanActor,
        id: '501',
      });

      expect(Object.isFrozen(result)).toBe(true);
      expect(mockAllocationRepo.findDetailById).toHaveBeenCalledWith(
        '501',
        expect.anything(),
      );
      expect(result).toEqual({
        ...record.allocation,
        recipient_name: 'Nguyễn Văn An',
        recipient_phone: '0912345678',
        delivery_address: 'Số 45 Phố Hàng Đào, Hoàn Kiếm, Hà Nội',
      });
      expect(
        (result as unknown as Record<string, unknown>).requestBuyerId,
      ).toBeUndefined();
      expect(
        (result as unknown as Record<string, unknown>).buyer_id,
      ).toBeUndefined();
    });

    it('retains read access to allocation and Buyer delivery contact even after handover/completion or workshop suspension (BR-04, BR-05)', async () => {
      const handedOverRecord = createSampleAllocationDetailRecord({
        allocation: {
          status: 'handed_over',
          version: 3,
          started_at: '2026-11-16T08:00:00.000Z',
          started_by: { id: '21', display_name: 'Nghệ nhân Hưng Thịnh' },
          handed_over_at: '2026-11-20T10:00:00.000Z',
          handed_over_by: { id: '21', display_name: 'Nghệ nhân Hưng Thịnh' },
          delivery_note: 'Đã bàn giao đủ 100 sản phẩm',
          traceability_warning: null,
        },
      });
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(handedOverRecord);

      const result = await useCase.execute({
        actor: owningArtisanActor,
        id: '501',
      });

      expect(result.status).toBe('handed_over');
      expect(result.recipient_name).toBe('Nguyễn Văn An');
      expect(result.recipient_phone).toBe('0912345678');
      expect(result.delivery_address).toBe(
        'Số 45 Phố Hàng Đào, Hoàn Kiếm, Hà Nội',
      );
    });

    it('returns full AllocationDetailDto for owning Buyer', async () => {
      const record = createSampleAllocationDetailRecord();
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);

      const result = await useCase.execute({
        actor: ownerBuyerActor,
        id: '501',
      });

      expect(result.id).toBe('501');
      expect(result.recipient_name).toBe('Nguyễn Văn An');
      expect(result.recipient_phone).toBe('0912345678');
      expect(result.delivery_address).toBe(
        'Số 45 Phố Hàng Đào, Hoàn Kiếm, Hà Nội',
      );
    });

    it('returns full AllocationDetailDto for Admin including admin handover metadata', async () => {
      const adminHandedOverRecord = createSampleAllocationDetailRecord({
        requestBuyerId: '99',
        allocation: {
          workshop: { id: '299', name: 'Xưởng Gốm Khác' },
          status: 'handed_over',
          version: 4,
          admin_handed_over: true,
          admin_handover_reason: 'Hộ mất điện không truy cập hệ thống',
          admin_delivery_evidence: 'Biên bản ký nhận BB-012/2026',
          admin_handover_actual_at: '2026-11-20T09:30:00.000Z',
          handed_over_by: { id: '1', display_name: 'Quản trị viên' },
        },
      });
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        adminHandedOverRecord,
      );

      const result = await useCase.execute({
        actor: adminActor,
        id: '501',
      });

      expect(result.admin_handed_over).toBe(true);
      expect(result.admin_handover_reason).toBe(
        'Hộ mất điện không truy cập hệ thống',
      );
      expect(result.admin_delivery_evidence).toBe('Biên bản ký nhận BB-012/2026');
      expect(result.admin_handover_actual_at).toBe('2026-11-20T09:30:00.000Z');
      expect(result.recipient_name).toBe('Nguyễn Văn An');
    });

    it('preserves nullable contact fields as null without converting to empty string', async () => {
      const nullableContactRecord = createSampleAllocationDetailRecord({
        recipientName: null,
        recipientPhone: null,
        deliveryAddress: null,
      });
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        nullableContactRecord,
      );

      const result = await useCase.execute({
        actor: owningArtisanActor,
        id: '501',
      });

      expect(result.recipient_name).toBeNull();
      expect(result.recipient_phone).toBeNull();
      expect(result.delivery_address).toBeNull();
    });

    it('throws AllocationNotFoundError (404 anti-IDOR) when non-owner Artisan requests another workshop allocation', async () => {
      const record = createSampleAllocationDetailRecord({
        allocation: { workshop: { id: '201', name: 'Xưởng Gốm 201' } },
      });
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);

      await expect(
        useCase.execute({
          actor: otherArtisanActor,
          id: '501',
        }),
      ).rejects.toThrow(AllocationNotFoundError);
    });

    it('throws AllocationNotFoundError (404 anti-IDOR) when non-owner Buyer requests another Buyer allocation', async () => {
      const record = createSampleAllocationDetailRecord({ requestBuyerId: '10' });
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);

      await expect(
        useCase.execute({
          actor: otherBuyerActor,
          id: '501',
        }),
      ).rejects.toThrow(AllocationNotFoundError);
    });

    it('throws AllocationNotFoundError when allocation does not exist', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(null);

      await expect(
        useCase.execute({
          actor: owningArtisanActor,
          id: '99999',
        }),
      ).rejects.toThrow(AllocationNotFoundError);
    });

    it('throws PERMISSION_DENIED when artisan actor has no workshopId without querying repository', async () => {
      await expect(
        useCase.execute({
          actor: artisanWithoutWorkshopActor,
          id: '501',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(mockAllocationRepo.findDetailById).not.toHaveBeenCalled();
    });

    it('throws TEMP_PASSWORD_RESTRICTED for temp_password session without querying repository (SEC-05)', async () => {
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
    });

    it('throws PERMISSION_DENIED for unknown role without querying repository', async () => {
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
      'throws InvalidTradingInputError (INVALID_INPUT) for malformed :id %j without querying repository',
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

    it('reuses caller-supplied TransactionContext without opening a nested transaction', async () => {
      const runSpy = vi.spyOn(txRunner, 'run');
      const externalTx = { txId: 'ext-tx-1' } as unknown as TransactionContext;
      const record = createSampleAllocationDetailRecord();
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);

      const result = await useCase.execute({
        actor: owningArtisanActor,
        id: '501',
        tx: externalTx,
      });

      expect(result.id).toBe('501');
      expect(mockAllocationRepo.findDetailById).toHaveBeenCalledWith(
        '501',
        externalTx,
      );
      expect(runSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Suite B: Controller Metadata, Zod Schema & Swagger OpenAPI Document
  // =========================================================================
  describe('Suite B: Controller Metadata, Zod Schema & Swagger OpenAPI Document', () => {
    it('serves OpenAPI documentation including GET /api/v1/allocations/{id} with unlocked contact fields', () => {
      const doc = createApiDocument(app, { NODE_ENV: 'development' });
      const endpoint = doc.paths?.['/api/v1/allocations/{id}'];
      expect(endpoint).toBeDefined();
      expect(endpoint?.get).toBeDefined();
      expect(endpoint?.get?.tags).toContain('trading');
      expect(endpoint?.get?.summary).toContain('chi tiết phần việc');

      const idParam = endpoint?.get?.parameters?.find(
        (p) => 'name' in p && p.name === 'id' && p.in === 'path',
      );
      expect(idParam).toBeDefined();

      const okResponse = endpoint?.get?.responses?.['200'];
      expect(okResponse && 'content' in okResponse).toBe(true);
      const responseSchema =
        okResponse && 'content' in okResponse
          ? okResponse.content?.['application/json']?.schema
          : undefined;
      expect(responseSchema && 'properties' in responseSchema).toBe(true);

      const dataSchema =
        responseSchema && 'properties' in responseSchema
          ? responseSchema.properties?.data
          : undefined;
      expect(dataSchema && 'properties' in dataSchema).toBe(true);
      if (dataSchema && 'properties' in dataSchema && dataSchema.properties) {
        expect(dataSchema.properties.recipient_name).toBeDefined();
        expect(dataSchema.properties.recipient_phone).toBeDefined();
        expect(dataSchema.properties.delivery_address).toBeDefined();
        expect(dataSchema.properties.buyer_id).toBeUndefined();
      }
    });

    it('verifies AllocationController class, method decorators, and TradingModule registration', () => {
      expect(Reflect.getMetadata(PATH_METADATA, AllocationController)).toBe(
        'allocations',
      );

      const policy = Reflect.getMetadata(ACCESS_POLICY, AllocationController);
      expect(policy).toEqual({
        kind: 'roles',
        roles: ['buyer', 'artisan', 'admin'],
      });

      const sessionMeta = Reflect.getMetadata(
        SESSION_LEVELS,
        AllocationController,
      );
      expect(sessionMeta).toEqual(['normal']);

      const proto = AllocationController.prototype;
      const headers = Reflect.getMetadata(
        '__headers__',
        proto.getAllocationById,
      );
      expect(headers).toEqual(
        expect.arrayContaining([{ name: 'Cache-Control', value: 'no-store' }]),
      );

      const paramTypes = Reflect.getMetadata(
        'design:paramtypes',
        proto,
        'getAllocationById',
      );
      expect(paramTypes).toBeDefined();
      expect(paramTypes).toHaveLength(2);

      const moduleControllers = Reflect.getMetadata(
        'controllers',
        TradingModule,
      ) as unknown[];
      expect(moduleControllers).toContain(AllocationController);

      const moduleExports = Reflect.getMetadata(
        'exports',
        TradingModule,
      ) as unknown[];
      expect(moduleExports).toContain(GetAllocationByIdUseCase);
    });

    it('validates AllocationDetailDto strictly and rejects leaked fields such as buyer_id', () => {
      const validPayload = {
        ...createSampleAllocationDto(),
        recipient_name: 'Nguyễn Văn An',
        recipient_phone: '0912345678',
        delivery_address: 'Số 45 Phố Hàng Đào, Hoàn Kiếm, Hà Nội',
      };

      expect(() =>
        allocationDetailDtoResponseSchema.parse(validPayload),
      ).not.toThrow();

      expect(() =>
        allocationDetailDtoResponseSchema.parse({
          ...validPayload,
          buyer_id: '10',
        }),
      ).toThrow();
    });
  });

  // =========================================================================
  // Suite C: HTTP Controller Integration Tests
  // =========================================================================
  describe('Suite C: HTTP Controller Integration Tests', () => {
    it('returns HTTP 200 with Cache-Control: no-store and unlocked Buyer contact for owning Artisan', async () => {
      const record = createSampleAllocationDetailRecord();
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(record);

      const res = await fetch(`${base}/allocations/501`, {
        headers: { Cookie: 'vcraft-session=session-artisan-201' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toEqual(
        allocationDetailDtoResponseSchema.parse(json.data),
      );
      expect(json.data.id).toBe('501');
      expect(json.data.workshop).toEqual({
        id: '201',
        name: 'Xưởng Gốm Bát Tràng Hưng Thịnh',
      });
      expect(json.data.recipient_name).toBe('Nguyễn Văn An');
      expect(json.data.recipient_phone).toBe('0912345678');
      expect(json.data.delivery_address).toBe(
        'Số 45 Phố Hàng Đào, Hoàn Kiếm, Hà Nội',
      );
      expect(json.data.buyer_id).toBeUndefined();
      expect(json.data.requestBuyerId).toBeUndefined();
    });

    it('returns HTTP 200 with Cache-Control: no-store for owning Buyer', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        createSampleAllocationDetailRecord(),
      );

      const res = await fetch(`${base}/allocations/501`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.recipient_name).toBe('Nguyễn Văn An');
      expect(json.data.delivery_address).toBe(
        'Số 45 Phố Hàng Đào, Hoàn Kiếm, Hà Nội',
      );
    });

    it('returns HTTP 200 with Cache-Control: no-store for Admin including admin handover metadata', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        createSampleAllocationDetailRecord({
          requestBuyerId: '999',
          allocation: {
            workshop: { id: '299', name: 'Xưởng Gốm 299' },
            status: 'handed_over',
            version: 5,
            admin_handed_over: true,
            admin_handover_reason: 'Bàn giao ngoài giờ có xác nhận',
            admin_delivery_evidence: 'Biên bản BB-09/2026',
            admin_handover_actual_at: '2026-11-20T14:00:00.000Z',
            handed_over_at: '2026-11-20T15:00:00.000Z',
            handed_over_by: { id: '1', display_name: 'Admin' },
          },
        }),
      );

      const res = await fetch(`${base}/allocations/501`, {
        headers: { Cookie: 'vcraft-session=session-admin-1' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.admin_handed_over).toBe(true);
      expect(json.data.admin_handover_reason).toBe(
        'Bàn giao ngoài giờ có xác nhận',
      );
    });

    it('returns HTTP 404 RESOURCE_NOT_FOUND without contact leakage for non-owner Artisan', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        createSampleAllocationDetailRecord(),
      );

      const res = await fetch(`${base}/allocations/501`, {
        headers: { Cookie: 'vcraft-session=session-artisan-202' },
      });

      expect(res.status).toBe(404);
      const rawText = await res.text();
      expect(rawText).not.toContain('Nguyễn Văn An');
      expect(rawText).not.toContain('0912345678');
      expect(rawText).not.toContain('Hàng Đào');
      const json = JSON.parse(rawText);
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns HTTP 404 RESOURCE_NOT_FOUND without contact leakage for non-owner Buyer', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(
        createSampleAllocationDetailRecord(),
      );

      const res = await fetch(`${base}/allocations/501`, {
        headers: { Cookie: 'vcraft-session=session-buyer-other' },
      });

      expect(res.status).toBe(404);
      const rawText = await res.text();
      expect(rawText).not.toContain('0912345678');
      const json = JSON.parse(rawText);
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns HTTP 404 RESOURCE_NOT_FOUND when allocation ID does not exist', async () => {
      mockAllocationRepo.findDetailById.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/allocations/99999`, {
        headers: { Cookie: 'vcraft-session=session-artisan-201' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns HTTP 403 PERMISSION_DENIED when Artisan has no workshopId', async () => {
      const res = await fetch(`${base}/allocations/501`, {
        headers: { Cookie: 'vcraft-session=session-artisan-no-ws' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('returns HTTP 403 TEMP_PASSWORD_RESTRICTED for temp_password session', async () => {
      const res = await fetch(`${base}/allocations/501`, {
        headers: { Cookie: 'vcraft-session=session-temp-artisan' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
    });

    it('returns HTTP 401 AUTHENTICATION_REQUIRED when unauthenticated', async () => {
      const res = await fetch(`${base}/allocations/501`);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it.each(['abc', '0', '9223372036854775808'])(
      'returns HTTP 400 INVALID_INPUT for invalid :id "%s"',
      async (badId) => {
        const res = await fetch(`${base}/allocations/${badId}`, {
          headers: { Cookie: 'vcraft-session=session-artisan-201' },
        });

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.code).toBe('INVALID_INPUT');
      },
    );
  });

  // =========================================================================
  // Suite D: Persistence Unit Tests (PrismaAllocationRepository.findDetailById)
  // =========================================================================
  describe('Suite D: PrismaAllocationRepository.findDetailById Persistence Unit Tests', () => {
    const NOW = new Date('2026-11-15T10:00:00.000Z');
    const DELIVERY_DATE = new Date('2026-12-01T10:00:00.000Z');

    it('queries with tight projection on request/workshop/actors/batches and derives NO_BATCH_LINK', async () => {
      const mockClient = {
        allocation: {
          findUnique: vi.fn().mockResolvedValue({
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
            workshop: { id: 201n, name: 'Xưởng Gốm Bát Tràng' },
            startedBy: null,
            handedOverBy: null,
            allocationBatches: [],
            request: {
              id: 100n,
              buyer_id: 10n,
              recipient_name: 'Nguyễn Văn An',
              recipient_phone: '0912345678',
              delivery_address: 'Số 45 Phố Hàng Đào, Hoàn Kiếm, Hà Nội',
            },
          }),
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

      const res = await prismaTxRunner.run((tx) => repo.findDetailById('501', tx));

      expect(mockClient.allocation.findUnique).toHaveBeenCalledWith({
        where: { id: 501n },
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
          request: {
            select: {
              id: true,
              buyer_id: true,
              recipient_name: true,
              recipient_phone: true,
              delivery_address: true,
            },
          },
        },
      });

      expect(res).not.toBeNull();
      expect(res?.requestBuyerId).toBe('10');
      expect(res?.recipientName).toBe('Nguyễn Văn An');
      expect(res?.recipientPhone).toBe('0912345678');
      expect(res?.deliveryAddress).toBe(
        'Số 45 Phố Hàng Đào, Hoàn Kiếm, Hà Nội',
      );
      expect(res?.allocation.id).toBe('501');
      expect(res?.allocation.traceability_warning).toBe('NO_BATCH_LINK');
    });

    it('returns null when allocation record does not exist', async () => {
      const mockClient = {
        allocation: {
          findUnique: vi.fn().mockResolvedValue(null),
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

      const res = await repo.findDetailById('99999');
      expect(res).toBeNull();
    });

    it('derives null traceability_warning when all linked batches are published and cover allocation quantity', async () => {
      const mockClient = {
        allocation: {
          findUnique: vi.fn().mockResolvedValue({
            id: 502n,
            request_id: 100n,
            workshop_id: 201n,
            quote_id: 402n,
            quantity: 100,
            unit_price: new Prisma.Decimal('450000'),
            committed_delivery_at: DELIVERY_DATE,
            status: 'handed_over',
            version: 3,
            started_at: NOW,
            started_by: 21n,
            handed_over_at: NOW,
            handed_over_by: 21n,
            delivery_note: 'Đủ hàng',
            admin_handed_over: false,
            admin_delivery_evidence: null,
            admin_handover_reason: null,
            admin_handover_actual_at: null,
            created_at: NOW,
            updated_at: NOW,
            workshop: { id: 201n, name: 'Xưởng Gốm Bát Tràng' },
            startedBy: { id: 21n, display_name: 'Nghệ nhân Hưng Thịnh' },
            handedOverBy: { id: 21n, display_name: 'Nghệ nhân Hưng Thịnh' },
            allocationBatches: [
              {
                id: 10n,
                workshop_id: 201n,
                allocation_id: 502n,
                batch_id: 1001n,
                linked_quantity: 100,
                linked_at: NOW,
                linked_by: 21n,
                batch: { id: 1001n, status: 'published' },
              },
            ],
            request: {
              id: 100n,
              buyer_id: 10n,
              recipient_name: 'Trần Thị Bình',
              recipient_phone: '0987654321',
              delivery_address: 'Bát Tràng, Gia Lâm, Hà Nội',
            },
          }),
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

      const res = await repo.findDetailById('502');
      expect(res?.allocation.traceability_warning).toBeNull();
      expect(res?.allocation.started_by).toEqual({
        id: '21',
        display_name: 'Nghệ nhân Hưng Thịnh',
      });
      expect(res?.allocation.handed_over_by).toEqual({
        id: '21',
        display_name: 'Nghệ nhân Hưng Thịnh',
      });
      expect(res?.recipientName).toBe('Trần Thị Bình');
    });

    it('derives INCOMPLETE_TRACEABILITY when linked batch is draft or total linked quantity is below quantity', async () => {
      const mockClient = {
        allocation: {
          findUnique: vi.fn().mockResolvedValue({
            id: 503n,
            request_id: 100n,
            workshop_id: 201n,
            quote_id: 403n,
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
            workshop: { id: 201n, name: 'Xưởng Gốm Bát Tràng' },
            startedBy: { id: 21n, display_name: 'Nghệ nhân' },
            handedOverBy: null,
            allocationBatches: [
              {
                id: 11n,
                workshop_id: 201n,
                allocation_id: 503n,
                batch_id: 1002n,
                linked_quantity: 40,
                linked_at: NOW,
                linked_by: 21n,
                batch: { id: 1002n, status: 'draft' },
              },
            ],
            request: {
              id: 100n,
              buyer_id: 10n,
              recipient_name: null,
              recipient_phone: null,
              delivery_address: null,
            },
          }),
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

      const res = await repo.findDetailById('503');
      expect(res?.allocation.traceability_warning).toBe(
        'INCOMPLETE_TRACEABILITY',
      );
      expect(res?.recipientName).toBeNull();
    });
  });
});
