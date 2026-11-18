import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../../../src/generated/prisma/client';
import { AppModule } from '../../../../src/bootstrap/app.module';
import { configureHttp } from '../../../../src/bootstrap/configure-http';
import { AppConfigModule } from '../../../../src/common/config/app-config';
import { createApiDocument } from '../../../../src/common/http/swagger/configure-swagger';
import { AppLogger } from '../../../../src/common/observability/app-logger';
import { SecurityModule } from '../../../../src/common/security/security.module';
import {
  TRANSACTION_RUNNER,
  type TransactionContext,
} from '../../../../src/common/application/ports/transaction-runner';
import type { AuthenticatedActor } from '../../../../src/common/application/types/contract-types';
import { PrismaService } from '../../../../src/infrastructure/database/prisma/prisma.service';
import { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import { IDENTITY_CONTRACT } from '../../../../src/modules/identity/public/contracts/identity.contract';
import {
  Allocation,
  ConcurrencyConflictError,
  EntityId,
  InvalidTradingInputError,
  QuoteRequest,
  TradingDomainError,
  UnitPrice,
} from '../../../../src/modules/trading/domain';
import {
  PrismaQuoteRequestRepository,
  RecipientResponseHistoryMapper,
} from '../../../../src/modules/trading/adapters/persistence';
import { QUOTE_REQUEST_REPOSITORY } from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { CreateDraftQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/create-draft-quote-request.use-case';
import { UpdateDraftQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/update-draft-quote-request.use-case';
import { DeleteDraftQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/delete-draft-quote-request.use-case';
import { CopyQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/copy-quote-request.use-case';
import { UpdateRecipientContactUseCase } from '../../../../src/modules/trading/application/use-cases/requests/update-recipient-contact.use-case';
import { CloseBiddingUseCase } from '../../../../src/modules/trading/application/use-cases/requests/close-bidding.use-case';
import { GetQuoteRequestByIdUseCase } from '../../../../src/modules/trading/application/use-cases/requests/get-quote-request-by-id.use-case';
import { BuyerQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/buyer-quote-request.controller';
import { createDraftQuoteRequestSchema } from '../../../../src/modules/trading/adapters/http/dtos/create-draft-quote-request.dto';
import { updateDraftQuoteRequestSchema } from '../../../../src/modules/trading/adapters/http/dtos/update-draft-quote-request.dto';
import { deleteDraftQuoteRequestSchema } from '../../../../src/modules/trading/adapters/http/dtos/delete-draft-quote-request.dto';
import { closeBiddingSchema } from '../../../../src/modules/trading/adapters/http/dtos/close-bidding.dto';
import { sendQuoteRequestSchema } from '../../../../src/modules/trading/adapters/http/dtos/send-quote-request.dto';
import { updateRecipientContactSchema } from '../../../../src/modules/trading/adapters/http/dtos/update-recipient-contact.dto';
import { listAdminQuoteRequestsSchema } from '../../../../src/modules/trading/adapters/http/dtos/list-admin-quote-requests.dto';
import { SendRequestWorkflow } from '../../../../src/workflows/send-request/send-request.workflow';
import { MockCatalogContract } from '../../../support/mocks/catalog.mock';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import { MockWorkshopContract } from '../../../support/mocks/workshop.mock';

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const NOW = new Date('2026-11-18T08:00:00.000Z');
const BIDDING_DEADLINE = new Date('2026-11-22T08:00:00.000Z');
const DELIVERY_DEADLINE = new Date('2026-11-30T08:00:00.000Z');

const buyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-buyer-normal',
  sessionLevel: 'normal',
});

const tempPasswordBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'sess-buyer-temp',
  sessionLevel: 'temp_password',
});

describe('Tasks 1–24 Audit, Compliance Fixes & Code Optimizations', () => {
  describe('1. Domain Core Fixes & Hot-Path Optimizations', () => {
    it('UnitPrice.of strictly rejects non-decimal strings (hex, scientific notation, whitespace, decimals) and out-of-range BigInts', () => {
      for (const bad of [
        '0x10',
        '0b101',
        '0o17',
        '1e3',
        '1E5',
        ' 1000 ',
        '1000.0',
        '+1000',
        '0',
        '-500',
        '0100',
        '1000000000000000',
      ]) {
        expect(() => UnitPrice.of(bad)).toThrow(InvalidTradingInputError);
      }

      expect(() => UnitPrice.of(0n)).toThrow(InvalidTradingInputError);
      expect(() => UnitPrice.of(-10n)).toThrow(InvalidTradingInputError);
      expect(() => UnitPrice.of(10n ** 25n)).toThrow(InvalidTradingInputError);

      expect(UnitPrice.of('150000').value).toBe(150000);
      expect(UnitPrice.of(150000n).value).toBe(150000);
      expect(UnitPrice.of(999_999_999_999_999n).value).toBe(999_999_999_999_999);
    });

    it('EntityId.sortAscending sorts 64-bit numeric IDs in O(N) BigInt conversions without mutating input', () => {
      expect(EntityId.sortAscending([])).toEqual([]);

      const input = Object.freeze([
        '9223372036854775807',
        '100',
        EntityId.of('2'),
        '19',
        '1',
      ]);
      expect(EntityId.sortAscending(input)).toEqual([
        '1',
        '2',
        '19',
        '100',
        '9223372036854775807',
      ]);

      expect(() => EntityId.sortAscending(['10', 'bad-id'])).toThrow(
        InvalidTradingInputError,
      );
    });

    it('QuoteRequest.cancel requires non-empty goods_handling_note when Admin cancels in_production (even when undefined)', () => {
      const { request: draft } = QuoteRequest.createDraft({
        id: '100',
        buyer_id: '10',
        now: NOW,
        draft: {
          category_id: '5',
          spec: 'Bộ trà Bát Tràng',
          quantity: 50,
          unit: 'set',
          unit_set_description: '1 ấm + 6 chén',
          delivery_mode: 'at_buyer_address',
          delivery_region: 'Hà Nội',
          delivery_address: '10 Hàng Gai, Hoàn Kiếm',
          recipient_name: 'Nguyễn Văn A',
          recipient_phone: '0912345678',
          bidding_deadline: BIDDING_DEADLINE,
          delivery_deadline: DELIVERY_DEADLINE,
        },
      });
      const { request: sent } = draft.sendToArtisans({
        buyerId: '10',
        expectedVersion: 1,
        eligibleWorkshopIds: ['201'],
        now: NOW,
      });
      const { request: bidding } = sent.recordFirstQuoteReceived({
        actorId: '21',
        now: NOW,
      });
      const { request: accepted } = bidding.markBuyerAccepted({
        buyerId: '10',
        expectedVersion: 3,
        now: NOW,
      });
      const { allocation } = Allocation.createFromAcceptedQuote({
        id: '701',
        request_id: accepted.id,
        workshop_id: '201',
        quote_id: '401',
        quantity: 50,
        unit_price: 200_000,
        committed_delivery_at: DELIVERY_DEADLINE,
        actorId: '10',
        now: NOW,
      });
      const { updatedRequest: inProd } = allocation.startProduction({
        request: accepted,
        actorId: '21',
        actorWorkshopId: '201',
        expectedVersion: 1,
        now: NOW,
      });
      expect(inProd.status).toBe('in_production');

      // Omitted goodsHandlingNote (undefined) MUST fail per BR-19 / UC-23
      expect(() =>
        inProd.cancel({
          actorId: '1',
          actorRole: 'admin',
          expectedVersion: inProd.version,
          cancelReason: 'Khách và xưởng thống nhất dừng sản xuất',
          now: NOW,
        }),
      ).toThrow(InvalidTradingInputError);

      // Whitespace-only goodsHandlingNote MUST fail
      expect(() =>
        inProd.cancel({
          actorId: '1',
          actorRole: 'admin',
          expectedVersion: inProd.version,
          cancelReason: 'Khách và xưởng thống nhất dừng sản xuất',
          goodsHandlingNote: '   ',
          now: NOW,
        }),
      ).toThrow(InvalidTradingInputError);

      // Valid non-empty goodsHandlingNote succeeds and persists into StatusLog.evidence
      const { request: cancelled, statusLogs } = inProd.cancel({
        actorId: '1',
        actorRole: 'admin',
        expectedVersion: inProd.version,
        cancelReason: 'Khách và xưởng thống nhất dừng sản xuất',
        goodsHandlingNote: 'Xưởng giữ bán thành phẩm tại kho Bát Tràng',
        now: NOW,
      });
      expect(cancelled.isCancelled()).toBe(true);
      expect(statusLogs[0].evidence).toBe(
        'Xưởng giữ bán thành phẩm tại kho Bát Tràng',
      );
    });
  });

  describe('2. Application & Workflow Security, Concurrency & Layer Purity', () => {
    it('enforces SEC-05 temp_password restriction before opening transactions across all Buyer write use cases & SendRequestWorkflow', async () => {
      const txRunner = new MockTransactionRunner();
      const repo = {
        createDraft: vi.fn(),
        findById: vi.fn(),
        lockById: vi.fn(),
        update: vi.fn(),
        deleteDraft: vi.fn(),
      } as any;
      const recipientRepo = { createMany: vi.fn() } as any;

      await expect(
        new CreateDraftQuoteRequestUseCase(txRunner, repo).execute({
          actor: tempPasswordBuyerActor,
          draft: { spec: 'test' },
        }),
      ).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });

      await expect(
        new UpdateDraftQuoteRequestUseCase(txRunner, repo).execute({
          actor: tempPasswordBuyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          draft: { spec: 'test' },
        }),
      ).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });

      await expect(
        new DeleteDraftQuoteRequestUseCase(txRunner, repo).execute({
          actor: tempPasswordBuyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });

      await expect(
        new CopyQuoteRequestUseCase(txRunner, repo).execute({
          actor: tempPasswordBuyerActor,
          requestId: '100',
        }),
      ).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });

      await expect(
        new UpdateRecipientContactUseCase(txRunner, repo).execute({
          actor: tempPasswordBuyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          recipientName: 'New Name',
        }),
      ).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });

      await expect(
        new CloseBiddingUseCase(txRunner, repo).execute({
          actor: tempPasswordBuyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });

      await expect(
        new SendRequestWorkflow(txRunner, repo, recipientRepo).execute({
          actor: tempPasswordBuyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });

      expect(txRunner.contexts).toHaveLength(0);
    });

    it('SendRequestWorkflow detects mid-flight category_id modification between findById and lockById and aborts with ConcurrencyConflictError', async () => {
      const txRunner = new MockTransactionRunner();
      const { request: draftCat1 } = QuoteRequest.createDraft({
        id: '100',
        buyer_id: '10',
        now: NOW,
        draft: {
          category_id: '1',
          spec: 'Ấm trà gốm',
          quantity: 20,
          unit: 'piece',
          delivery_mode: 'at_workshop',
          recipient_name: 'Buyer',
          recipient_phone: '0901234567',
          bidding_deadline: BIDDING_DEADLINE,
          delivery_deadline: DELIVERY_DEADLINE,
        },
      });
      const draftCat2 = draftCat1.updateDraft({
        buyerId: '10',
        expectedVersion: 1,
        draft: { category_id: '2' },
        now: NOW,
      });

      const quoteRequestRepo = {
        findById: vi.fn().mockResolvedValue(draftCat1),
        lockById: vi.fn().mockResolvedValue(draftCat2),
        update: vi.fn(),
      };
      const recipientRepo = { createMany: vi.fn() };
      const catalog = new MockCatalogContract().givenEligibleWorkshops('1', '201');
      const workshop = new MockWorkshopContract().givenActiveWorkshops('201');

      const workflow = new SendRequestWorkflow(
        txRunner,
        quoteRequestRepo as any,
        recipientRepo as any,
        catalog,
        workshop,
      );

      await expect(
        workflow.execute({
          actor: buyerActor,
          requestId: '100',
          expectedRequestVersion: 1,
          now: NOW,
        }),
      ).rejects.toThrow(ConcurrencyConflictError);

      expect(catalog.assertEligibleWorkshops).not.toHaveBeenCalled();
      expect(quoteRequestRepo.update).not.toHaveBeenCalled();
      expect(recipientRepo.createMany).not.toHaveBeenCalled();
    });

    it('GetQuoteRequestByIdUseCase reuses caller TransactionContext without opening a nested transaction when tx is passed', async () => {
      const runSpy = vi.fn();
      const txRunner = { run: runSpy } as any;
      const callerTx = Object.freeze({ activeTx: true }) as unknown as TransactionContext;
      const { request } = QuoteRequest.createDraft({
        id: '100',
        buyer_id: '10',
        now: NOW,
        draft: { category_id: '5', spec: 'Trà cụ' },
      });
      const findDetailById = vi.fn().mockResolvedValue({
        entity: request,
        category: { id: '5', name: 'Gốm sứ Bát Tràng' },
        recipients: [],
        quotes: [],
        allocations: [],
        statusLogs: [],
      });

      const useCase = new GetQuoteRequestByIdUseCase(txRunner, {
        findDetailById,
      } as any);

      const dto = await useCase.execute({
        actor: buyerActor,
        id: '100',
        tx: callerTx,
      });

      expect(runSpy).not.toHaveBeenCalled();
      expect(findDetailById).toHaveBeenCalledWith('100', callerTx);
      expect(dto.category).toEqual({ id: '5', name: 'Gốm sứ Bát Tràng' });
    });

    it('trading/application files do not import HTTP security guard modules', () => {
      const appDir = join(
        __dirname,
        '../../../../src/modules/trading/application',
      );
      for (const file of collectTsFiles(appDir)) {
        const content = readFileSync(file, 'utf8');
        expect(content).not.toMatch(/common\/security\/guards\//);
      }
    });
  });

  describe('3. Persistence Fixes (sort_by=updated_at, MAX_BIGINT_ID Search & Prisma.DbNull)', () => {
    it('PrismaQuoteRequestRepository.findBuyerQuoteRequests honors sortBy="updated_at" and guards >64-bit numeric search strings', async () => {
      const mockClient = {
        quoteRequest: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      const txRunner = new PrismaTransactionRunner({
        $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn(mockClient),
        ),
      } as unknown as PrismaService);
      const repo = new PrismaQuoteRequestRepository(txRunner);

      // 1. sortBy: 'updated_at' + huge 25-digit numeric search (> MAX_BIGINT_ID)
      const hugeSearch = '9999999999999999999999999';
      await txRunner.run((tx) =>
        repo.findBuyerQuoteRequests(
          {
            buyerId: '10',
            page: 1,
            limit: 20,
            sortBy: 'updated_at',
            order: 'asc',
            search: hugeSearch,
            now: NOW,
          },
          tx,
        ),
      );

      expect(mockClient.quoteRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ updated_at: 'asc' }, { id: 'desc' }],
          where: {
            AND: [
              { buyer_id: 10n },
              {
                OR: [
                  { spec: { contains: hugeSearch, mode: 'insensitive' } },
                  {
                    category: {
                      is: { name: { contains: hugeSearch, mode: 'insensitive' } },
                    },
                  },
                ],
              },
            ],
          },
        }),
      );

      // 2. Exact MAX_BIGINT_ID search includes { id: 9223372036854775807n }
      await txRunner.run((tx) =>
        repo.findBuyerQuoteRequests(
          {
            buyerId: '10',
            page: 1,
            limit: 20,
            search: '9223372036854775807',
            now: NOW,
          },
          tx,
        ),
      );

      expect(mockClient.quoteRequest.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              { buyer_id: 10n },
              {
                OR: [
                  {
                    spec: {
                      contains: '9223372036854775807',
                      mode: 'insensitive',
                    },
                  },
                  {
                    category: {
                      is: {
                        name: {
                          contains: '9223372036854775807',
                          mode: 'insensitive',
                        },
                      },
                    },
                  },
                  { id: 9223372036854775807n },
                ],
              },
            ],
          },
        }),
      );
    });

    it('RecipientResponseHistoryMapper.toQuoteSnapshotJson returns Prisma.DbNull when snapshot is null or undefined', () => {
      expect(RecipientResponseHistoryMapper.toQuoteSnapshotJson(null)).toBe(
        Prisma.DbNull,
      );
      expect(
        RecipientResponseHistoryMapper.toQuoteSnapshotJson(undefined),
      ).toBe(Prisma.DbNull);
    });
  });

  describe('4. DTO Bounds, Controller Category Resolution, Cache-Control & Full OpenAPI Document', () => {
    it('enforces max string length, INT4 max (2_147_483_647), and 64-bit BIGINT max across Trading DTO schemas', () => {
      const over64BitId = '9223372036854775808';
      const overInt32 = 2_147_483_648;

      expect(
        createDraftQuoteRequestSchema.safeParse({ category_id: over64BitId })
          .success,
      ).toBe(false);
      expect(
        createDraftQuoteRequestSchema.safeParse({ spec: 'x'.repeat(10_001) })
          .success,
      ).toBe(false);
      expect(
        createDraftQuoteRequestSchema.safeParse({
          recipient_name: 'x'.repeat(201),
        }).success,
      ).toBe(false);
      expect(
        createDraftQuoteRequestSchema.safeParse({
          recipient_phone: '1'.repeat(21),
        }).success,
      ).toBe(false);
      expect(
        createDraftQuoteRequestSchema.safeParse({
          delivery_region: 'x'.repeat(201),
        }).success,
      ).toBe(false);
      expect(
        createDraftQuoteRequestSchema.safeParse({ quantity: overInt32 }).success,
      ).toBe(false);

      expect(
        updateDraftQuoteRequestSchema.safeParse({
          expected_request_version: overInt32,
        }).success,
      ).toBe(false);
      expect(
        deleteDraftQuoteRequestSchema.safeParse({
          expected_request_version: overInt32,
        }).success,
      ).toBe(false);
      expect(
        closeBiddingSchema.safeParse({ expected_request_version: overInt32 })
          .success,
      ).toBe(false);
      expect(
        sendQuoteRequestSchema.safeParse({ expected_request_version: overInt32 })
          .success,
      ).toBe(false);
      expect(
        updateRecipientContactSchema.safeParse({
          expected_request_version: overInt32,
          recipient_name: 'Valid',
        }).success,
      ).toBe(false);
      expect(
        listAdminQuoteRequestsSchema.safeParse({ buyer_id: over64BitId })
          .success,
      ).toBe(false);
      expect(
        listAdminQuoteRequestsSchema.safeParse({ category_id: over64BitId })
          .success,
      ).toBe(false);
    });

    it('BuyerQuoteRequestController resolves real category.name via GetQuoteRequestByIdUseCase and sets Cache-Control: no-store', async () => {
      vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/test');
      vi.stubEnv(
        'SESSION_SECRET',
        'test_secret_32_chars_for_development_purposes',
      );
      vi.stubEnv('NODE_ENV', 'development');

      const identityMock = new MockIdentityContract();
      const txRunner = new MockTransactionRunner();
      let savedEntity: QuoteRequest | null = null;

      const mockRepo = {
        createDraft: vi.fn().mockImplementation(async ({ request }) => {
          savedEntity = QuoteRequest.reconstitute({
            ...request,
            id: '555',
          });
          return savedEntity;
        }),
        findDetailById: vi.fn().mockImplementation(async (id: string) => {
          if (!savedEntity || savedEntity.id !== id) return null;
          return {
            entity: savedEntity,
            category: { id: '5', name: 'Gốm sứ Bát Tràng' },
            recipients: [],
            quotes: [],
            allocations: [],
            statusLogs: [],
          };
        }),
      };

      class LocalIdentityModule {}
      Module({
        providers: [{ provide: IDENTITY_CONTRACT, useValue: identityMock }],
        exports: [IDENTITY_CONTRACT],
      })(LocalIdentityModule);

      class LocalTradingModule {}
      Module({
        imports: [
          AppConfigModule,
          SecurityModule.register([LocalIdentityModule]),
        ],
        controllers: [BuyerQuoteRequestController],
        providers: [
          { provide: TRANSACTION_RUNNER, useValue: txRunner },
          { provide: QUOTE_REQUEST_REPOSITORY, useValue: mockRepo },
          {
            provide: CreateDraftQuoteRequestUseCase,
            useFactory: (tr: any, r: any) =>
              new CreateDraftQuoteRequestUseCase(tr, r),
            inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
          },
          {
            provide: GetQuoteRequestByIdUseCase,
            useFactory: (tr: any, r: any) =>
              new GetQuoteRequestByIdUseCase(tr, r),
            inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
          },
        ],
      })(LocalTradingModule);

      const app = await NestFactory.create<NestExpressApplication>(
        LocalTradingModule,
        {
          bodyParser: false,
          logger: false,
          abortOnError: false,
        },
      );
      try {
        configureHttp(app, new AppLogger('error', (_line, done) => done()));
        await app.listen(0, '127.0.0.1');
        const base = (await app.getUrl()) + '/api/v1';

        identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
        const res = await fetch(`${base}/buyer/quote-requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=valid-buyer-token',
          },
          body: JSON.stringify({
            category_id: '5',
            spec: 'Bộ ấm trà men lam',
          }),
        });

        expect(res.status).toBe(201);
        expect(res.headers.get('cache-control')).toContain('no-store');
        const json = (await res.json()) as any;
        expect(json.success).toBe(true);
        expect(json.data.id).toBe('555');
        expect(json.data.category).toEqual({
          id: '5',
          name: 'Gốm sứ Bát Tràng',
        });
      } finally {
        await app.close();
        vi.unstubAllEnvs();
      }
    });

    it('generates full OpenAPI 3.0 document for AppModule including all 19 Trading endpoints (Tasks 4–24) without schema errors', async () => {
      vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/test');
      vi.stubEnv(
        'SESSION_SECRET',
        'test_secret_32_chars_for_development_purposes',
      );
      vi.stubEnv('NODE_ENV', 'development');

      const connectSpy = vi
        .spyOn(PrismaService.prototype, '$connect')
        .mockResolvedValue(undefined);
      const disconnectSpy = vi
        .spyOn(PrismaService.prototype, '$disconnect')
        .mockResolvedValue(undefined);

      let app: NestExpressApplication | undefined;
      try {
        app = await NestFactory.create<NestExpressApplication>(AppModule, {
          bodyParser: false,
          logger: false,
          abortOnError: false,
        });
        configureHttp(app, new AppLogger('error', (_line, done) => done()));

        const doc = createApiDocument(app, { NODE_ENV: 'development' });
        expect(doc).toBeDefined();

        const expectedEndpoints: Array<[string, string]> = [
          ['/api/v1/buyer/quote-requests', 'post'],
          ['/api/v1/buyer/quote-requests', 'get'],
          ['/api/v1/buyer/quote-requests/{id}', 'put'],
          ['/api/v1/buyer/quote-requests/{id}', 'delete'],
          ['/api/v1/buyer/quote-requests/{id}/copy', 'post'],
          ['/api/v1/buyer/quote-requests/{id}/contact', 'patch'],
          ['/api/v1/buyer/quote-requests/{id}/close-bidding', 'post'],
          ['/api/v1/buyer/quote-requests/{id}/send', 'post'],
          ['/api/v1/buyer/quote-requests/{id}/accept-quote', 'post'],
          ['/api/v1/artisan/quote-requests', 'get'],
          ['/api/v1/artisan/quote-requests/{id}/decline', 'post'],
          ['/api/v1/artisan/quote-requests/{id}/quote', 'post'],
          ['/api/v1/artisan/quote-requests/{id}/quote/withdraw', 'post'],
          ['/api/v1/admin/quote-requests', 'get'],
          ['/api/v1/quote-requests/{id}', 'get'],
          ['/api/v1/quote-requests/{id}/recipients', 'get'],
          ['/api/v1/quote-requests/{id}/contact-history', 'get'],
          ['/api/v1/quote-requests/{id}/history', 'get'],
          ['/api/v1/quote-requests/{id}/quotes', 'get'],
          ['/api/v1/quote-requests/{id}/recipients/{recipientId}/history', 'get'],
        ];

        for (const [path, method] of expectedEndpoints) {
          expect(
            doc.paths[path]?.[method as keyof (typeof doc.paths)[string]],
            `Missing OpenAPI operation ${method.toUpperCase()} ${path}`,
          ).toBeDefined();
        }
      } finally {
        await app?.close();
        connectSpy.mockRestore();
        disconnectSpy.mockRestore();
        vi.unstubAllEnvs();
      }
    });
  });
});
