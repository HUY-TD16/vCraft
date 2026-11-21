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
import { CreateDraftQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/create-draft-quote-request.use-case';
import { ListBuyerQuoteRequestsUseCase } from '../../../../src/modules/trading/application/use-cases/requests/list-buyer-quote-requests.use-case';
import { BuyerQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/buyer-quote-request.controller';
import {
  QuoteRequest,
  TradingPermissionDeniedError,
  TradingDomainError,
} from '../../../../src/modules/trading/domain';
import { QuoteRequestMapper } from '../../../../src/modules/trading/adapters/persistence/mappers/quote-request.mapper';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';

// Test Actors
const buyerA: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-A',
  sessionLevel: 'normal',
});

const buyerB: AuthenticatedActor = Object.freeze({
  accountId: '2',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-B',
  sessionLevel: 'normal',
});

const buyerC: AuthenticatedActor = Object.freeze({
  accountId: '3',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-C',
  sessionLevel: 'normal',
});

const artisanActor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '200',
  authVersion: 1,
  sessionId: 'session-artisan',
  sessionLevel: 'normal',
});

const adminActor: AuthenticatedActor = Object.freeze({
  accountId: '99',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-admin',
  sessionLevel: 'normal',
});

const tempPasswordBuyer: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-temp',
  sessionLevel: 'temp_password',
});

// Canary strings for data leakage testing
const CANARY = {
  RECIPIENT_NAME: 'CANARY_NAME_TOP_SECRET',
  RECIPIENT_PHONE: 'CANARY_PHONE_0987654321',
  DELIVERY_ADDRESS: 'CANARY_ADDR_123_SECRET_LANE',
  DELIVERY_REGION: 'CANARY_REGION_PRIVATE',
  SPEC: 'CANARY_SPEC_PROPRIETARY_DESIGN',
  UNIT_SET_DESC: 'CANARY_SET_CONFIDENTIAL',
  CANCEL_REASON: 'CANARY_CANCEL_SECRET_DISPUTE',
};

