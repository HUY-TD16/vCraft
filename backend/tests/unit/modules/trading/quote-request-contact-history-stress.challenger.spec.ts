import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureHttp } from '../../../../src/bootstrap/configure-http';
import { AppLogger } from '../../../../src/common/observability/app-logger';
import { AppConfigModule } from '../../../../src/common/config/app-config';
import { SecurityModule } from '../../../../src/common/security/security.module';
import { IDENTITY_CONTRACT } from '../../../../src/modules/identity/public/contracts/identity.contract';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import { TRANSACTION_RUNNER } from '../../../../src/common/application/ports/transaction-runner';
import {
  type IQuoteRequestRepository,
  type IContactEditHistoryRepository,
  type IAllocationRepository,
  QUOTE_REQUEST_REPOSITORY,
  CONTACT_EDIT_HISTORY_REPOSITORY,
  ALLOCATION_REPOSITORY,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { GetQuoteRequestByIdUseCase } from '../../../../src/modules/trading/application/use-cases/requests/get-quote-request-by-id.use-case';
import { GetContactHistoryUseCase } from '../../../../src/modules/trading/application/use-cases/requests/get-contact-history.use-case';
import { QuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/quote-request.controller';
import {
  Allocation,
  EntityId,
  InvalidTradingInputError,
  QuoteRequest,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import type { ContactEventDto } from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';

// ---------------------------------------------------------------------------
// Helper: Deep-extract all object keys recursively to verify no data leaks
// ---------------------------------------------------------------------------
function extractAllKeys(obj: unknown): Set<string> {
  const keys = new Set<string>();
  function recurse(curr: unknown) {
    if (curr === null || typeof curr !== 'object') return;
    if (Array.isArray(curr)) {
      for (const item of curr) recurse(item);
    } else {
      for (const [k, v] of Object.entries(curr)) {
        keys.add(k);
        recurse(v);
      }
    }
  }
  recurse(obj);
  return keys;
}

// ---------------------------------------------------------------------------
// Adversarial Actors & Session Fixtures
// ---------------------------------------------------------------------------
const buyerOwner: AuthenticatedActor = Object.freeze({
  accountId: '101',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-owner',
  sessionLevel: 'normal',
});

const buyerAttacker: AuthenticatedActor = Object.freeze({
  accountId: '999',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-attacker',
  sessionLevel: 'normal',
});

const adminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-admin',
  sessionLevel: 'normal',
});

const artisanWithAllocation: AuthenticatedActor = Object.freeze({
  accountId: '201',
  role: 'artisan',
  workshopId: '301',
  authVersion: 1,
  sessionId: 'session-artisan-allocated',
  sessionLevel: 'normal',
});

const artisanUnallocated: AuthenticatedActor = Object.freeze({
  accountId: '202',
  role: 'artisan',
  workshopId: '302',
  authVersion: 1,
  sessionId: 'session-artisan-unallocated',
  sessionLevel: 'normal',
});

const artisanWithoutWorkshop: AuthenticatedActor = Object.freeze({
  accountId: '203',
  role: 'artisan',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-artisan-no-workshop',
  sessionLevel: 'normal',
});

const tempPasswordBuyer: AuthenticatedActor = Object.freeze({
  accountId: '101',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-temp-buyer',
  sessionLevel: 'temp_password',
});

const tempPasswordArtisan: AuthenticatedActor = Object.freeze({
  accountId: '201',
  role: 'artisan',
  workshopId: '301',
  authVersion: 1,
  sessionId: 'session-temp-artisan',
  sessionLevel: 'temp_password',
});

const tempPasswordAdmin: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-temp-admin',
  sessionLevel: 'temp_password',
});

