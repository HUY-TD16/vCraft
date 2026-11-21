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

describe('Challenger 1 Adversarial Harness: Admin Quote Requests GET API (Milestone 1)', () => {
  let app: NestExpressApplication;
  let base: string;

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/test');
    vi.stubEnv(
      'SESSION_SECRET',
      'test_secret_32_chars_for_development_purposes',
    );
    vi.stubEnv('NODE_ENV', 'development');

    app = await NestFactory.create<NestExpressApplication>(TestTradingModule, {
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

  // =========================================================================
  // 1. Boundary condition and input validation attack: Pagination
  // =========================================================================
  describe('1. Pagination Boundary & Malformed Inputs Attack', () => {
    const adversarialPaginationCases = [
      { param: 'page=0', desc: 'zero page' },
      { param: 'page=-1', desc: 'negative page -1' },
      { param: 'page=-999', desc: 'large negative page' },
      { param: 'page=abc', desc: 'non-numeric string page' },
      { param: 'page=1.5', desc: 'floating point page' },
      { param: 'page=NaN', desc: 'NaN page' },
      { param: 'limit=0', desc: 'zero limit' },
      { param: 'limit=-1', desc: 'negative limit -1' },
      { param: 'limit=-10', desc: 'negative limit -10' },
      { param: 'limit=101', desc: 'limit exceeding max limit 100' },
      { param: 'limit=9999', desc: 'massive limit' },
      { param: 'limit=xyz', desc: 'non-numeric string limit' },
      { param: 'limit=20.5', desc: 'floating point limit' },
    ];

    for (const tc of adversarialPaginationCases) {
      it(`ADV-PAGE: rejects ${tc.desc} (${tc.param}) with HTTP 400 INVALID_INPUT without 500 error`, async () => {
        identityMock.resolveSession.mockResolvedValueOnce(adminActor);

        const res = await fetch(`${base}/admin/quote-requests?${tc.param}`, {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        });

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.code).toBe('INVALID_INPUT');
        expect(json.status).toBe(400);
        expect(Array.isArray(json.errors)).toBe(true);
        expect(json.errors.length).toBeGreaterThan(0);
        // Guarantee no internal server error occurred
        expect(res.status).not.toBe(500);
      });
    }

    it('ADV-PAGE: allows boundary limits limit=1 and limit=100 and page=1', async () => {
      mockRepo.findAdminQuoteRequests.mockResolvedValue({
        items: [],
        total: 0,
      });

      // Boundary min limit=1
      identityMock.resolveSession.mockResolvedValueOnce(adminActor);
      const resMin = await fetch(
        `${base}/admin/quote-requests?page=1&limit=1`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        },
      );
      expect(resMin.status).toBe(200);

      // Boundary max limit=100
      identityMock.resolveSession.mockResolvedValueOnce(adminActor);
      const resMax = await fetch(
        `${base}/admin/quote-requests?page=1&limit=100`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        },
      );
      expect(resMax.status).toBe(200);
    });
  });

  // =========================================================================
  // 2. SQL injection / prototype pollution / schema leak in sort_by & order
  // =========================================================================
  describe('2. SQLi, Prototype Pollution, & Schema Leak Attacks in sort_by & order', () => {
    const adversarialSortCases = [
      { param: 'sort_by=password_hash', desc: 'schema leak / sensitive column attack' },
      { param: 'sort_by=__proto__', desc: 'prototype pollution attempt' },
      { param: 'sort_by=constructor', desc: 'constructor property injection' },
      { param: 'sort_by=toString', desc: 'toString property injection' },
      { param: 'sort_by=valueOf', desc: 'valueOf property injection' },
      { param: "sort_by=' OR 1=1 --", desc: 'SQL injection string in sort_by' },
      { param: 'sort_by=; DROP TABLE quote_requests;', desc: 'SQL injection statement termination' },
      { param: 'sort_by=delivery_address', desc: 'unexposed sensitive database column' },
      { param: 'sort_by=recipient_name', desc: 'unexposed recipient database column' },
      { param: 'sort_by=spec', desc: 'unexposed spec database column' },
      { param: 'sort_by=buyer_id', desc: 'unindexed/disallowed column sort' },
      { param: 'order=__proto__', desc: 'prototype pollution in order' },
      { param: 'order=constructor', desc: 'constructor injection in order' },
      { param: "order=asc; DROP TABLE quote_requests;", desc: 'SQL injection in order' },
      { param: 'order=sideways', desc: 'invalid order direction' },
    ];

    for (const tc of adversarialSortCases) {
      it(`ADV-SORT: rejects ${tc.desc} (${tc.param}) with HTTP 400 INVALID_INPUT without 500 error`, async () => {
        identityMock.resolveSession.mockResolvedValueOnce(adminActor);

        const res = await fetch(`${base}/admin/quote-requests?${tc.param}`, {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        });

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.code).toBe('INVALID_INPUT');
        expect(json.status).toBe(400);
        expect(res.status).not.toBe(500);
      });
    }
  });

  // =========================================================================
  // 3. Unrecognized query keys (Zod strict validation check)
  // =========================================================================
  describe('3. Unrecognized Query Keys (Zod Strict Schema Defense)', () => {
    const unrecognizedParamCases = [
      { query: 'unexpected_param=value', desc: 'generic unexpected param' },
      { query: 'admin=true', desc: 'privilege escalation flag attempt' },
      { query: 'role=superadmin', desc: 'role injection attempt' },
      { query: '__proto__=polluted', desc: 'prototype pollution param key' },
      { query: 'constructor=evil', desc: 'constructor param key' },
      { query: 'hack=1&exploit=true', desc: 'multiple unrecognized keys' },
      { query: 'page=1&limit=20&unrecognized_field=123', desc: 'unrecognized field alongside valid params' },
    ];

    for (const tc of unrecognizedParamCases) {
      it(`ADV-STRICT: rejects unrecognized query key (${tc.desc}) with HTTP 400 INVALID_INPUT`, async () => {
        identityMock.resolveSession.mockResolvedValueOnce(adminActor);

        const res = await fetch(`${base}/admin/quote-requests?${tc.query}`, {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        });

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.code).toBe('INVALID_INPUT');
        expect(json.status).toBe(400);
        expect(Array.isArray(json.errors)).toBe(true);
        expect(res.status).not.toBe(500);
      });
    }
  });

  // =========================================================================
  // 4. Invalid buyer_id and category_id format attacks
  // =========================================================================
  describe('4. Invalid buyer_id and category_id Format Attacks', () => {
    const invalidIdCases = [
      // Negative numbers
      { param: 'buyer_id=-1', desc: 'negative buyer_id -1' },
      { param: 'buyer_id=-999', desc: 'negative buyer_id -999' },
      { param: 'category_id=-5', desc: 'negative category_id -5' },
      { param: 'category_id=-100', desc: 'negative category_id -100' },
      // Zero (forbidden by ^[1-9]\d*$)
      { param: 'buyer_id=0', desc: 'zero buyer_id' },
      { param: 'category_id=0', desc: 'zero category_id' },
      // Non-numeric strings and SQLi
      { param: 'buyer_id=abc', desc: 'alphabetic buyer_id' },
      { param: "buyer_id=' OR 1=1 --", desc: 'SQLi string in buyer_id' },
      { param: 'category_id=not_an_id', desc: 'alphabetic category_id' },
      { param: "category_id=1;DROP TABLE categories;", desc: 'SQLi statement in category_id' },
      // Floats / decimals
      { param: 'buyer_id=1.5', desc: 'float buyer_id 1.5' },
      { param: 'buyer_id=3.14159', desc: 'float buyer_id 3.14159' },
      { param: 'category_id=2.7', desc: 'float category_id 2.7' },
      // Leading zeros / octal notation
      { param: 'buyer_id=0123', desc: 'leading zero buyer_id 0123' },
      { param: 'category_id=05', desc: 'leading zero category_id 05' },
      // Scientific notation
      { param: 'buyer_id=1e5', desc: 'scientific notation buyer_id 1e5' },
      { param: 'category_id=2e3', desc: 'scientific notation category_id 2e3' },
    ];

    for (const tc of invalidIdCases) {
      it(`ADV-ID: rejects ${tc.desc} (${tc.param}) with HTTP 400 INVALID_INPUT without 500 error`, async () => {
        identityMock.resolveSession.mockResolvedValueOnce(adminActor);

        const res = await fetch(`${base}/admin/quote-requests?${tc.param}`, {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        });

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.code).toBe('INVALID_INPUT');
        expect(json.status).toBe(400);
        expect(res.status).not.toBe(500);
      });
    }

    it('ADV-ID: accepts valid positive integer IDs for buyer_id and category_id', async () => {
      mockRepo.findAdminQuoteRequests.mockResolvedValue({
        items: [],
        total: 0,
      });

      identityMock.resolveSession.mockResolvedValueOnce(adminActor);
      const res = await fetch(
        `${base}/admin/quote-requests?buyer_id=1&category_id=42`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        },
      );

      expect(res.status).toBe(200);
      expect(mockRepo.findAdminQuoteRequests).toHaveBeenCalledWith(
        expect.objectContaining({
          buyerId: '1',
          categoryId: '42',
        }),
        expect.anything(),
      );
    });
  });

  // =========================================================================
  // 5. Invalid status and cancelled filters
  // =========================================================================
  describe('5. Invalid status and cancelled Filters', () => {
    const invalidFilterCases = [
      { param: 'status=deleted', desc: 'invalid status deleted' },
      { param: "status=' OR 1=1 --", desc: 'SQLi string in status' },
      { param: 'status=__proto__', desc: 'prototype pollution in status' },
      { param: 'cancelled=maybe', desc: 'non-boolean string in cancelled' },
      { param: 'cancelled=1', desc: 'numeric 1 in cancelled' },
      { param: 'cancelled=0', desc: 'numeric 0 in cancelled' },
      { param: 'cancelled=null', desc: 'string null in cancelled' },
    ];

    for (const tc of invalidFilterCases) {
      it(`ADV-FILTER: rejects ${tc.desc} (${tc.param}) with HTTP 400 INVALID_INPUT`, async () => {
        identityMock.resolveSession.mockResolvedValueOnce(adminActor);

        const res = await fetch(`${base}/admin/quote-requests?${tc.param}`, {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        });

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.code).toBe('INVALID_INPUT');
        expect(res.status).not.toBe(500);
      });
    }
  });

  // =========================================================================
  // 6. Direct Use Case Input Boundary & Tamper Testing
  // =========================================================================
  describe('6. Direct Use Case Input Boundary Hardening', () => {
    it('ADV-UC: rejects non-safe-integer or negative page in use case directly', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { findAdminQuoteRequests: vi.fn() };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({ actor: adminActor, query: { page: -5 } }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({ actor: adminActor, query: { page: 1.5 } }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({ actor: adminActor, query: { page: NaN } }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('ADV-UC: rejects non-safe-integer or out-of-range limit in use case directly', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { findAdminQuoteRequests: vi.fn() };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({ actor: adminActor, query: { limit: 0 } }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({ actor: adminActor, query: { limit: -10 } }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({ actor: adminActor, query: { limit: 101 } }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({ actor: adminActor, query: { limit: 2.5 } }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('ADV-UC: rejects invalid sort_by and order in use case directly', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { findAdminQuoteRequests: vi.fn() };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { sort_by: 'password_hash' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { sort_by: '__proto__' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { order: 'sideways' as any },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('ADV-UC: rejects invalid buyer_id and category_id in use case directly', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { findAdminQuoteRequests: vi.fn() };
      const useCase = new ListAdminQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({ actor: adminActor, query: { buyer_id: '0' } }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({ actor: adminActor, query: { buyer_id: '-10' } }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({ actor: adminActor, query: { buyer_id: '1.5' } }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({ actor: adminActor, query: { category_id: '0' } }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({ actor: adminActor, query: { category_id: '-1' } }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({ actor: adminActor, query: { category_id: '3.14' } }),
      ).rejects.toThrow(InvalidTradingInputError);
    });
  });

  // =========================================================================
  // 7. Data Leakage & Masking Stress Test (BR-04, SEC-04)
  // =========================================================================
  describe('7. Data Redaction & Sensitive Key Scanning (BR-04, SEC-04)', () => {
    it('ADV-MASK: raw JSON response wire text contains zero occurrences of sensitive field keys', async () => {
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
      const text = await res.text();

      const forbiddenKeys = [
        'recipient_name',
        'recipient_phone',
        'delivery_address',
        'delivery_region',
        'spec',
        'unit_set_description',
        'cancel_reason',
      ];

      for (const key of forbiddenKeys) {
        // Assert key is not present as a JSON property key in the wire text
        expect(text).not.toContain(`"${key}"`);
      }
    });
  });

  // =========================================================================
  // 8. Concurrency & Parallel Request Bombing
  // =========================================================================
  describe('8. Concurrency & Parallel Request Bombing', () => {
    it('ADV-CONCUR: handles 25 parallel requests with varied query parameters without race conditions or memory faults', async () => {
      mockRepo.findAdminQuoteRequests.mockImplementation(async (input: any) => {
        return {
          items: [createSampleSummaryDto({ id: String(10000 + input.page) })],
          total: 50,
        };
      });

      const queryPermutations = [
        'page=1&limit=10',
        'page=2&limit=5',
        'page=1&limit=20&status=bidding',
        'page=3&limit=10&sort_by=quantity&order=asc',
        'page=1&limit=50&cancelled=false',
      ];

      const promises = Array.from({ length: 25 }, async (_, index) => {
        identityMock.resolveSession.mockResolvedValueOnce(adminActor);
        const query = queryPermutations[index % queryPermutations.length];
        const res = await fetch(`${base}/admin/quote-requests?${query}`, {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-admin-token' },
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.data).toHaveLength(1);
        expect(json.pagination.total_records).toBe(50);
        return res.status;
      });

      const results = await Promise.all(promises);
      expect(results).toHaveLength(25);
      expect(results.every((status) => status === 200)).toBe(true);
    });
  });
});
