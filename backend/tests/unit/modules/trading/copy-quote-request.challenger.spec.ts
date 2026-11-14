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
import { UpdateDraftQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/update-draft-quote-request.use-case';
import { DeleteDraftQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/delete-draft-quote-request.use-case';
import { CopyQuoteRequestUseCase } from '../../../../src/modules/trading/application/use-cases/requests/copy-quote-request.use-case';
import { BuyerQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/buyer-quote-request.controller';
import {
  QuoteRequest,
  type QuoteRequestProps,
  REQUEST_STATUSES,
  type RequestStatus,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';

const buyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-10',
  sessionLevel: 'normal',
});

const otherBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '99',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-other-buyer-99',
  sessionLevel: 'normal',
});

const artisanActor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '200',
  authVersion: 1,
  sessionId: 'session-artisan-20',
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

function createQuoteRequestInStatus(
  status: RequestStatus,
  id: string,
  buyerId: string,
  isCancelled = false,
): QuoteRequest {
  const baseTime = new Date('2026-11-01T08:00:00.000Z');
  return QuoteRequest.reconstitute({
    id,
    buyer_id: buyerId,
    category_id: '4',
    spec: `Mẫu thủ công đặc biệt cho trạng thái ${status}`,
    quantity: 120,
    unit: 'piece',
    unit_set_description: null,
    status,
    delivery_mode: 'at_buyer_address',
    delivery_region: 'HN',
    delivery_address: '123 Phố Huế, Hai Bà Trưng, Hà Nội',
    recipient_name: 'Trần Văn B',
    recipient_phone: '0912345678',
    bidding_deadline: new Date('2026-12-01T12:00:00.000Z'),
    delivery_deadline: new Date('2026-12-25T12:00:00.000Z'),
    bidding_closed_at: status === 'delivered' ? new Date('2026-11-15T12:00:00.000Z') : null,
    version: 4,
    cancelled_at: isCancelled ? new Date('2026-11-05T09:00:00.000Z') : null,
    cancelled_by: isCancelled ? buyerId : null,
    cancel_reason: isCancelled ? 'Adversarial cancellation test reason' : null,
    created_at: baseTime,
    updated_at: baseTime,
  });
}

const identityMock = new MockIdentityContract();
const requestsStore = new Map<string, QuoteRequest>();
let generatedDraftId = 5000;

const mockRepo = {
  createDraft: vi.fn().mockImplementation(async ({ request }: { request: QuoteRequest }) => {
    const id = String(generatedDraftId++);
    const created = QuoteRequest.reconstitute({
      id,
      buyer_id: request.buyer_id,
      category_id: request.category_id,
      spec: request.spec,
      quantity: request.quantity,
      unit: request.unit,
      unit_set_description: request.unit_set_description,
      status: request.status,
      delivery_mode: request.delivery_mode,
      delivery_region: request.delivery_region,
      delivery_address: request.delivery_address,
      recipient_name: request.recipient_name,
      recipient_phone: request.recipient_phone,
      bidding_deadline: request.bidding_deadline,
      delivery_deadline: request.delivery_deadline,
      bidding_closed_at: request.bidding_closed_at,
      version: request.version,
      cancelled_at: request.cancelled_at,
      cancelled_by: request.cancelled_by,
      cancel_reason: request.cancel_reason,
      created_at: request.created_at,
      updated_at: request.updated_at,
    });
    requestsStore.set(id, created);
    return created;
  }),
  findById: vi.fn().mockImplementation(async (id: string) => {
    return requestsStore.get(id) ?? null;
  }),
  lockById: vi.fn().mockImplementation(async (id: string) => {
    return requestsStore.get(id) ?? null;
  }),
  update: vi.fn(),
  deleteDraft: vi.fn(),
};

class TestIdentityModule {}
Module({
  providers: [{ provide: IDENTITY_CONTRACT, useValue: identityMock }],
  exports: [IDENTITY_CONTRACT],
})(TestIdentityModule);