// ---------------------------------------------------------------------------
// Entity Builders
// ---------------------------------------------------------------------------
function buildQuoteRequest(
  overrides: Partial<{
    id: string;
    buyer_id: string;
    status: any;
    version: number;
    cancelled_at: Date | null;
  }> = {},
): QuoteRequest {
  const cancelledAt = overrides.cancelled_at ?? null;
  return QuoteRequest.reconstitute({
    id: overrides.id ?? '5001',
    buyer_id: overrides.buyer_id ?? '101',
    category_id: '1',
    spec: 'Bộ ấm chén men hoả biến Bát Tràng',
    quantity: 50,
    unit: 'set',
    unit_set_description: '1 ấm + 6 chén + 7 đĩa',
    status: overrides.status ?? 'sent_to_artisans',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội',
    delivery_address: 'Số 88 Phố Huế, Hai Bà Trưng, Hà Nội',
    recipient_name: 'Nguyễn Văn Chủ',
    recipient_phone: '0912345678',
    bidding_deadline: new Date(Date.now() + 86400000 * 3),
    delivery_deadline: new Date(Date.now() + 86400000 * 15),
    bidding_closed_at: null,
    version: overrides.version ?? 1,
    cancelled_at: cancelledAt,
    cancelled_by: cancelledAt ? '101' : null,
    cancel_reason: cancelledAt ? 'Hủy theo yêu cầu' : null,
    created_at: new Date('2026-11-10T10:00:00.000Z'),
    updated_at: new Date('2026-11-10T10:00:00.000Z'),
  });
}

function buildAllocation(params: {
  id?: string;
  requestId: string;
  workshopId: string;
}): Allocation {
  return Allocation.reconstitute({
    id: params.id ?? '7001',
    request_id: params.requestId,
    workshop_id: params.workshopId,
    quote_id: '8001',
    quantity: 50,
    unit_price: 250000,
    committed_delivery_at: new Date(Date.now() + 86400000 * 10),
    status: 'confirmed',
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
    batch_links: [],
    created_at: new Date('2026-11-11T12:00:00.000Z'),
    updated_at: new Date('2026-11-11T12:00:00.000Z'),
  });
}

function buildContactEvent(params: {
  id: string;
  version: number;
  prevName: string;
  prevPhone: string;
  newName: string;
  newPhone: string;
  editedById: string;
  editedByName: string | null;
  editedAt: string;
}): ContactEventDto {
  return Object.freeze({
    id: params.id,
    prev_recipient_name: params.prevName,
    prev_recipient_phone: params.prevPhone,
    new_recipient_name: params.newName,
    new_recipient_phone: params.newPhone,
    edited_by: Object.freeze({
      id: params.editedById,
      display_name: params.editedByName,
    }),
    edited_at: params.editedAt,
    version: params.version,
  });
}

