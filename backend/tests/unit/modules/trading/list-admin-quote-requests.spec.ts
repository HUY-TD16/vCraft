import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { configureHttp } from '../../../../src/bootstrap/configure-http';
import { AppLogger } from '../../../../src/common/observability/app-logger';
import { AppConfigModule } from '../../../../src/common/config/app-config';
import { SecurityModule } from '../../../../src/common/security/security.module';
import { IDENTITY_CONTRACT } from '../../../../src/modules/identity/public/contracts/identity.contract';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import { TRANSACTION_RUNNER } from '../../../../src/common/application/ports/transaction-runner';
import { QUOTE_REQUEST_REPOSITORY } from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { ListAdminQuoteRequestsUseCase } from '../../../../src/modules/trading/application/use-cases/requests/list-admin-quote-requests.use-case';
import { AdminQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/admin-quote-request.controller';
import {
  InvalidTradingInputError,
  QuoteRequest,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import { QuoteRequestMapper } from '../../../../src/modules/trading/adapters/persistence/mappers/quote-request.mapper';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import type { BuyerRequestSummaryDto } from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';

const adminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-admin-1',
  sessionLevel: 'normal',
});

const buyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-1',
  sessionLevel: 'normal',
});

const artisanActor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '200',
  authVersion: 1,
  sessionId: 'session-artisan-1',
  sessionLevel: 'normal',
});

const tempPasswordAdminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-temp-admin',
  sessionLevel: 'temp_password',
});

function createSampleSummaryDto(
  overrides: Partial<BuyerRequestSummaryDto> = {},
): BuyerRequestSummaryDto {
  return Object.freeze({
    id: '10001',
    status: 'artisans_bidding',
    version: 1,
    category: { id: '3', name: 'Ấm chén Bát Tràng' },
    quantity: 100,
    unit: 'set',
    bidding_deadline: '2026-12-01T10:00:00.000Z',
    delivery_deadline: '2026-12-15T10:00:00.000Z',
    is_bidding_open: true,
    cancelled_at: null,
    split_requested_at: null,
    coordination_state: null,
    no_valid_quotes: false,
    nearest_accept_deadline: '2026-11-20T10:00:00.000Z',
    created_at: '2026-11-10T10:00:00.000Z',
    ...overrides,
  });
}

const identityMock = new MockIdentityContract();

// Memory repository mock backing both unit and http tests
const mockRepo = {
  findAdminQuoteRequests: vi.fn(),
};

class TestIdentityModule {}
Module({
  providers: [{ provide: IDENTITY_CONTRACT, useValue: identityMock }],
  exports: [IDENTITY_CONTRACT],
})(TestIdentityModule);