// In-memory tenant store simulating database
interface DbQuoteRequestRecord {
  id: string;
  buyer_id: string;
  category_id: string;
  spec: string;
  quantity: number;
  unit: string;
  unit_set_description: string | null;
  status: string;
  delivery_mode: string;
  delivery_region: string | null;
  delivery_address: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  bidding_deadline: Date | null;
  delivery_deadline: Date | null;
  bidding_closed_at: Date | null;
  version: number;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const dbStore: DbQuoteRequestRecord[] = [
  // Buyer A records (5 items)
  {
    id: '101',
    buyer_id: '1',
    category_id: '10',
    spec: CANARY.SPEC,
    quantity: 10,
    unit: 'piece',
    unit_set_description: null,
    status: 'artisans_bidding',
    delivery_mode: 'at_buyer_address',
    delivery_region: CANARY.DELIVERY_REGION,
    delivery_address: CANARY.DELIVERY_ADDRESS,
    recipient_name: CANARY.RECIPIENT_NAME,
    recipient_phone: CANARY.RECIPIENT_PHONE,
    bidding_deadline: new Date('2026-12-01T00:00:00Z'),
    delivery_deadline: new Date('2026-12-15T00:00:00Z'),
    bidding_closed_at: null,
    version: 1,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: new Date('2026-11-01T10:00:00Z'),
    updated_at: new Date('2026-11-01T10:00:00Z'),
  },
  {
    id: '102',
    buyer_id: '1',
    category_id: '10',
    spec: 'Buyer A standard draft',
    quantity: 20,
    unit: 'piece',
    unit_set_description: null,
    status: 'draft_request',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'HN',
    delivery_address: '123 Test St',
    recipient_name: 'Buyer A',
    recipient_phone: '0911111111',
    bidding_deadline: null,
    delivery_deadline: null,
    bidding_closed_at: null,
    version: 1,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: new Date('2026-11-02T10:00:00Z'),
    updated_at: new Date('2026-11-02T10:00:00Z'),
  },
  {
    id: '103',
    buyer_id: '1',
    category_id: '10',
    spec: 'Buyer A cancelled item',
    quantity: 5,
    unit: 'piece',
    unit_set_description: null,
    status: 'artisans_bidding',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'HN',
    delivery_address: '123 Test St',
    recipient_name: 'Buyer A',
    recipient_phone: '0911111111',
    bidding_deadline: new Date('2026-11-20T00:00:00Z'),
    delivery_deadline: new Date('2026-12-05T00:00:00Z'),
    bidding_closed_at: null,
    version: 2,
    cancelled_at: new Date('2026-11-03T12:00:00Z'),
    cancelled_by: '1',
    cancel_reason: CANARY.CANCEL_REASON,
    created_at: new Date('2026-11-03T10:00:00Z'),
    updated_at: new Date('2026-11-03T12:00:00Z'),
  },
  {
    id: '104',
    buyer_id: '1',
    category_id: '20',
    spec: 'Buyer A accepted',
    quantity: 50,
    unit: 'piece',
    unit_set_description: null,
    status: 'buyer_accepted',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'HN',
    delivery_address: '123 Test St',
    recipient_name: 'Buyer A',
    recipient_phone: '0911111111',
    bidding_deadline: new Date('2026-11-10T00:00:00Z'),
    delivery_deadline: new Date('2026-11-25T00:00:00Z'),
    bidding_closed_at: new Date('2026-11-08T00:00:00Z'),
    version: 3,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: new Date('2026-11-04T10:00:00Z'),
    updated_at: new Date('2026-11-08T10:00:00Z'),
  },
  {
    id: '105',
    buyer_id: '1',
    category_id: '20',
    spec: 'Buyer A delivered',
    quantity: 15,
    unit: 'piece',
    unit_set_description: null,
    status: 'delivered',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'HN',
    delivery_address: '123 Test St',
    recipient_name: 'Buyer A',
    recipient_phone: '0911111111',
    bidding_deadline: new Date('2026-11-05T00:00:00Z'),
    delivery_deadline: new Date('2026-11-12T00:00:00Z'),
    bidding_closed_at: new Date('2026-11-05T00:00:00Z'),
    version: 4,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: new Date('2026-11-05T10:00:00Z'),
    updated_at: new Date('2026-11-12T10:00:00Z'),
  },

  // Buyer B records (3 items)
  {
    id: '201',
    buyer_id: '2',
    category_id: '30',
    spec: 'Buyer B private pottery',
    quantity: 100,
    unit: 'piece',
    unit_set_description: null,
    status: 'artisans_bidding',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'HCM',
    delivery_address: '456 Le Loi, D1, HCM',
    recipient_name: 'Buyer B',
    recipient_phone: '0922222222',
    bidding_deadline: new Date('2026-12-05T00:00:00Z'),
    delivery_deadline: new Date('2026-12-20T00:00:00Z'),
    bidding_closed_at: null,
    version: 1,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: new Date('2026-11-06T10:00:00Z'),
    updated_at: new Date('2026-11-06T10:00:00Z'),
  },
  {
    id: '202',
    buyer_id: '2',
    category_id: '30',
    spec: 'Buyer B draft',
    quantity: 200,
    unit: 'piece',
    unit_set_description: null,
    status: 'draft_request',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'HCM',
    delivery_address: '456 Le Loi, D1, HCM',
    recipient_name: 'Buyer B',
    recipient_phone: '0922222222',
    bidding_deadline: null,
    delivery_deadline: null,
    bidding_closed_at: null,
    version: 1,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: new Date('2026-11-07T10:00:00Z'),
    updated_at: new Date('2026-11-07T10:00:00Z'),
  },
  {
    id: '203',
    buyer_id: '2',
    category_id: '30',
    spec: 'Buyer B in production',
    quantity: 50,
    unit: 'piece',
    unit_set_description: null,
    status: 'in_production',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'HCM',
    delivery_address: '456 Le Loi, D1, HCM',
    recipient_name: 'Buyer B',
    recipient_phone: '0922222222',
    bidding_deadline: new Date('2026-11-09T00:00:00Z'),
    delivery_deadline: new Date('2026-11-30T00:00:00Z'),
    bidding_closed_at: new Date('2026-11-09T00:00:00Z'),
    version: 2,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: new Date('2026-11-08T10:00:00Z'),
    updated_at: new Date('2026-11-09T10:00:00Z'),
  },
];

const identityMock = new MockIdentityContract();

// Realistic repository mock enforcing buyerId tenant isolation
const adversarialRepoMock = {
  findBuyerQuoteRequests: vi.fn(async (input: any) => {
    // Strictly filter by buyerId
    const targetBuyerId = String(input.buyerId);
    let matched = dbStore.filter((r) => r.buyer_id === targetBuyerId);

    // Filter by status if provided
    if (input.status !== undefined) {
      if (Array.isArray(input.status)) {
        matched = matched.filter((r) => input.status.includes(r.status));
      } else {
        matched = matched.filter((r) => r.status === input.status);
      }
    }

    if (input.cancelled !== undefined) {
      if (input.cancelled) {
        matched = matched.filter((r) => r.cancelled_at !== null);
      } else {
        matched = matched.filter((r) => r.cancelled_at === null);
      }
    }

    // Filter by search
    if (input.search !== undefined) {
      const q = input.search.toLowerCase();
      matched = matched.filter(
        (r) =>
          r.spec.toLowerCase().includes(q) ||
          r.id === q,
      );
    }

    const total = matched.length;
    const page = input.page ?? 1;
    const limit = input.limit ?? 20;
    const start = (page - 1) * limit;
    const pageRows = matched.slice(start, start + limit);

    const items = pageRows.map((row) => {
      const entity = QuoteRequest.reconstitute({
        id: row.id,
        buyer_id: row.buyer_id,
        category_id: row.category_id,
        spec: row.spec,
        quantity: row.quantity,
        unit: row.unit,
        unit_set_description: row.unit_set_description,
        status: row.status as any,
        delivery_mode: row.delivery_mode as any,
        delivery_region: row.delivery_region,
        delivery_address: row.delivery_address,
        recipient_name: row.recipient_name,
        recipient_phone: row.recipient_phone,
        bidding_deadline: row.bidding_deadline,
        delivery_deadline: row.delivery_deadline,
        bidding_closed_at: row.bidding_closed_at,
        version: row.version,
        cancelled_at: row.cancelled_at,
        cancelled_by: row.cancelled_by,
        cancel_reason: row.cancel_reason,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });

      return QuoteRequestMapper.toSummaryDto(entity, {
        category: { id: row.category_id, name: 'Sample Category' },
        now: input.now ?? new Date(),
        quotes: [],
      });
    });

    return { items, total };
  }),
  createDraft: vi.fn(),
};

class TestChallengerIdentityModule {}
Module({
  providers: [{ provide: IDENTITY_CONTRACT, useValue: identityMock }],
  exports: [IDENTITY_CONTRACT],
})(TestChallengerIdentityModule);

class TestChallengerTradingModule {}
Module({
  imports: [
    AppConfigModule,
    SecurityModule.register([TestChallengerIdentityModule]),
  ],
  controllers: [BuyerQuoteRequestController],
  providers: [
    { provide: TRANSACTION_RUNNER, useClass: MockTransactionRunner },
    { provide: QUOTE_REQUEST_REPOSITORY, useValue: adversarialRepoMock },
    {
      provide: CreateDraftQuoteRequestUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new CreateDraftQuoteRequestUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
    {
      provide: ListBuyerQuoteRequestsUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new ListBuyerQuoteRequestsUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
  ],
})(TestChallengerTradingModule);

describe('CHALLENGER: Adversarial Verification & Stress Test (GET /api/v1/buyer/quote-requests)', () => {
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
      TestChallengerTradingModule,
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

  // =========================================================================
  // 1. SEC-06 IDOR & Strict Multi-Tenant Isolation
  // =========================================================================
  describe('1. SEC-06 IDOR & Multi-Tenant Isolation', () => {
    it('CHALLENGE-01: Buyer A receives ONLY Buyer A records; ZERO records of Buyer B leak', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerA);

      const res = await fetch(`${base}/buyer/quote-requests?limit=100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=buyer-A-token' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.length).toBe(5);

      const ids = json.data.map((item: any) => item.id);
      expect(ids).toEqual(['101', '102', '103', '104', '105']);
      expect(ids).not.toContain('201');
      expect(ids).not.toContain('202');
      expect(ids).not.toContain('203');
    });

    it('CHALLENGE-02: Buyer B receives ONLY Buyer B records; ZERO records of Buyer A leak', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerB);

      const res = await fetch(`${base}/buyer/quote-requests?limit=100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=buyer-B-token' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.length).toBe(3);

      const ids = json.data.map((item: any) => item.id);
      expect(ids).toEqual(['201', '202', '203']);
      expect(ids).not.toContain('101');
      expect(ids).not.toContain('102');
      expect(ids).not.toContain('103');
      expect(ids).not.toContain('104');
      expect(ids).not.toContain('105');
    });

    it('CHALLENGE-03: Buyer C (having zero records) receives an empty list and total=0 without errors', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerC);

      const res = await fetch(`${base}/buyer/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=buyer-C-token' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toEqual([]);
      expect(json.pagination.total_records).toBe(0);
    });

    it('CHALLENGE-04: IDOR Query Parameter Pollution attacks are rejected by Zod strictObject with 400', async () => {
      const maliciousParams = [
        'buyer_id=2',
        'buyerId=2',
        'account_id=2',
        'accountId=2',
        'tenant_id=2',
        'user_id=2',
        'filter[buyer_id]=2',
      ];

      for (const param of maliciousParams) {
        identityMock.resolveSession.mockResolvedValueOnce(buyerA);
        const res = await fetch(`${base}/buyer/quote-requests?${param}`, {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=buyer-A-token' },
        });

        expect(
          res.status,
          `Expected 400 for malicious IDOR param '${param}', got ${res.status}`,
        ).toBe(400);
        const json = await res.json();
        expect(json.code).toBe('INVALID_INPUT');
      }
    });

    it('CHALLENGE-05: Direct UseCase invocation with spoofed query properties strictly enforces actor.accountId', async () => {
      const txRunner = new MockTransactionRunner();
      const capturedInputs: any[] = [];
      const testRepo = {
        findBuyerQuoteRequests: vi.fn(async (input: any) => {
          capturedInputs.push(input);
          return { items: [], total: 0 };
        }),
      };
      const useCase = new ListBuyerQuoteRequestsUseCase(
        txRunner as any,
        testRepo as any,
      );

      // Attempt spoofing in query
      await useCase.execute({
        actor: buyerA,
        query: {
          page: 1,
          limit: 10,
          ...({ buyerId: '2', buyer_id: '2', accountId: '2' } as any),
        },
      });

      expect(capturedInputs).toHaveLength(1);
      // The useCase MUST have passed actor.accountId ('1') to repo
      expect(capturedInputs[0].buyerId).toBe('1');
    });
  });

  // =========================================================================
  // 2. BR-04 & SEC-04 Data Leakage / Sensitive Masking Stress Test
  // =========================================================================
  describe('2. BR-04 & SEC-04 Data Masking & Leakage Prevention', () => {
    it('CHALLENGE-06: Raw HTTP text response contains ZERO canary strings (recipient, phone, address, spec, unit_set_desc, cancel_reason)', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerA);

      const res = await fetch(`${base}/buyer/quote-requests?limit=100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=buyer-A-token' },
      });

      expect(res.status).toBe(200);
      const rawText = await res.text();

      // Check all canaries are completely absent from the raw HTTP wire response
      for (const [key, canaryValue] of Object.entries(CANARY)) {
        expect(
          rawText.includes(canaryValue),
          `Sensitive data leaked in raw HTTP response! Canary '${key}': '${canaryValue}' found in response.`,
        ).toBe(false);
      }
    });

    it('CHALLENGE-07: Recursive deep key scan of parsed JSON proves forbidden keys do not exist anywhere in payload', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerA);

      const res = await fetch(`${base}/buyer/quote-requests?limit=100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=buyer-A-token' },
      });

      const json = await res.json();
      expect(json.data.length).toBeGreaterThan(0);

      const FORBIDDEN_KEYS = new Set([
        'recipient_name',
        'recipient_phone',
        'delivery_address',
        'delivery_region',
        'spec',
        'unit_set_description',
        'cancel_reason',
        'cancelled_by',
        'delivery_confirmation',
      ]);

      function recursivelyCheckKeys(obj: any, path: string = 'root') {
        if (!obj || typeof obj !== 'object') return;
        for (const [key, value] of Object.entries(obj)) {
          const currentPath = `${path}.${key}`;
          expect(
            FORBIDDEN_KEYS.has(key),
            `Forbidden key '${key}' leaked at path '${currentPath}'`,
          ).toBe(false);

          if (typeof value === 'object' && value !== null) {
            recursivelyCheckKeys(value, currentPath);
          }
        }
      }

      recursivelyCheckKeys(json);
    });

    it('CHALLENGE-08: Every item strictly conforms to the exact 15 fields of BuyerRequestSummaryDto', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerA);

      const res = await fetch(`${base}/buyer/quote-requests?limit=100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=buyer-A-token' },
      });

      const json = await res.json();
      const EXPECTED_EXACT_KEYS = [
        'id',
        'status',
        'version',
        'category',
        'quantity',
        'unit',
        'bidding_deadline',
        'delivery_deadline',
        'is_bidding_open',
        'cancelled_at',
        'split_requested_at',
        'coordination_state',
        'no_valid_quotes',
        'nearest_accept_deadline',
        'created_at',
      ].sort();

      for (const item of json.data) {
        const itemKeys = Object.keys(item).sort();
        expect(itemKeys).toEqual(EXPECTED_EXACT_KEYS);
        expect(item.split_requested_at).toBeNull();
        expect(item.coordination_state).toBeNull();
      }
    });
  });

  // =========================================================================
  // 3. Access Control & Session Hardening Stress Test
  // =========================================================================
  describe('3. Access Control & Session Hardening', () => {
    it('CHALLENGE-09: Unauthenticated request (no cookie) receives 401 AUTHENTICATION_REQUIRED', async () => {
      const res = await fetch(`${base}/buyer/quote-requests`, {
        method: 'GET',
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('CHALLENGE-10: Artisan role actor receives 403 PERMISSION_DENIED', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);

      const res = await fetch(`${base}/buyer/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=artisan-token' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('CHALLENGE-11: Admin role actor receives 403 PERMISSION_DENIED (strict @Roles buyer restriction)', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(adminActor);

      const res = await fetch(`${base}/buyer/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=admin-token' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('CHALLENGE-12: Actor with sessionLevel temp_password receives 403 TEMP_PASSWORD_RESTRICTED', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(tempPasswordBuyer);

      const res = await fetch(`${base}/buyer/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=temp-password-token' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
    });

    it('CHALLENGE-13: Direct use case execution throws explicit domain errors for non-buyer and temp_password', async () => {
      const txRunner = new MockTransactionRunner();
      const testRepo = { findBuyerQuoteRequests: vi.fn() };
      const useCase = new ListBuyerQuoteRequestsUseCase(
        txRunner as any,
        testRepo as any,
      );

      // Non-buyer
      await expect(
        useCase.execute({ actor: artisanActor, query: {} }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      await expect(
        useCase.execute({ actor: adminActor, query: {} }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      // Temp password
      await expect(
        useCase.execute({ actor: tempPasswordBuyer, query: {} }),
      ).rejects.toThrow(TradingDomainError);

      expect(testRepo.findBuyerQuoteRequests).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. Input Boundary & Fuzzing Stress Test
  // =========================================================================
  describe('4. Input Boundary & Fuzzing Stress Test', () => {
    it('CHALLENGE-14: Limit boundary enforcement (1..100) rejects 0, negative, and >100 with 400', async () => {
      const invalidLimits = [0, -1, -50, 101, 200, 999999];

      for (const limit of invalidLimits) {
        identityMock.resolveSession.mockResolvedValueOnce(buyerA);
        const res = await fetch(
          `${base}/buyer/quote-requests?limit=${limit}`,
          {
            method: 'GET',
            headers: { Cookie: 'vcraft-session=buyer-A-token' },
          },
        );

        expect(
          res.status,
          `Expected 400 for limit=${limit}, got ${res.status}`,
        ).toBe(400);
        const json = await res.json();
        expect(json.code).toBe('INVALID_INPUT');
      }

      // Valid boundary values
      const validLimits = [1, 50, 100];
      for (const limit of validLimits) {
        identityMock.resolveSession.mockResolvedValueOnce(buyerA);
        const res = await fetch(
          `${base}/buyer/quote-requests?limit=${limit}`,
          {
            method: 'GET',
            headers: { Cookie: 'vcraft-session=buyer-A-token' },
          },
        );

        expect(
          res.status,
          `Expected 200 for limit=${limit}, got ${res.status}`,
        ).toBe(200);
      }
    });

    it('CHALLENGE-15: Page boundary enforcement rejects <= 0 with 400', async () => {
      const invalidPages = [0, -1, -100];

      for (const page of invalidPages) {
        identityMock.resolveSession.mockResolvedValueOnce(buyerA);
        const res = await fetch(`${base}/buyer/quote-requests?page=${page}`, {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=buyer-A-token' },
        });

        expect(
          res.status,
          `Expected 400 for page=${page}, got ${res.status}`,
        ).toBe(400);
        const json = await res.json();
        expect(json.code).toBe('INVALID_INPUT');
      }
    });

    it('CHALLENGE-16: Sort and Order fuzzing blocks unauthorized columns and invalid directions', async () => {
      const invalidSorts = ['password_hash', 'secret', 'buyer_id', 'deleted_at'];
      for (const col of invalidSorts) {
        identityMock.resolveSession.mockResolvedValueOnce(buyerA);
        const res = await fetch(
          `${base}/buyer/quote-requests?sort_by=${col}`,
          {
            method: 'GET',
            headers: { Cookie: 'vcraft-session=buyer-A-token' },
          },
        );
        expect(res.status).toBe(400);
      }

      const invalidOrders = ['diagonal', 'random', 'ASCENDING', 'DESCENDING'];
      for (const ord of invalidOrders) {
        identityMock.resolveSession.mockResolvedValueOnce(buyerA);
        const res = await fetch(
          `${base}/buyer/quote-requests?order=${ord}`,
          {
            method: 'GET',
            headers: { Cookie: 'vcraft-session=buyer-A-token' },
          },
        );
        expect(res.status).toBe(400);
      }
    });

    it('CHALLENGE-17: Status enum filtering accepts all 10 legitimate variants and rejects unknown values', async () => {
      const validStatuses = [
        'draft',
        'bidding',
        'accepted',
        'in_production',
        'delivered',
        'cancelled',
        'draft_request',
        'sent_to_artisans',
        'artisans_bidding',
        'buyer_accepted',
      ];

      for (const status of validStatuses) {
        identityMock.resolveSession.mockResolvedValueOnce(buyerA);
        const res = await fetch(
          `${base}/buyer/quote-requests?status=${status}`,
          {
            method: 'GET',
            headers: { Cookie: 'vcraft-session=buyer-A-token' },
          },
        );
        expect(
          res.status,
          `Expected 200 for valid status '${status}', got ${res.status}`,
        ).toBe(200);
      }

      const invalidStatuses = ['deleted', 'archived', 'shipped', 'banned'];
      for (const status of invalidStatuses) {
        identityMock.resolveSession.mockResolvedValueOnce(buyerA);
        const res = await fetch(
          `${base}/buyer/quote-requests?status=${status}`,
          {
            method: 'GET',
            headers: { Cookie: 'vcraft-session=buyer-A-token' },
          },
        );
        expect(res.status).toBe(400);
      }
    });

    it('CHALLENGE-18: Search parameter fuzzing with SQL injection and XSS payloads does not cause 500 or errors', async () => {
      const adversarialSearchStrings = [
        "' OR '1'='1",
        "'; DROP TABLE quote_requests; --",
        '<script>alert("xss")</script>',
        '${7*7}',
        '{{7*7}}',
        'SELECT * FROM users',
      ];

      for (const search of adversarialSearchStrings) {
        identityMock.resolveSession.mockResolvedValueOnce(buyerA);
        const encoded = encodeURIComponent(search);
        const res = await fetch(
          `${base}/buyer/quote-requests?search=${encoded}`,
          {
            method: 'GET',
            headers: { Cookie: 'vcraft-session=buyer-A-token' },
          },
        );

        expect(
          res.status,
          `Expected 200 for search payload '${search}', got ${res.status}`,
        ).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
      }
    });
  });

  // =========================================================================
  // 5. Concurrency & Parallel Request Stress Test
  // =========================================================================
  describe('5. Concurrency & Parallel Request Stress Test', () => {
    it('CHALLENGE-19: 30 simultaneous requests from Buyer A, Buyer B, Buyer C execute concurrently with zero cross-tenant leakage', async () => {
      // Mock identity contract to resolve session based on bearer/session token
      identityMock.resolveSession.mockImplementation(async (sessionToken: string) => {
        if (sessionToken === 'token-A') return buyerA;
        if (sessionToken === 'token-B') return buyerB;
        if (sessionToken === 'token-C') return buyerC;
        return null;
      });

      const tasks: Promise<any>[] = [];

      for (let i = 0; i < 10; i++) {
        tasks.push(
          fetch(`${base}/buyer/quote-requests?limit=100`, {
            headers: { Cookie: 'vcraft-session=token-A' },
          }).then(async (r) => ({
            expected: 'A',
            status: r.status,
            body: await r.json(),
          })),
        );

        tasks.push(
          fetch(`${base}/buyer/quote-requests?limit=100`, {
            headers: { Cookie: 'vcraft-session=token-B' },
          }).then(async (r) => ({
            expected: 'B',
            status: r.status,
            body: await r.json(),
          })),
        );

        tasks.push(
          fetch(`${base}/buyer/quote-requests?limit=100`, {
            headers: { Cookie: 'vcraft-session=token-C' },
          }).then(async (r) => ({
            expected: 'C',
            status: r.status,
            body: await r.json(),
          })),
        );
      }

      const results = await Promise.all(tasks);
      expect(results).toHaveLength(30);

      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const ids = res.body.data.map((item: any) => item.id);

        if (res.expected === 'A') {
          expect(ids).toEqual(['101', '102', '103', '104', '105']);
        } else if (res.expected === 'B') {
          expect(ids).toEqual(['201', '202', '203']);
        } else if (res.expected === 'C') {
          expect(ids).toEqual([]);
        }
      }
    });
  });
});