// ---------------------------------------------------------------------------
// Challenger Adversarial Test Suite
// ---------------------------------------------------------------------------
describe('Adversarial Stress Suite: GET /api/v1/quote-requests/:id/contact-history (Task 15, UC-14, BR-11, BR-04, SEC-05, SEC-06)', () => {
  const identityMock = new MockIdentityContract();
  const txRunner = new MockTransactionRunner();

  const mockQuoteRequestRepo = {
    findById: vi.fn(),
    findDetailById: vi.fn(),
  };

  const mockContactEditHistoryRepo = {
    listEventsByRequestId: vi.fn(),
    findEventsWithPagination: vi.fn(),
  };

  const mockAllocationRepo = {
    findByRequestAndWorkshop: vi.fn(),
  };

  let app: NestExpressApplication;
  let base: string;
  let directUseCase: GetContactHistoryUseCase;

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
      {
        provide: CONTACT_EDIT_HISTORY_REPOSITORY,
        useValue: mockContactEditHistoryRepo,
      },
      { provide: ALLOCATION_REPOSITORY, useValue: mockAllocationRepo },
      {
        provide: GetQuoteRequestByIdUseCase,
        useFactory: (runner: any, repo: any) =>
          new GetQuoteRequestByIdUseCase(runner, repo),
        inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
      },
      {
        provide: GetContactHistoryUseCase,
        useFactory: (
          runner: any,
          qRepo: any,
          cRepo: any,
          aRepo: any,
        ) => new GetContactHistoryUseCase(runner, qRepo, cRepo, aRepo),
        inject: [
          TRANSACTION_RUNNER,
          QUOTE_REQUEST_REPOSITORY,
          CONTACT_EDIT_HISTORY_REPOSITORY,
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

    app = await NestFactory.create<NestExpressApplication>(TestAppModule, {
      bodyParser: false,
      logger: false,
      abortOnError: false,
    });
    configureHttp(app, new AppLogger('error', (_line, done) => done()));
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()) + '/api/v1';

    directUseCase = new GetContactHistoryUseCase(
      txRunner,
      mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
      mockContactEditHistoryRepo as unknown as IContactEditHistoryRepository,
      mockAllocationRepo as unknown as IAllocationRepository,
    );
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    identityMock.resolveSession.mockImplementation(async (token: string) => {
      switch (token) {
        case 'session-buyer-owner':
          return buyerOwner;
        case 'session-buyer-attacker':
          return buyerAttacker;
        case 'session-admin':
          return adminActor;
        case 'session-artisan-allocated':
          return artisanWithAllocation;
        case 'session-artisan-unallocated':
          return artisanUnallocated;
        case 'session-artisan-no-workshop':
          return artisanWithoutWorkshop;
        case 'session-temp-buyer':
          return tempPasswordBuyer;
        case 'session-temp-artisan':
          return tempPasswordArtisan;
        case 'session-temp-admin':
          return tempPasswordAdmin;
        default:
          return null;
      }
    });
  });

  // =========================================================================
  // Challenge 1: Pagination Boundaries & Parameter Fuzzing
  // =========================================================================
  describe('Challenge 1: Pagination Boundaries & Parameter Fuzzing', () => {
    it('1.1. Minimal boundary page=1, limit=1 returns exactly 1 item and correct total_pages', async () => {
      const request = buildQuoteRequest({ id: '5001' });
      const event1 = buildContactEvent({
        id: '1',
        version: 2,
        prevName: 'Nguyễn Văn A',
        prevPhone: '0912345678',
        newName: 'Nguyễn Văn B',
        newPhone: '0912345679',
        editedById: '101',
        editedByName: 'Buyer A',
        editedAt: '2026-11-11T08:00:00.000Z',
      });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [event1],
        totalRecords: 15,
      });

      const res = await fetch(`${base}/quote-requests/5001/contact-history?page=1&limit=1`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.pagination).toEqual({
        page: 1,
        limit: 1,
        total_records: 15,
        total_pages: 15,
      });
      expect(mockContactEditHistoryRepo.findEventsWithPagination).toHaveBeenCalledWith(
        { requestId: '5001', page: 1, limit: 1 },
        expect.anything(),
      );
    });

    it('1.2. Maximum allowed limit boundary: page=1, limit=100 succeeds', async () => {
      const request = buildQuoteRequest({ id: '5001' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const res = await fetch(`${base}/quote-requests/5001/contact-history?page=1&limit=100`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.pagination.limit).toBe(100);
      expect(mockContactEditHistoryRepo.findEventsWithPagination).toHaveBeenCalledWith(
        { requestId: '5001', page: 1, limit: 100 },
        expect.anything(),
      );
    });

    it.each([
      ['zero', '0'],
      ['negative', '-1'],
      ['decimal', '1.5'],
      ['alphabetic', 'abc'],
      ['empty', ''],
      ['huge negative', '-999999'],
    ])('1.3. Rejects invalid page parameter "%s" (%s) with HTTP 400 INVALID_INPUT', async (_label, invalidPage) => {
      const res = await fetch(
        `${base}/quote-requests/5001/contact-history?page=${invalidPage}`,
        {
          headers: { Cookie: 'vcraft-session=session-buyer-owner' },
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.status).toBe(400);
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it.each([
      ['zero', '0'],
      ['negative', '-1'],
      ['exceeds max limit 100', '101'],
      ['huge limit', '9999'],
      ['decimal', '20.5'],
      ['alphabetic', 'max'],
    ])('1.4. Rejects invalid limit parameter "%s" (%s) with HTTP 400 INVALID_INPUT', async (_label, invalidLimit) => {
      const res = await fetch(
        `${base}/quote-requests/5001/contact-history?limit=${invalidLimit}`,
        {
          headers: { Cookie: 'vcraft-session=session-buyer-owner' },
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.status).toBe(400);
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('1.5. Page far beyond available records (page=999, limit=20, 2 total records) returns HTTP 200 with data: []', async () => {
      const request = buildQuoteRequest({ id: '5001' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 2,
      });

      const res = await fetch(`${base}/quote-requests/5001/contact-history?page=999&limit=20`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toEqual([]);
      expect(json.pagination).toEqual({
        page: 999,
        limit: 20,
        total_records: 2,
        total_pages: 1,
      });
    });

    it.each([
      ['unknown query param', 'unexpected=payload'],
      ['privilege escalation attempt', 'admin=true'],
      ['forbidden sorting param', 'sort=desc'],
      ['forbidden filtering param', 'filter=read'],
      ['SQL injection in param name', 'page=1&1=1'],
    ])('1.6. Rejects unknown query parameter "%s" with HTTP 400 INVALID_INPUT (strict validation)', async (_label, queryStr) => {
      const res = await fetch(`${base}/quote-requests/5001/contact-history?${queryStr}`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.status).toBe(400);
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('1.7. Fuzzing: SQL injection in page parameter is blocked with HTTP 400 INVALID_INPUT', async () => {
      const sqlInjectionPayload = encodeURIComponent("1; DROP TABLE contact_edit_history; --");
      const res = await fetch(`${base}/quote-requests/5001/contact-history?page=${sqlInjectionPayload}`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('1.8. Duplicate array parameter (?page=1&page=2) is rejected with HTTP 400 INVALID_INPUT', async () => {
      const res = await fetch(`${base}/quote-requests/5001/contact-history?page=1&page=2`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Challenge 2: ID Boundaries & Edge Cases
  // =========================================================================
  describe('Challenge 2: ID Boundaries & Edge Cases', () => {
    it('2.1. Maximum safe JavaScript integer ID (9007199254740991) is accepted and processed', async () => {
      const maxJsSafeId = '9007199254740991';
      const request = buildQuoteRequest({ id: maxJsSafeId });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const res = await fetch(`${base}/quote-requests/${maxJsSafeId}/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(200);
      expect(mockQuoteRequestRepo.findById).toHaveBeenCalledWith(maxJsSafeId, expect.anything());
    });

    it('2.2. Maximum signed 64-bit integer ID (9223372036854775807) is accepted and processed', async () => {
      const maxBigIntId = '9223372036854775807';
      const request = buildQuoteRequest({ id: maxBigIntId });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const res = await fetch(`${base}/quote-requests/${maxBigIntId}/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(200);
      expect(mockQuoteRequestRepo.findById).toHaveBeenCalledWith(maxBigIntId, expect.anything());
    });

    it('2.3. Exceeding 64-bit signed integer (9223372036854775808) is rejected with HTTP 400 INVALID_INPUT', async () => {
      const overflowId = '9223372036854775808';
      const res = await fetch(`${base}/quote-requests/${overflowId}/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('2.4. Astronomical decimal integer string is rejected with HTTP 400 INVALID_INPUT', async () => {
      const hugeId = '9999999999999999999999999999999999999999';
      const res = await fetch(`${base}/quote-requests/${hugeId}/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it.each([
      ['alphabetic string', 'abc'],
      ['negative number', '-1'],
      ['negative large', '-5001'],
      ['zero', '0'],
      ['decimal notation', '100.5'],
      ['leading zeros', '0123'],
      ['special characters', '100$'],
      ['SQL injection in path', "1' OR 1=1 --"],
      ['null literal', 'null'],
      ['undefined literal', 'undefined'],
    ])('2.5. Rejects non-valid integer ID "%s" (%s) with HTTP 400 INVALID_INPUT', async (_label, invalidId) => {
      const encoded = encodeURIComponent(invalidId);
      const res = await fetch(`${base}/quote-requests/${encoded}/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('2.6. Non-existent QuoteRequest ID returns HTTP 404 RESOURCE_NOT_FOUND', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/quote-requests/9999999/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
      expect(json.status).toBe(404);
      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Challenge 3: Data Integrity, Chronological Ordering & Actor Masking
  // =========================================================================
  describe('Challenge 3: Data Integrity, Chronological Ordering & Actor Masking', () => {
    it('3.1. QuoteRequest with 0 contact history events returns HTTP 200 with data: [] and total_records: 0, total_pages: 0', async () => {
      const request = buildQuoteRequest({ id: '5001' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const res = await fetch(`${base}/quote-requests/5001/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toEqual([]);
      expect(json.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 0,
        total_pages: 0,
      });
    });

    it('3.2. 12 sequential edit versions are strictly sorted chronologically by edited_at asc, id asc', async () => {
      const request = buildQuoteRequest({ id: '5001', version: 13 });

      // Generate 12 distinct sequential events
      const events: ContactEventDto[] = [];
      const baseTime = new Date('2026-11-10T08:00:00.000Z').getTime();

      for (let i = 1; i <= 12; i++) {
        events.push(
          buildContactEvent({
            id: String(100 + i),
            version: i + 1,
            prevName: `Người nhận V${i}`,
            prevPhone: `09000000${String(i).padStart(2, '0')}`,
            newName: `Người nhận V${i + 1}`,
            newPhone: `09000000${String(i + 1).padStart(2, '0')}`,
            editedById: '101',
            editedByName: 'Nguyễn Văn Chủ',
            editedAt: new Date(baseTime + i * 3600000).toISOString(),
          }),
        );
      }

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: 12,
      });

      const res = await fetch(`${base}/quote-requests/5001/contact-history?limit=50`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(12);

      // Verify strict chronological ascending order: edited_at and id
      for (let i = 0; i < json.data.length - 1; i++) {
        const current = json.data[i];
        const next = json.data[i + 1];

        const currentTime = new Date(current.edited_at).getTime();
        const nextTime = new Date(next.edited_at).getTime();

        expect(currentTime).toBeLessThanOrEqual(nextTime);
        if (currentTime === nextTime) {
          expect(BigInt(current.id)).toBeLessThan(BigInt(next.id));
        }

        // Verify version progression
        expect(next.version).toBeGreaterThan(current.version);
        // Verify link integrity: next.prevName === current.newName
        expect(next.prev_recipient_name).toBe(current.new_recipient_name);
        expect(next.prev_recipient_phone).toBe(current.new_recipient_phone);
      }
    });

    it('3.3. ActorDto masking: edited_by contains strictly { id, display_name } with NO sensitive leaks', async () => {
      const request = buildQuoteRequest({ id: '5001' });
      const eventWithActor = buildContactEvent({
        id: '201',
        version: 2,
        prevName: 'Người Cũ',
        prevPhone: '0911111111',
        newName: 'Người Mới',
        newPhone: '0922222222',
        editedById: '101',
        editedByName: 'Chủ Mua Đồ Gốm',
        editedAt: '2026-11-12T10:00:00.000Z',
      });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [eventWithActor],
        totalRecords: 1,
      });

      const res = await fetch(`${base}/quote-requests/5001/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      const firstEvent = json.data[0];

      // Verify edited_by structure
      expect(firstEvent.edited_by).toEqual({
        id: '101',
        display_name: 'Chủ Mua Đồ Gốm',
      });
      expect(Object.keys(firstEvent.edited_by).sort()).toEqual(['display_name', 'id']);

      // Deep scan the response to guarantee no sensitive account information leaks
      const allKeys = extractAllKeys(firstEvent);
      const forbiddenLeakKeys = [
        'password',
        'password_hash',
        'salt',
        'email',
        'role',
        'session',
        'sessionId',
        'session_id',
        'sessionLevel',
        'session_level',
        'authVersion',
        'auth_version',
        'workshopId',
        'workshop_id',
        'temp_password',
      ];

      for (const forbiddenKey of forbiddenLeakKeys) {
        expect(allKeys.has(forbiddenKey)).toBe(false);
      }
    });

    it('3.4. Null display_name in edited_by is preserved as null (never undefined or empty string)', async () => {
      const request = buildQuoteRequest({ id: '5001' });
      const eventWithNullName = buildContactEvent({
        id: '202',
        version: 2,
        prevName: 'A',
        prevPhone: '0911111111',
        newName: 'B',
        newPhone: '0922222222',
        editedById: '101',
        editedByName: null,
        editedAt: '2026-11-12T10:00:00.000Z',
      });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [eventWithNullName],
        totalRecords: 1,
      });

      const res = await fetch(`${base}/quote-requests/5001/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data[0].edited_by).toEqual({
        id: '101',
        display_name: null,
      });
    });

    it('3.5. DTO items returned by direct use case execution are strictly frozen (immutable)', async () => {
      const request = buildQuoteRequest({ id: '5001' });
      const event = buildContactEvent({
        id: '301',
        version: 2,
        prevName: 'A',
        prevPhone: '0911111111',
        newName: 'B',
        newPhone: '0922222222',
        editedById: '101',
        editedByName: 'Tester',
        editedAt: '2026-11-12T10:00:00.000Z',
      });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [event],
        totalRecords: 1,
      });

      const result = await directUseCase.execute({
        actor: buyerOwner,
        requestId: '5001',
      });

      expect(result.data).toHaveLength(1);
      const item = result.data[0];
      expect(Object.isFrozen(item)).toBe(true);
      expect(Object.isFrozen(item.edited_by)).toBe(true);
    });
  });

  // =========================================================================
  // Challenge 4: Authorization & Anti-IDOR Security (SEC-05, SEC-06, BR-04)
  // =========================================================================
  describe('Challenge 4: Authorization & Anti-IDOR Security', () => {
    it('4.1. Non-owner Buyer receives HTTP 404 RESOURCE_NOT_FOUND (SEC-06 anti-IDOR defense)', async () => {
      const request = buildQuoteRequest({ id: '5001', buyer_id: '101' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);

      const res = await fetch(`${base}/quote-requests/5001/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-attacker' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
      expect(json.status).toBe(404);
      // Ensure persistence query for contact history was NEVER executed
      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('4.2. Artisan without Allocation receives HTTP 404 RESOURCE_NOT_FOUND (SEC-06 anti-IDOR defense)', async () => {
      const request = buildQuoteRequest({ id: '5001', buyer_id: '101' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      // Allocation check returns null
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/quote-requests/5001/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-unallocated' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
      expect(json.status).toBe(404);
      expect(mockAllocationRepo.findByRequestAndWorkshop).toHaveBeenCalledWith('5001', '302', expect.anything());
      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('4.3. Artisan with Allocation successfully retrieves contact history (HTTP 200)', async () => {
      const request = buildQuoteRequest({ id: '5001', buyer_id: '101' });
      const allocation = buildAllocation({ requestId: '5001', workshopId: '301' });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(allocation);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const res = await fetch(`${base}/quote-requests/5001/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-allocated' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(mockAllocationRepo.findByRequestAndWorkshop).toHaveBeenCalledWith('5001', '301', expect.anything());
      expect(mockContactEditHistoryRepo.findEventsWithPagination).toHaveBeenCalled();
    });

    it('4.4. Artisan without active workshopId in session receives HTTP 403 PERMISSION_DENIED', async () => {
      const request = buildQuoteRequest({ id: '5001', buyer_id: '101' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);

      const res = await fetch(`${base}/quote-requests/5001/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-no-workshop' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
      expect(json.status).toBe(403);
      expect(mockAllocationRepo.findByRequestAndWorkshop).not.toHaveBeenCalled();
      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('4.5. Admin actor can access any QuoteRequest contact history without IDOR restriction (HTTP 200)', async () => {
      const request = buildQuoteRequest({ id: '5001', buyer_id: '101' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const res = await fetch(`${base}/quote-requests/5001/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-admin' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(mockAllocationRepo.findByRequestAndWorkshop).not.toHaveBeenCalled();
      expect(mockContactEditHistoryRepo.findEventsWithPagination).toHaveBeenCalled();
    });

    it.each([
      ['Buyer in temp_password session', 'session-temp-buyer'],
      ['Artisan in temp_password session', 'session-temp-artisan'],
      ['Admin in temp_password session', 'session-temp-admin'],
    ])('4.6. %s is blocked with HTTP 403 TEMP_PASSWORD_RESTRICTED (SEC-05)', async (_desc, token) => {
      const res = await fetch(`${base}/quote-requests/5001/contact-history`, {
        headers: { Cookie: `vcraft-session=${token}` },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
      expect(json.status).toBe(403);
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('4.7. Request without session cookie receives HTTP 401 AUTHENTICATION_REQUIRED', async () => {
      const res = await fetch(`${base}/quote-requests/5001/contact-history`);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
      expect(json.status).toBe(401);
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('4.8. Request with forged or invalid session cookie receives HTTP 401 SESSION_EXPIRED', async () => {
      const res = await fetch(`${base}/quote-requests/5001/contact-history`, {
        headers: { Cookie: 'vcraft-session=invalid-or-expired-token' },
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('SESSION_EXPIRED');
      expect(json.status).toBe(401);
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('4.9. Direct use-case invocation with temp_password session throws TradingDomainError(TEMP_PASSWORD_RESTRICTED)', async () => {
      await expect(
        directUseCase.execute({
          actor: tempPasswordBuyer,
          requestId: '5001',
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'TEMP_PASSWORD_RESTRICTED',
        }),
      );
    });

    it('4.10. Direct use-case invocation with unknown actor role throws TradingPermissionDeniedError', async () => {
      const unknownActor = Object.freeze({
        accountId: '888',
        role: 'operator' as any,
        workshopId: null,
        authVersion: 1,
        sessionId: 'session-unknown',
        sessionLevel: 'normal' as const,
      });

      const request = buildQuoteRequest({ id: '5001' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);

      await expect(
        directUseCase.execute({
          actor: unknownActor,
          requestId: '5001',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });
  });

  // =========================================================================
  // Challenge 5: Architectural Purity & Repository Invariants
  // =========================================================================
  describe('Challenge 5: Architectural Purity & Repository Invariants', () => {
    it('5.1. Architectural boundary check: GetContactHistoryUseCase must never import from @nestjs, @prisma, zod, or adapters', () => {
      const useCasePath = resolve(
        __dirname,
        '../../../../src/modules/trading/application/use-cases/requests/get-contact-history.use-case.ts',
      );
      const source = readFileSync(useCasePath, 'utf-8');

      expect(source).not.toMatch(/@nestjs\//);
      expect(source).not.toMatch(/@prisma\/client/);
      expect(source).not.toMatch(/from\s+['"]zod['"]/);
      expect(source).not.toMatch(/adapters\//);
    });

    it('5.2. Persistence repository contract check: PrismaContactEditHistoryRepository enforces orderBy: [{ edited_at: "asc" }, { id: "asc" }]', () => {
      const repoPath = resolve(
        __dirname,
        '../../../../src/modules/trading/adapters/persistence/repositories/contact-edit-history.repository.ts',
      );
      const source = readFileSync(repoPath, 'utf-8');

      // The findEventsWithPagination method must explicitly enforce ascending ordering
      expect(source).toContain("orderBy: [{ edited_at: 'asc' }, { id: 'asc' }]");
    });
  });
});