class TestTradingModule {}
Module({
  imports: [AppConfigModule, SecurityModule.register([TestIdentityModule])],
  controllers: [AdminQuoteRequestController],
  providers: [
    { provide: TRANSACTION_RUNNER, useClass: MockTransactionRunner },
    { provide: QUOTE_REQUEST_REPOSITORY, useValue: mockRepo },
    {
      provide: ListAdminQuoteRequestsUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new ListAdminQuoteRequestsUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
  ],
})(TestTradingModule);

describe('Milestone 1: List Admin Quote Requests (GET /api/v1/admin/quote-requests — UC-18, BR-02)', () => {
  describe('ListAdminQuoteRequestsUseCase (Application & Domain Isolation)', () => {
    it('TC-01: executes with default pagination (page=1, limit=20, created_at desc) and admin actor', async () => {
      const txRunner = new MockTransactionRunner();
      const items = [
        createSampleSummaryDto({ id: '1' }),
        createSampleSummaryDto({ id: '2' }),
      ];
      const singleRepo = {
        findAdminQuoteRequests: vi.fn().mockResolvedValue({ items, total: 2 }),
      };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const result = await useCase.execute({
        actor: adminActor,
        query: { page: 1, limit: 20 },
      });

      expect(singleRepo.findAdminQuoteRequests).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 1,
          limit: 20,
          sortBy: 'created_at',
          order: 'desc',
        }),
        expect.anything(),
      );
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 2,
        total_pages: 1,
      });
    });

    it('TC-02: executes with custom pagination parameters (page=3, limit=10)', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        findAdminQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items: [], total: 25 }),
      };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const result = await useCase.execute({
        actor: adminActor,
        query: { page: 3, limit: 10 },
      });

      expect(singleRepo.findAdminQuoteRequests).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 3,
          limit: 10,
        }),
        expect.anything(),
      );
      expect(result.total).toBe(25);
      expect(result.pagination.total_pages).toBe(3);
    });

    it('TC-03: handles empty results gracefully without errors', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        findAdminQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items: [], total: 0 }),
      };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const result = await useCase.execute({
        actor: adminActor,
        query: { page: 1, limit: 20 },
      });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.pagination.total_pages).toBe(0);
    });

    it('TC-04: maps friendly status filters to domain/database statuses', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        findAdminQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items: [], total: 0 }),
      };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      // draft -> draft_request
      await useCase.execute({
        actor: adminActor,
        query: { page: 1, limit: 20, status: 'draft' },
      });
      expect(singleRepo.findAdminQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'draft_request' }),
        expect.anything(),
      );

      // bidding -> ['sent_to_artisans', 'artisans_bidding']
      await useCase.execute({
        actor: adminActor,
        query: { page: 1, limit: 20, status: 'bidding' },
      });
      expect(singleRepo.findAdminQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: ['sent_to_artisans', 'artisans_bidding'],
        }),
        expect.anything(),
      );

      // accepted -> buyer_accepted
      await useCase.execute({
        actor: adminActor,
        query: { page: 1, limit: 20, status: 'accepted' },
      });
      expect(singleRepo.findAdminQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'buyer_accepted' }),
        expect.anything(),
      );

      // cancelled -> cancelled: true
      await useCase.execute({
        actor: adminActor,
        query: { page: 1, limit: 20, status: 'cancelled' },
      });
      expect(singleRepo.findAdminQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({ cancelled: true }),
        expect.anything(),
      );
    });

    it('TC-05: passes raw DB statuses directly', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        findAdminQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items: [], total: 0 }),
      };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await useCase.execute({
        actor: adminActor,
        query: { page: 1, limit: 20, status: 'artisans_bidding' },
      });
      expect(singleRepo.findAdminQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'artisans_bidding' }),
        expect.anything(),
      );
    });

    it('TC-06: applies boolean cancelled filter when specified', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        findAdminQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items: [], total: 0 }),
      };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await useCase.execute({
        actor: adminActor,
        query: { page: 1, limit: 20, cancelled: true },
      });
      expect(singleRepo.findAdminQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({ cancelled: true }),
        expect.anything(),
      );

      await useCase.execute({
        actor: adminActor,
        query: { page: 1, limit: 20, cancelled: false },
      });
      expect(singleRepo.findAdminQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({ cancelled: false }),
        expect.anything(),
      );
    });

    it('TC-07: applies buyer_id filter (Admin can view any buyer requests)', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        findAdminQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items: [], total: 0 }),
      };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await useCase.execute({
        actor: adminActor,
        query: { page: 1, limit: 20, buyer_id: '42' },
      });
      expect(singleRepo.findAdminQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({ buyerId: '42' }),
        expect.anything(),
      );
    });

    it('TC-08: applies category_id filter', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        findAdminQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items: [], total: 0 }),
      };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await useCase.execute({
        actor: adminActor,
        query: { page: 1, limit: 20, category_id: '5' },
      });
      expect(singleRepo.findAdminQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({ categoryId: '5' }),
        expect.anything(),
      );
    });

    it('TC-09: applies combined multi-filter (buyer_id, category_id, status, search, cancelled)', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        findAdminQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items: [], total: 0 }),
      };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await useCase.execute({
        actor: adminActor,
        query: {
          page: 1,
          limit: 20,
          buyer_id: '15',
          category_id: '3',
          status: 'bidding',
          cancelled: false,
          search: 'ấm chén',
        },
      });
      expect(singleRepo.findAdminQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({
          buyerId: '15',
          categoryId: '3',
          status: ['sent_to_artisans', 'artisans_bidding'],
          cancelled: false,
          search: 'ấm chén',
        }),
        expect.anything(),
      );
    });

    it('TC-10: applies custom sort_by and order', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        findAdminQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items: [], total: 0 }),
      };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await useCase.execute({
        actor: adminActor,
        query: { page: 1, limit: 20, sort_by: 'quantity', order: 'asc' },
      });
      expect(singleRepo.findAdminQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({ sortBy: 'quantity', order: 'asc' }),
        expect.anything(),
      );
    });

    it('TC-11: rejects execution with TradingPermissionDeniedError if actor is not admin', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { findAdminQuoteRequests: vi.fn() };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({ actor: buyerActor, query: { page: 1, limit: 20 } }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      await expect(
        useCase.execute({ actor: artisanActor, query: { page: 1, limit: 20 } }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      expect(singleRepo.findAdminQuoteRequests).not.toHaveBeenCalled();
    });

    it('TC-12: rejects execution if actor has temp_password session level', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { findAdminQuoteRequests: vi.fn() };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: tempPasswordAdminActor,
          query: { page: 1, limit: 20 },
        }),
      ).rejects.toThrow(TradingDomainError);

      expect(singleRepo.findAdminQuoteRequests).not.toHaveBeenCalled();
    });

    it('TC-13: rejects invalid pagination bounds with InvalidTradingInputError', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { findAdminQuoteRequests: vi.fn() };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({ actor: adminActor, query: { page: 0, limit: 20 } }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({ actor: adminActor, query: { page: 1, limit: 0 } }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({ actor: adminActor, query: { page: 1, limit: 101 } }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('TC-14: rejects invalid sort field or order with InvalidTradingInputError', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { findAdminQuoteRequests: vi.fn() };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { page: 1, limit: 20, sort_by: 'illegal_column' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { page: 1, limit: 20, order: 'sideways' as any },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('TC-15: rejects invalid status filter with InvalidTradingInputError', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { findAdminQuoteRequests: vi.fn() };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { page: 1, limit: 20, status: 'unknown_status' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('TC-16: rejects invalid buyer_id or category_id with InvalidTradingInputError', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { findAdminQuoteRequests: vi.fn() };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { page: 1, limit: 20, buyer_id: 'not_a_number' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { page: 1, limit: 20, category_id: '-5' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('TC-17: verifies derived fields calculations contract and QuoteRequestMapper.toSummaryDto', async () => {
      const now = new Date('2026-11-12T12:00:00.000Z');
      const domainRequest = QuoteRequest.reconstitute({
        id: '10001',
        buyer_id: '10',
        category_id: '3',
        spec: 'Bình hoa sen',
        quantity: 50,
        unit: 'piece',
        unit_set_description: null,
        status: 'artisans_bidding',
        delivery_mode: 'at_buyer_address',
        delivery_region: 'HN',
        delivery_address: '123 Kim Ma, Ba Dinh, Ha Noi',
        recipient_name: 'Nguyen Van A',
        recipient_phone: '0912345678',
        bidding_deadline: new Date('2026-11-20T12:00:00.000Z'),
        delivery_deadline: new Date('2026-12-01T12:00:00.000Z'),
        bidding_closed_at: null,
        version: 1,
        cancelled_at: null,
        cancelled_by: null,
        cancel_reason: null,
        created_at: new Date('2026-11-10T10:00:00.000Z'),
        updated_at: new Date('2026-11-10T10:00:00.000Z'),
      });

      const summary = QuoteRequestMapper.toSummaryDto(domainRequest, {
        category: { id: '3', name: 'Ấm chén Bát Tràng' },
        now,
        quotes: [
          {
            id: 501n,
            quote_request_id: 10001n,
            workshop_id: 201n,
            status: 'active',
            price_per_unit: 100000n,
            total_price: 5000000n,
            committed_delivery_at: new Date('2026-11-25T12:00:00.000Z'),
            bid_accept_deadline: new Date('2026-11-18T12:00:00.000Z'),
            version: 1,
            created_at: new Date('2026-11-11T10:00:00.000Z'),
            updated_at: new Date('2026-11-11T10:00:00.000Z'),
            workshop: {
              id: 201n,
              name: 'Xưởng gốm Thịnh Vượng',
              status: 'active',
            },
          },
        ],
      });

      expect(summary.is_bidding_open).toBe(true);
      expect(summary.no_valid_quotes).toBe(false);
      expect(summary.nearest_accept_deadline).toBe('2026-11-18T12:00:00.000Z');
      expect(summary).not.toHaveProperty('recipient_name');
      expect(summary).not.toHaveProperty('recipient_phone');
      expect(summary).not.toHaveProperty('delivery_address');
    });
  });

  describe('AdminQuoteRequestController (HTTP Endpoints & Guards)', () => {
    let app: NestExpressApplication;
    let base: string;

    beforeAll(async () => {
      vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/test');
      vi.stubEnv(
        'SESSION_SECRET',
        'test_secret_32_chars_for_development_purposes',
      );
      vi.stubEnv('NODE_ENV', 'development');

      app = await NestFactory.create<NestExpressApplication>(
        TestTradingModule,
        {
          bodyParser: false,
          logger: false,
          abortOnError: false,
        },
      );
      configureHttp(app, new AppLogger('error', (_line, done) => done()));
      await app.listen(0, '127.0.0.1');
      base = (await app.getUrl()) + '/api/v1';
    });

    afterAll(async () => {
      await app?.close();
      vi.unstubAllEnvs();
    });

    it('TC-18: GET /admin/quote-requests succeeds with 200 OK and default enveloped pagination', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(adminActor);
      mockRepo.findAdminQuoteRequests.mockResolvedValueOnce({
        items: [createSampleSummaryDto({ id: '10001' })],
        total: 1,
      });

      const res = await fetch(`${base}/admin/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=valid-admin-token' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('10001');
      expect(json.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 1,
        total_pages: 1,
      });
    });

    it('TC-19: GET /admin/quote-requests handles custom query parameters (page, limit, buyer_id, category_id, status, sort_by, order, search)', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(adminActor);
      mockRepo.findAdminQuoteRequests.mockResolvedValueOnce({
        items: [createSampleSummaryDto({ id: '10002' })],
        total: 12,
      });

      const res = await fetch(
        `${base}/admin/quote-requests?page=2&limit=5&buyer_id=10&category_id=3&status=bidding&sort_by=quantity&order=asc&search=vase`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.pagination).toEqual({
        page: 2,
        limit: 5,
        total_records: 12,
        total_pages: 3,
      });
      expect(mockRepo.findAdminQuoteRequests).toHaveBeenCalledWith(
        expect.objectContaining({
          buyerId: '10',
          categoryId: '3',
          page: 2,
          limit: 5,
          status: ['sent_to_artisans', 'artisans_bidding'],
          sortBy: 'quantity',
          order: 'asc',
          search: 'vase',
        }),
        expect.anything(),
      );
    });

    it('TC-20: BR-04 / SEC-04 Data Masking verification (never exposes recipient or address)', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(adminActor);
      mockRepo.findAdminQuoteRequests.mockResolvedValueOnce({
        items: [
          createSampleSummaryDto({ id: '10001' }),
          createSampleSummaryDto({ id: '10002' }),
        ],
        total: 2,
      });

      const res = await fetch(`${base}/admin/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=valid-admin-token' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(2);

      for (const item of json.data) {
        expect(item).not.toHaveProperty('recipient_name');
        expect(item).not.toHaveProperty('recipient_phone');
        expect(item).not.toHaveProperty('delivery_address');
        expect(item).not.toHaveProperty('delivery_region');
        expect(item).not.toHaveProperty('spec');
        expect(item).not.toHaveProperty('unit_set_description');
        expect(item).toHaveProperty('split_requested_at', null);
      }
    });

    it('TC-21: rejects unrecognized query parameter with 400 Bad Request (strict Zod schema)', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(adminActor);

      const res = await fetch(
        `${base}/admin/quote-requests?unexpected_param=value`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors[0].field).toBe('/unexpected_param');
    });

    it('TC-22: rejects invalid limit parameters with 400 Bad Request (SEC-14 max 100)', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(adminActor);

      const resExceed = await fetch(`${base}/admin/quote-requests?limit=101`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=valid-admin-token' },
      });
      expect(resExceed.status).toBe(400);
      const jsonExceed = await resExceed.json();
      expect(jsonExceed.code).toBe('INVALID_INPUT');

      identityMock.resolveSession.mockResolvedValueOnce(adminActor);
      const resZero = await fetch(`${base}/admin/quote-requests?limit=0`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=valid-admin-token' },
      });
      expect(resZero.status).toBe(400);
    });

    it('TC-23: rejects invalid page parameters with 400 Bad Request', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(adminActor);

      const res = await fetch(`${base}/admin/quote-requests?page=0`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=valid-admin-token' },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('TC-24: rejects invalid status enum with 400 Bad Request', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(adminActor);

      const res = await fetch(
        `${base}/admin/quote-requests?status=invalid_status`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('TC-25: rejects invalid sort_by or order with 400 Bad Request', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(adminActor);

      const resSort = await fetch(
        `${base}/admin/quote-requests?sort_by=not_allowed_field`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        },
      );
      expect(resSort.status).toBe(400);

      identityMock.resolveSession.mockResolvedValueOnce(adminActor);
      const resOrder = await fetch(
        `${base}/admin/quote-requests?order=diagonal`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        },
      );
      expect(resOrder.status).toBe(400);
    });

    it('TC-26: rejects invalid buyer_id or category_id regex with 400 Bad Request', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(adminActor);

      const resBuyer = await fetch(
        `${base}/admin/quote-requests?buyer_id=abc`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        },
      );
      expect(resBuyer.status).toBe(400);
      const jsonBuyer = await resBuyer.json();
      expect(jsonBuyer.code).toBe('INVALID_INPUT');

      identityMock.resolveSession.mockResolvedValueOnce(adminActor);
      const resCategory = await fetch(
        `${base}/admin/quote-requests?category_id=-1`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        },
      );
      expect(resCategory.status).toBe(400);
      const jsonCategory = await resCategory.json();
      expect(jsonCategory.code).toBe('INVALID_INPUT');
    });

    it('TC-27: rejects search keyword exceeding 100 characters with 400 Bad Request', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(adminActor);
      const longSearch = 'a'.repeat(101);

      const res = await fetch(
        `${base}/admin/quote-requests?search=${longSearch}`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('TC-28: security guards reject unauthenticated, unauthorized role, and temp password', async () => {
      // 1. Missing cookie -> 401
      const resUnauth = await fetch(`${base}/admin/quote-requests`, {
        method: 'GET',
      });
      expect(resUnauth.status).toBe(401);
      const jsonUnauth = await resUnauth.json();
      expect(jsonUnauth.code).toBe('AUTHENTICATION_REQUIRED');

      // 2. Buyer role -> 403 PERMISSION_DENIED
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const resBuyer = await fetch(`${base}/admin/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=buyer-token' },
      });
      expect(resBuyer.status).toBe(403);
      const jsonBuyer = await resBuyer.json();
      expect(jsonBuyer.code).toBe('PERMISSION_DENIED');

      // 3. Artisan role -> 403 PERMISSION_DENIED
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);
      const resArtisan = await fetch(`${base}/admin/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=artisan-token' },
      });
      expect(resArtisan.status).toBe(403);
      const jsonArtisan = await resArtisan.json();
      expect(jsonArtisan.code).toBe('PERMISSION_DENIED');

      // 4. Temp password session -> 403 TEMP_PASSWORD_RESTRICTED
      identityMock.resolveSession.mockResolvedValueOnce(tempPasswordAdminActor);
      const resTemp = await fetch(`${base}/admin/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=temp-admin-token' },
      });
      expect(resTemp.status).toBe(403);
      const jsonTemp = await resTemp.json();
      expect(jsonTemp.code).toBe('TEMP_PASSWORD_RESTRICTED');
    });
  });
});