class TestTradingChallengerModule {}
Module({
  imports: [AppConfigModule, SecurityModule.register([TestIdentityModule])],
  controllers: [BuyerQuoteRequestController],
  providers: [
    { provide: TRANSACTION_RUNNER, useClass: MockTransactionRunner },
    { provide: QUOTE_REQUEST_REPOSITORY, useValue: mockRepo },
    {
      provide: CreateDraftQuoteRequestUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new CreateDraftQuoteRequestUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
    {
      provide: UpdateDraftQuoteRequestUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new UpdateDraftQuoteRequestUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
    {
      provide: DeleteDraftQuoteRequestUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new DeleteDraftQuoteRequestUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
    {
      provide: CopyQuoteRequestUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new CopyQuoteRequestUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
  ],
})(TestTradingChallengerModule);

describe('Challenger Stress & Empirical Verification Matrix (UC-14, BR-11, SEC-06)', () => {
  let app: NestExpressApplication;
  let base: string;

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/test');
    vi.stubEnv('SESSION_SECRET', 'test_secret_32_chars_for_development_purposes');
    vi.stubEnv('NODE_ENV', 'development');

    app = await NestFactory.create<NestExpressApplication>(TestTradingChallengerModule, {
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

  // All 7 domain statuses + cancelled variants with valid positive decimal IDs
  const allDomainStatuses: Array<{ status: RequestStatus; isCancelled: boolean; label: string; foreignId: string; sourceId: string; permissiveId: string }> = [
    { status: 'draft_request', isCancelled: false, label: 'draft_request', foreignId: '1001', sourceId: '2001', permissiveId: '3001' },
    { status: 'sent_to_artisans', isCancelled: false, label: 'sent_to_artisans', foreignId: '1002', sourceId: '2002', permissiveId: '3002' },
    { status: 'artisans_bidding', isCancelled: false, label: 'artisans_bidding', foreignId: '1003', sourceId: '2003', permissiveId: '3003' },
    { status: 'buyer_accepted', isCancelled: false, label: 'buyer_accepted', foreignId: '1004', sourceId: '2004', permissiveId: '3004' },
    { status: 'in_production', isCancelled: false, label: 'in_production', foreignId: '1005', sourceId: '2005', permissiveId: '3005' },
    { status: 'delivered', isCancelled: false, label: 'delivered', foreignId: '1006', sourceId: '2006', permissiveId: '3006' },
    { status: 'sent_to_artisans', isCancelled: true, label: 'cancelled (from sent_to_artisans)', foreignId: '1007', sourceId: '2007', permissiveId: '3007' },
    { status: 'artisans_bidding', isCancelled: true, label: 'cancelled (from artisans_bidding)', foreignId: '1008', sourceId: '2008', permissiveId: '3008' },
  ];

  describe('1. SEC-06 IDOR Defense & Indistinguishability Matrix across ALL Statuses', () => {
    it('establishes baseline: non-existent ID produces canonical RFC 9457 404 response', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/buyer/quote-requests/9999999/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'vcraft-session=valid-buyer-token',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const baselineBody = await res.json();
      expect(baselineBody.type).toBe('urn:vcraft:problem:RESOURCE_NOT_FOUND');
      expect(baselineBody.status).toBe(404);
      expect(baselineBody.code).toBe('RESOURCE_NOT_FOUND');
      expect(baselineBody.title).toBe('Không tìm thấy tài nguyên');
      expect(baselineBody.detail).toBe('Tài nguyên yêu cầu không tồn tại hoặc không thể truy cập.');
      expect(baselineBody.tracking_id).toBeDefined();
    });

    for (const item of allDomainStatuses) {
      it(`proves SEC-06 IDOR attempt on foreign QuoteRequest in status "${item.label}" returns indistinguishable 404 (NEVER 403)`, async () => {
        const foreignReq = createQuoteRequestInStatus(item.status, item.foreignId, '99', item.isCancelled);
        requestsStore.set(item.foreignId, foreignReq);

        identityMock.resolveSession.mockResolvedValueOnce(buyerActor); // Account 10 probing Account 99

        const res = await fetch(`${base}/buyer/quote-requests/${item.foreignId}/copy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=valid-buyer-token',
          },
          body: JSON.stringify({}),
        });

        // Strict 404 enforcement
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toContain('application/problem+json');

        const body = await res.json();
        expect(body.type).toBe('urn:vcraft:problem:RESOURCE_NOT_FOUND');
        expect(body.status).toBe(404);
        expect(body.code).toBe('RESOURCE_NOT_FOUND');
        expect(body.title).toBe('Không tìm thấy tài nguyên');
        expect(body.detail).toBe('Tài nguyên yêu cầu không tồn tại hoặc không thể truy cập.');

        // Prove 403 PERMISSION_DENIED is NOT leaked
        expect(body.code).not.toBe('PERMISSION_DENIED');
        expect(res.status).not.toBe(403);
      });
    }
  });

  describe('2. Source Entity Immutability Matrix across ALL Statuses', () => {
    for (const item of allDomainStatuses) {
      it(`proves source QuoteRequest in status "${item.label}" remains byte-for-byte immutable after copy`, async () => {
        const source = createQuoteRequestInStatus(item.status, item.sourceId, '10', item.isCancelled);
        requestsStore.set(item.sourceId, source);

        // Capture full pre-copy snapshot
        const snapshotBefore = {
          id: source.id,
          version: source.version,
          status: source.status,
          buyer_id: source.buyer_id,
          category_id: source.category_id,
          spec: source.spec,
          quantity: source.quantity,
          unit: source.unit,
          unit_set_description: source.unit_set_description,
          delivery_mode: source.delivery_mode,
          delivery_region: source.delivery_region,
          delivery_address: source.delivery_address,
          recipient_name: source.recipient_name,
          recipient_phone: source.recipient_phone,
          bidding_deadline: source.bidding_deadline?.getTime() ?? null,
          delivery_deadline: source.delivery_deadline?.getTime() ?? null,
          bidding_closed_at: source.bidding_closed_at?.getTime() ?? null,
          cancelled_at: source.cancelled_at?.getTime() ?? null,
          cancelled_by: source.cancelled_by,
          cancel_reason: source.cancel_reason,
          created_at: source.created_at.getTime(),
          updated_at: source.updated_at.getTime(),
        };

        identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

        const res = await fetch(`${base}/buyer/quote-requests/${item.sourceId}/copy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=valid-buyer-token',
          },
          body: JSON.stringify({}),
        });

        expect(res.status).toBe(201);

        // Inspect post-copy source entity in repository
        const sourceAfter = requestsStore.get(item.sourceId)!;
        const snapshotAfter = {
          id: sourceAfter.id,
          version: sourceAfter.version,
          status: sourceAfter.status,
          buyer_id: sourceAfter.buyer_id,
          category_id: sourceAfter.category_id,
          spec: sourceAfter.spec,
          quantity: sourceAfter.quantity,
          unit: sourceAfter.unit,
          unit_set_description: sourceAfter.unit_set_description,
          delivery_mode: sourceAfter.delivery_mode,
          delivery_region: sourceAfter.delivery_region,
          delivery_address: sourceAfter.delivery_address,
          recipient_name: sourceAfter.recipient_name,
          recipient_phone: sourceAfter.recipient_phone,
          bidding_deadline: sourceAfter.bidding_deadline?.getTime() ?? null,
          delivery_deadline: sourceAfter.delivery_deadline?.getTime() ?? null,
          bidding_closed_at: sourceAfter.bidding_closed_at?.getTime() ?? null,
          cancelled_at: sourceAfter.cancelled_at?.getTime() ?? null,
          cancelled_by: sourceAfter.cancelled_by,
          cancel_reason: sourceAfter.cancel_reason,
          created_at: sourceAfter.created_at.getTime(),
          updated_at: sourceAfter.updated_at.getTime(),
        };

        // Complete structural equality check
        expect(snapshotAfter).toEqual(snapshotBefore);
      });
    }
  });

  describe('3. State Permissiveness Matrix across ALL Statuses', () => {
    for (const item of allDomainStatuses) {
      it(`proves QuoteRequest in status "${item.label}" copies into a clean draft_request with version=1 and null deadlines`, async () => {
        const source = createQuoteRequestInStatus(item.status, item.permissiveId, '10', item.isCancelled);
        requestsStore.set(item.permissiveId, source);

        identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

        const res = await fetch(`${base}/buyer/quote-requests/${item.permissiveId}/copy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=valid-buyer-token',
          },
          body: JSON.stringify({}),
        });

        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.success).toBe(true);

        const draft = json.data;
        // Verify canonical draft attributes
        expect(draft.status).toBe('draft_request');
        expect(draft.version).toBe(1);
        expect(draft.buyer_id).toBe('10');
        expect(draft.bidding_deadline).toBeNull();
        expect(draft.delivery_deadline).toBeNull();
        expect(draft.bidding_closed_at).toBeNull();
        expect(draft.cancelled_at).toBeNull();

        // Verify specification and delivery fields preserved
        expect(draft.category.id).toBe('4');
        expect(draft.spec).toBe(source.spec);
        expect(draft.quantity).toBe(120);
        expect(draft.unit).toBe('piece');
        expect(draft.delivery_mode).toBe('at_buyer_address');
        expect(draft.delivery_region).toBe('HN');
        expect(draft.delivery_address).toBe('123 Phố Huế, Hai Bà Trưng, Hà Nội');
        expect(draft.recipient_name).toBe('Trần Văn B');
        expect(draft.recipient_phone).toBe('0912345678');
      });
    }
  });

  describe('4. Malicious Path & Input Fuzzing against Copy Endpoint', () => {
    const maliciousProbes = [
      { name: 'Directory Traversal', path: '..%2F..%2Fetc%2Fpasswd' },
      { name: 'SQL Injection single quote', path: "100' OR '1'='1" },
      { name: 'SQL Injection semicolon comment', path: '100; DROP TABLE quote_requests;--' },
      { name: 'XSS script injection', path: '<script>alert(1)</script>' },
      { name: 'Null byte injection', path: '100%00malicious' },
      { name: 'Extreme 64-bit BigInt', path: '9223372036854775807' },
      { name: 'Negative integer', path: '-9999' },
    ];

    for (const probe of maliciousProbes) {
      it(`handles ${probe.name} safely with uniform HTTP 404 and no 500 error`, async () => {
        identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

        const res = await fetch(`${base}/buyer/quote-requests/${encodeURIComponent(probe.path)}/copy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=valid-buyer-token',
          },
          body: JSON.stringify({}),
        });

        // Must reject cleanly with 404 (or 400), NEVER 500
        expect([400, 404]).toContain(res.status);
        const json = await res.json();
        expect(['RESOURCE_NOT_FOUND', 'INVALID_INPUT']).toContain(json.code);
        expect(res.status).not.toBe(500);
      });
    }
  });

  describe('5. High Concurrency Replay Bombing (20 Parallel Calls)', () => {
    it('handles 20 concurrent copy requests on single source without race conditions or source mutation', async () => {
      const sourceId = '4001';
      const source = createQuoteRequestInStatus('in_production', sourceId, '10', false);
      requestsStore.set(sourceId, source);

      const CONCURRENCY_LEVEL = 20;
      const promises = Array.from({ length: CONCURRENCY_LEVEL }).map(async () => {
        identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
        return fetch(`${base}/buyer/quote-requests/${sourceId}/copy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'vcraft-session=valid-buyer-token',
          },
          body: JSON.stringify({}),
        });
      });

      const responses = await Promise.all(promises);
      const generatedIds = new Set<string>();

      for (const res of responses) {
        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.data.status).toBe('draft_request');
        expect(json.data.version).toBe(1);
        generatedIds.add(json.data.id);
      }

      // Exactly 20 distinct draft entities created
      expect(generatedIds.size).toBe(CONCURRENCY_LEVEL);

      // Source entity untouched
      const sourceAfter = requestsStore.get(sourceId)!;
      expect(sourceAfter.version).toBe(4);
      expect(sourceAfter.status).toBe('in_production');
    });
  });
});
