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
import {
  TRANSACTION_RUNNER,
} from '../../../../src/common/application/ports/transaction-runner';
import {
  IQuoteRequestRepository,
  IRequestRecipientRepository,
  QUOTE_REQUEST_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
  RequestRecipientDetailItem,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { GetQuoteRequestByIdUseCase } from '../../../../src/modules/trading/application/use-cases/requests/get-quote-request-by-id.use-case';
import { ListQuoteRequestRecipientsUseCase } from '../../../../src/modules/trading/application/use-cases/requests/list-quote-request-recipients.use-case';
import { QuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/quote-request.controller';
import {
  QuoteRequest,
  RequestRecipient,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';

/**
 * Helper to recursively extract all key names from a nested structure
 */
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
// Adversarial Actors
// ---------------------------------------------------------------------------
const buyerA: AuthenticatedActor = Object.freeze({
  accountId: '101',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-a',
  sessionLevel: 'normal',
});

const buyerB: AuthenticatedActor = Object.freeze({
  accountId: '102',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-b',
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

const artisanActor: AuthenticatedActor = Object.freeze({
  accountId: '501',
  role: 'artisan',
  workshopId: '201',
  authVersion: 1,
  sessionId: 'session-artisan',
  sessionLevel: 'normal',
});

const tempPasswordBuyerA: AuthenticatedActor = Object.freeze({
  accountId: '101',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-temp-buyer-a',
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
// Helpers to create test entities
// ---------------------------------------------------------------------------
function buildQuoteRequest(overrides: Partial<{
  id: string;
  buyer_id: string;
  status: any;
  cancelled_at: Date | null;
}> = {}): QuoteRequest {
  const cancelled_at = overrides.cancelled_at ?? null;
  return QuoteRequest.reconstitute({
    id: overrides.id ?? '1001',
    buyer_id: overrides.buyer_id ?? '101',
    category_id: '1',
    spec: 'Bộ lộc bình Bát Tràng tứ quý',
    quantity: 10,
    unit: 'set',
    unit_set_description: '2 bình lục giác cao 1m6',
    status: overrides.status ?? 'sent_to_artisans',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội',
    delivery_address: 'Tầng 15 Vincom Bà Triệu, Hà Nội',
    recipient_name: 'Nguyễn Văn Chủ',
    recipient_phone: '0988776655',
    bidding_deadline: new Date(Date.now() + 86400000 * 3),
    delivery_deadline: new Date(Date.now() + 86400000 * 30),
    bidding_closed_at: null,
    version: 1,
    cancelled_at,
    cancelled_by: cancelled_at ? '101' : null,
    cancel_reason: cancelled_at ? 'Hủy theo yêu cầu Buyer' : null,
    created_at: new Date('2026-11-10T08:00:00.000Z'),
    updated_at: new Date('2026-11-10T08:00:00.000Z'),
  });
}

function buildRecipientItem(params: {
  id: string;
  workshopId: string;
  workshopName: string;
  workshopStatus?: string;
  workshopPhone?: string;
  workshopAddress?: string;
  responseStatus: 'pending' | 'declined' | 'quoted' | 'withdrawn';
  declineReason?: string | null;
  respondedAt?: Date | null;
  quote?: {
    id: string;
    status: string;
    bid_accept_deadline: Date;
    unit_price?: number;
  } | null;
}): RequestRecipientDetailItem {
  return {
    entity: RequestRecipient.reconstitute({
      id: params.id,
      request_id: '1001',
      workshop_id: params.workshopId,
      response_status: params.responseStatus,
      decline_reason: params.declineReason ?? null,
      responded_by: params.respondedAt ? '501' : null,
      responded_at: params.respondedAt ?? null,
      sent_at: new Date('2026-11-10T08:30:00.000Z'),
      version: params.responseStatus === 'pending' ? 1 : 2,
    }),
    workshop: {
      id: params.workshopId,
      name: params.workshopName,
      status: params.workshopStatus ?? 'active',
      // Potential sensitive fields in persistence layer that must NOT leak
      ...((params.workshopPhone ? { phone: params.workshopPhone } : {}) as any),
      ...((params.workshopAddress ? { address: params.workshopAddress } : {}) as any),
    },
    quote: params.quote ? {
      id: params.quote.id,
      status: params.quote.status,
      bid_accept_deadline: params.quote.bid_accept_deadline,
    } : null,
  };
}

// ---------------------------------------------------------------------------
// Challenger Test Suite
// ---------------------------------------------------------------------------
describe('Adversarial Verification: GET /api/v1/quote-requests/:id/recipients (Task 14, UC-18, BR-13, BR-04)', () => {
  const identityMock = new MockIdentityContract();
  const txRunner = new MockTransactionRunner();

  const mockQuoteRequestRepo = {
    findById: vi.fn(),
    findDetailById: vi.fn(),
  };

  const mockRecipientRepo = {
    findRecipientsWithDetails: vi.fn(),
  };

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
      { provide: REQUEST_RECIPIENT_REPOSITORY, useValue: mockRecipientRepo },
      {
        provide: GetQuoteRequestByIdUseCase,
        useFactory: (runner: any, repo: any) =>
          new GetQuoteRequestByIdUseCase(runner, repo),
        inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
      },
      {
        provide: ListQuoteRequestRecipientsUseCase,
        useFactory: (runner: any, qRepo: any, rRepo: any) =>
          new ListQuoteRequestRecipientsUseCase(runner, qRepo, rRepo),
        inject: [
          TRANSACTION_RUNNER,
          QUOTE_REQUEST_REPOSITORY,
          REQUEST_RECIPIENT_REPOSITORY,
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
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    identityMock.resolveSession.mockImplementation(async (token: string) => {
      if (token === 'session-buyer-a') return buyerA;
      if (token === 'session-buyer-b') return buyerB;
      if (token === 'session-admin') return adminActor;
      if (token === 'session-artisan') return artisanActor;
      if (token === 'session-temp-buyer-a') return tempPasswordBuyerA;
      if (token === 'session-temp-admin') return tempPasswordAdmin;
      return null;
    });
  });

  // =========================================================================
  // Challenge 1: Authorization & Anti-IDOR Security (SEC-06, BR-04, SEC-05)
  // =========================================================================
  describe('Challenge 1: Authorization & Anti-IDOR Security', () => {
    it('1.1. Buyer B accessing Buyer A\'s quote request receives 404 RESOURCE_NOT_FOUND (SEC-06 anti-IDOR defense)', async () => {
      const requestOfBuyerA = buildQuoteRequest({ id: '1001', buyer_id: '101' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(requestOfBuyerA);

      const res = await fetch(`${base}/quote-requests/1001/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-b' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
      expect(json.status).toBe(404);
      expect(json.type).toContain('RESOURCE_NOT_FOUND');
      // Crucial: Persistence query for recipients MUST NEVER be called when anti-IDOR fails
      expect(mockRecipientRepo.findRecipientsWithDetails).not.toHaveBeenCalled();
    });

    it('1.2. Artisan actor is strictly blocked with 403 PERMISSION_DENIED (BR-04, UC-18)', async () => {
      const res = await fetch(`${base}/quote-requests/1001/recipients`, {
        headers: { Cookie: 'vcraft-session=session-artisan' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
      expect(json.status).toBe(403);
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
      expect(mockRecipientRepo.findRecipientsWithDetails).not.toHaveBeenCalled();
    });

    it('1.3. Buyer in temp_password session is blocked with 403 TEMP_PASSWORD_RESTRICTED (SEC-05)', async () => {
      const res = await fetch(`${base}/quote-requests/1001/recipients`, {
        headers: { Cookie: 'vcraft-session=session-temp-buyer-a' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
      expect(json.status).toBe(403);
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('1.4. Admin in temp_password session is blocked with 403 TEMP_PASSWORD_RESTRICTED (SEC-05)', async () => {
      const res = await fetch(`${base}/quote-requests/1001/recipients`, {
        headers: { Cookie: 'vcraft-session=session-temp-admin' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
      expect(json.status).toBe(403);
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('1.5. Unauthenticated request without session cookie receives 401 AUTHENTICATION_REQUIRED', async () => {
      const res = await fetch(`${base}/quote-requests/1001/recipients`);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
      expect(json.status).toBe(401);
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('1.6. Invalid or forged session cookie receives 401 SESSION_EXPIRED', async () => {
      const res = await fetch(`${base}/quote-requests/1001/recipients`, {
        headers: { Cookie: 'vcraft-session=forged-malicious-token' },
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('SESSION_EXPIRED');
      expect(json.status).toBe(401);
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });

    it('1.7. Admin can access Buyer A\'s quote request recipients without IDOR blockage', async () => {
      const requestOfBuyerA = buildQuoteRequest({ id: '1001', buyer_id: '101' });
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(requestOfBuyerA);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: [],
        totalRecords: 0,
      });

      const res = await fetch(`${base}/quote-requests/1001/recipients`, {
        headers: { Cookie: 'vcraft-session=session-admin' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(mockRecipientRepo.findRecipientsWithDetails).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: '1001' }),
        expect.anything(),
      );
    });
  });

  // =========================================================================
  // Challenge 2: Recipient Response Status Invariants & Masking (BR-13, BR-04)
  // =========================================================================
  describe('Challenge 2: Recipient Response Status Invariants & Data Masking', () => {
    it('2.1. Verify all 4 response statuses (pending, declined, quoted, withdrawn) in payload', async () => {
      const request = buildQuoteRequest();

      const itemPending = buildRecipientItem({
        id: '1',
        workshopId: '201',
        workshopName: 'Xưởng Gốm Hương Sen',
        responseStatus: 'pending',
      });

      const itemDeclined = buildRecipientItem({
        id: '2',
        workshopId: '202',
        workshopName: 'Xưởng Gốm Họa Mi',
        responseStatus: 'declined',
        declineReason: 'Xưởng đang kín lịch đơn đặt hàng cuối năm',
        respondedAt: new Date('2026-11-11T09:00:00.000Z'),
      });

      const itemQuoted = buildRecipientItem({
        id: '3',
        workshopId: '203',
        workshopName: 'Xưởng Gốm Thăng Long',
        responseStatus: 'quoted',
        respondedAt: new Date('2026-11-11T14:00:00.000Z'),
        quote: {
          id: '801',
          status: 'active',
          bid_accept_deadline: new Date(Date.now() + 86400000 * 2),
        },
      });

      const itemWithdrawn = buildRecipientItem({
        id: '4',
        workshopId: '204',
        workshopName: 'Xưởng Gốm Đại Việt',
        responseStatus: 'withdrawn',
        respondedAt: new Date('2026-11-12T10:00:00.000Z'),
        quote: {
          id: '802',
          status: 'withdrawn',
          bid_accept_deadline: new Date(Date.now() + 86400000 * 2),
        },
      });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: [itemPending, itemDeclined, itemQuoted, itemWithdrawn],
        totalRecords: 4,
      });

      const res = await fetch(`${base}/quote-requests/1001/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-a' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.length).toBe(4);

      // Verify pending invariants: no responded_at, no decline_reason
      const p = json.data.find((x: any) => x.id === '1');
      expect(p.response_status).toBe('pending');
      expect(p.responded_at).toBeNull();
      expect(p.decline_reason).toBeNull();

      // Verify declined invariants: has responded_at, has decline_reason
      const d = json.data.find((x: any) => x.id === '2');
      expect(d.response_status).toBe('declined');
      expect(d.responded_at).toBe('2026-11-11T09:00:00.000Z');
      expect(d.decline_reason).toBe('Xưởng đang kín lịch đơn đặt hàng cuối năm');

      // Verify quoted invariants: has responded_at, decline_reason is null
      const q = json.data.find((x: any) => x.id === '3');
      expect(q.response_status).toBe('quoted');
      expect(q.responded_at).toBe('2026-11-11T14:00:00.000Z');
      expect(q.decline_reason).toBeNull();

      // Verify withdrawn invariants: has responded_at, eligibility contains QUOTE_WITHDRAWN
      const w = json.data.find((x: any) => x.id === '4');
      expect(w.response_status).toBe('withdrawn');
      expect(w.responded_at).toBe('2026-11-12T10:00:00.000Z');
      expect(w.eligibility_labels).toContain('QUOTE_WITHDRAWN');
    });

    it('2.2. Strict Data Masking: No read status, no workshop phone/address/coords, no buyer info in response', async () => {
      const request = buildQuoteRequest();
      const itemWithSensitiveData = buildRecipientItem({
        id: '1',
        workshopId: '201',
        workshopName: 'Xưởng Gốm Bảo Mật',
        workshopPhone: '0901234567',
        workshopAddress: 'Số 9 ngõ Gốm, Bát Tràng, Gia Lâm, Hà Nội',
        responseStatus: 'pending',
      });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: [itemWithSensitiveData],
        totalRecords: 1,
      });

      const res = await fetch(`${base}/quote-requests/1001/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-a' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      const allKeys = extractAllKeys(json.data[0]);

      // Forbidden fields that must NEVER appear
      const forbiddenFields = [
        'phone',
        'address',
        'telephone',
        'coords',
        'latitude',
        'longitude',
        'email',
        'account_id',
        'unit_price',
        'recipient_phone',
        'recipient_name',
        'delivery_address',
        'read',
        'is_read',
        'read_at',
        'status_read',
      ];

      for (const field of forbiddenFields) {
        expect(allKeys.has(field)).toBe(false);
      }

      // Workshop must strictly have ONLY id and name
      expect(json.data[0].workshop).toEqual({
        id: '201',
        name: 'Xưởng Gốm Bảo Mật',
      });
      expect(Object.keys(json.data[0].workshop).sort()).toEqual(['id', 'name']);
    });
  });

  // =========================================================================
  // Challenge 3: All 5 Eligibility Labels (BR-13, BR-15, UC-18, INV-01)
  // =========================================================================
  describe('Challenge 3: Verification of all 5 Eligibility Labels', () => {
    it('3.1. WORKSHOP_SUSPENDED label is added when workshop.status === "suspended"', async () => {
      const request = buildQuoteRequest();
      const item = buildRecipientItem({
        id: '10',
        workshopId: '210',
        workshopName: 'Xưởng Bị Tạm Ngừng',
        workshopStatus: 'suspended',
        responseStatus: 'pending',
      });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: [item],
        totalRecords: 1,
      });

      const res = await fetch(`${base}/quote-requests/1001/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-a' },
      });

      const json = await res.json();
      expect(json.data[0].eligibility_labels).toContain('WORKSHOP_SUSPENDED');
    });

    it('3.2. QUOTE_EXPIRED label is added when quote.bid_accept_deadline is in the past', async () => {
      const request = buildQuoteRequest();
      const item = buildRecipientItem({
        id: '11',
        workshopId: '211',
        workshopName: 'Xưởng Hết Hạn Báo Giá',
        responseStatus: 'quoted',
        respondedAt: new Date('2026-11-01T00:00:00.000Z'),
        quote: {
          id: '811',
          status: 'active',
          bid_accept_deadline: new Date('2026-11-05T00:00:00.000Z'), // Past
        },
      });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: [item],
        totalRecords: 1,
      });

      const res = await fetch(`${base}/quote-requests/1001/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-a' },
      });

      const json = await res.json();
      expect(json.data[0].eligibility_labels).toContain('QUOTE_EXPIRED');
    });

    it('3.3. QUOTE_WITHDRAWN label is added when quote.status is withdrawn or recipient is withdrawn', async () => {
      const request = buildQuoteRequest();
      const item = buildRecipientItem({
        id: '12',
        workshopId: '212',
        workshopName: 'Xưởng Đã Rút',
        responseStatus: 'withdrawn',
        respondedAt: new Date('2026-11-05T00:00:00.000Z'),
      });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: [item],
        totalRecords: 1,
      });

      const res = await fetch(`${base}/quote-requests/1001/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-a' },
      });

      const json = await res.json();
      expect(json.data[0].eligibility_labels).toContain('QUOTE_WITHDRAWN');
    });

    it('3.4. REQUEST_CANCELLED label is added when quoteRequest.isCancelled() is true', async () => {
      const request = buildQuoteRequest({
        cancelled_at: new Date('2026-11-12T00:00:00.000Z'),
      });
      const item = buildRecipientItem({
        id: '13',
        workshopId: '213',
        workshopName: 'Xưởng Khi Request Đã Hủy',
        responseStatus: 'pending',
      });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: [item],
        totalRecords: 1,
      });

      const res = await fetch(`${base}/quote-requests/1001/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-a' },
      });

      const json = await res.json();
      expect(json.data[0].eligibility_labels).toContain('REQUEST_CANCELLED');
    });

    it('3.5. REQUEST_ACCEPTED label is added when quoteRequest.isAcceptedOrBeyond() is true', async () => {
      const request = buildQuoteRequest({
        status: 'buyer_accepted',
      });
      const item = buildRecipientItem({
        id: '14',
        workshopId: '214',
        workshopName: 'Xưởng Khi Request Đã Được Duyệt',
        responseStatus: 'quoted',
        respondedAt: new Date('2026-11-10T12:00:00.000Z'),
        quote: {
          id: '814',
          status: 'active',
          bid_accept_deadline: new Date(Date.now() + 86400000 * 5),
        },
      });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: [item],
        totalRecords: 1,
      });

      const res = await fetch(`${base}/quote-requests/1001/recipients`, {
        headers: { Cookie: 'vcraft-session=session-buyer-a' },
      });

      const json = await res.json();
      expect(json.data[0].eligibility_labels).toContain('REQUEST_ACCEPTED');
    });
  });

  // =========================================================================
  // Challenge 4: Query Validation & Injection Defense (Zod & Route guards)
  // =========================================================================
  describe('Challenge 4: Query Validation & Parameter Tampering', () => {
    it('4.1. Rejects unknown status like "read" with 400 INVALID_INPUT', async () => {
      const res = await fetch(
        `${base}/quote-requests/1001/recipients?response_status=read`,
        {
          headers: { Cookie: 'vcraft-session=session-buyer-a' },
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.status).toBe(400);
    });

    it('4.2. Rejects SQL injection in response_status with 400 INVALID_INPUT', async () => {
      const res = await fetch(
        `${base}/quote-requests/1001/recipients?response_status=' OR 1=1 --`,
        {
          headers: { Cookie: 'vcraft-session=session-buyer-a' },
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('4.3. Rejects negative or zero page parameter with 400 INVALID_INPUT', async () => {
      const res = await fetch(
        `${base}/quote-requests/1001/recipients?page=0`,
        {
          headers: { Cookie: 'vcraft-session=session-buyer-a' },
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('4.4. Rejects limit > 100 with 400 INVALID_INPUT', async () => {
      const res = await fetch(
        `${base}/quote-requests/1001/recipients?limit=101`,
        {
          headers: { Cookie: 'vcraft-session=session-buyer-a' },
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });
  });

  // =========================================================================
  // Challenge 5: Invariants, Immutability & Architectural Boundaries
  // =========================================================================
  describe('Challenge 5: Invariants, Immutability & Architectural Boundaries', () => {
    it('5.1. DTO elements, workshop, and eligibility labels are strictly frozen (immutable)', async () => {
      const directUseCase = new ListQuoteRequestRecipientsUseCase(
        txRunner,
        mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
        mockRecipientRepo as unknown as IRequestRecipientRepository,
      );

      const request = buildQuoteRequest();
      const item = buildRecipientItem({
        id: '1',
        workshopId: '201',
        workshopName: 'Xưởng Gốm',
        responseStatus: 'quoted',
        respondedAt: new Date(),
        quote: {
          id: '801',
          status: 'active',
          bid_accept_deadline: new Date(Date.now() + 1000000),
        },
      });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: [item],
        totalRecords: 1,
      });

      const res = await directUseCase.execute({
        actor: buyerA,
        requestId: '1001',
      });

      expect(res.data.length).toBe(1);
      const dto = res.data[0];
      expect(Object.isFrozen(dto)).toBe(true);
      expect(Object.isFrozen(dto.workshop)).toBe(true);
      expect(Object.isFrozen(dto.eligibility_labels)).toBe(true);
    });

    it('5.2. An accepted quote does NOT get labeled QUOTE_EXPIRED even if deadline passed', async () => {
      const directUseCase = new ListQuoteRequestRecipientsUseCase(
        txRunner,
        mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
        mockRecipientRepo as unknown as IRequestRecipientRepository,
      );

      const request = buildQuoteRequest();
      const item = buildRecipientItem({
        id: '2',
        workshopId: '202',
        workshopName: 'Xưởng Gốm Đã Được Chấp Nhận',
        responseStatus: 'quoted',
        respondedAt: new Date('2026-11-01T00:00:00.000Z'),
        quote: {
          id: '802',
          status: 'accepted', // Accepted quote
          bid_accept_deadline: new Date('2026-11-05T00:00:00.000Z'), // in the past
        },
      });

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockRecipientRepo.findRecipientsWithDetails.mockResolvedValueOnce({
        rows: [item],
        totalRecords: 1,
      });

      const res = await directUseCase.execute({
        actor: buyerA,
        requestId: '1001',
      });

      expect(res.data[0].eligibility_labels).not.toContain('QUOTE_EXPIRED');
    });

    it('5.3. Disallowed roles (e.g. guest or unknown) throw TradingPermissionDeniedError in use case', async () => {
      const directUseCase = new ListQuoteRequestRecipientsUseCase(
        txRunner,
        mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
        mockRecipientRepo as unknown as IRequestRecipientRepository,
      );

      const request = buildQuoteRequest();
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);

      const unknownActor = Object.freeze({
        accountId: '999',
        role: 'operator' as any,
        workshopId: null,
        authVersion: 1,
        sessionId: 'session-unknown',
        sessionLevel: 'normal' as const,
      });

      await expect(
        directUseCase.execute({
          actor: unknownActor,
          requestId: '1001',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('5.4. Architectural Boundary Invariant: Use case file must never import from adapters, nestjs, prisma, or zod', () => {
      const useCasePath = resolve(
        __dirname,
        '../../../../src/modules/trading/application/use-cases/requests/list-quote-request-recipients.use-case.ts',
      );
      const source = readFileSync(useCasePath, 'utf-8');

      expect(source).not.toMatch(/@nestjs\//);
      expect(source).not.toMatch(/@prisma\/client/);
      expect(source).not.toMatch(/from\s+['"]zod['"]/);
      expect(source).not.toMatch(/adapters\//);
    });
  });
});
