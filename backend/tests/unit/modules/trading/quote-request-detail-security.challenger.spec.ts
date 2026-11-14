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
  IQuoteRequestRepository,
  QUOTE_REQUEST_REPOSITORY,
  QuoteRequestDetailRecord,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { GetQuoteRequestByIdUseCase } from '../../../../src/modules/trading/application/use-cases/requests/get-quote-request-by-id.use-case';
import { QuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/quote-request.controller';
import {
  Allocation,
  Quote,
  QuoteRequest,
  QuoteRequestNotFoundError,
  RequestRecipient,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import type {
  BuyerRequestDto,
  InvitedRequestBaseDto,
  InvitedRequestWithAllocationDto,
} from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';

/**
 * Helper to recursively extract all key names from a nested JSON structure.
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

// Actors for adversarial testing
const legitimateBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-legit-buyer',
  sessionLevel: 'normal',
});

const attackerBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '99',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-attacker-buyer',
  sessionLevel: 'normal',
});

const invitedArtisan200Actor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '200',
  authVersion: 1,
  sessionId: 'session-artisan-200',
  sessionLevel: 'normal',
});

const competingArtisan300Actor: AuthenticatedActor = Object.freeze({
  accountId: '30',
  role: 'artisan',
  workshopId: '300',
  authVersion: 1,
  sessionId: 'session-artisan-300',
  sessionLevel: 'normal',
});

const uninvitedArtisan999Actor: AuthenticatedActor = Object.freeze({
  accountId: '999',
  role: 'artisan',
  workshopId: '999',
  authVersion: 1,
  sessionId: 'session-uninvited-artisan',
  sessionLevel: 'normal',
});

const artisanWithoutWorkshopActor: AuthenticatedActor = Object.freeze({
  accountId: '21',
  role: 'artisan',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-artisan-no-workshop',
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
  accountId: '20',
  role: 'artisan',
  workshopId: '200',
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

const invalidRoleActor: AuthenticatedActor = Object.freeze({
  accountId: '88',
  role: 'moderator' as any,
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-invalid-role',
  sessionLevel: 'normal',
});

/**
 * Creates a complex QuoteRequest record with 6 competing artisan workshops.
 */
function createMultiCompetitorDetailRecord(
  overrides: {
    request?: Partial<Parameters<typeof QuoteRequest.reconstitute>[0]>;
    allocations?: QuoteRequestDetailRecord['allocations'];
  } = {},
): QuoteRequestDetailRecord {
  const now = new Date();
  const biddingDeadline = new Date(now.getTime() + 72 * 3600000); // +72h
  const deliveryDeadline = new Date(now.getTime() + 168 * 3600000); // +168h (> biddingDeadline + 24h)
  const bidAcceptDeadline = new Date(biddingDeadline.getTime() + 24 * 3600000);
  const committedDeliveryAt = new Date(biddingDeadline.getTime() + 48 * 3600000);

  const requestEntity = QuoteRequest.reconstitute({
    id: '100',
    buyer_id: '10',
    category_id: '1',
    spec: '100 bộ gốm sứ Bát Tràng tráng men cao cấp',
    quantity: 100,
    unit: 'set',
    unit_set_description: '1 ấm + 6 chén + 7 đĩa',
    status: 'artisans_bidding',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội, Hoàn Kiếm, Tràng Thi',
    delivery_address: 'Số 45 Ngõ 123 Phố Tràng Thi, Hoàn Kiếm, Hà Nội',
    recipient_name: 'Đoàn Thị Lan Anh',
    recipient_phone: '0912345678',
    bidding_deadline: biddingDeadline,
    delivery_deadline: deliveryDeadline,
    bidding_closed_at: null,
    version: 1,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: new Date('2026-11-10T10:00:00.000Z'),
    updated_at: new Date('2026-11-10T10:00:00.000Z'),
    ...overrides.request,
  });

  // 6 Competing workshops
  const workshops = [
    { id: '200', name: 'Xưởng Gốm Hưng Thịnh', quoteId: '701', price: 150000, maxQty: 100 },
    { id: '300', name: 'Xưởng Gốm Bát Tràng Thịnh Vượng', quoteId: '702', price: 140000, maxQty: 100 },
    { id: '400', name: 'Hợp tác xã Gốm Sứ Chu Đậu', quoteId: '703', price: 145000, maxQty: 80 },
    { id: '500', name: 'Xưởng Gốm Nghệ Nhân Trần Lộc', quoteId: '704', price: 155000, maxQty: 120 },
    { id: '600', name: 'Cơ sở Sản Xuất Gốm Phù Lãng', quoteId: '705', price: 138000, maxQty: 90 },
    { id: '700', name: 'Xưởng Mỹ Nghệ Nam Cao', quoteId: '706', price: 160000, maxQty: 100 },
  ];

  const recipients = workshops.map((ws, index) => ({
    entity: RequestRecipient.reconstitute({
      id: `50${index + 1}`,
      request_id: '100',
      workshop_id: ws.id,
      response_status: 'quoted',
      decline_reason: null,
      responded_by: ws.id,
      responded_at: new Date('2026-11-10T11:00:00.000Z'),
      sent_at: new Date('2026-11-10T10:05:00.000Z'),
      version: 1,
    }),
    workshop: {
      id: ws.id,
      name: ws.name,
    },
  }));

  const quotes = workshops.map((ws) => ({
    entity: Quote.reconstitute({
      id: ws.quoteId,
      request_id: '100',
      workshop_id: ws.id,
      unit_price: ws.price,
      max_quantity: ws.maxQty,
      bid_accept_deadline: bidAcceptDeadline,
      committed_delivery_at: committedDeliveryAt,
      status: 'active',
      version: 1,
      withdraw_reason: null,
      withdrawn_at: null,
      withdrawn_by: null,
      created_at: new Date('2026-11-10T11:00:00.000Z'),
      updated_at: new Date('2026-11-10T11:00:00.000Z'),
    }),
    workshop: {
      id: ws.id,
      name: ws.name,
      status: 'active',
    },
  }));

  return {
    entity: requestEntity,
    category: { id: '1', name: 'Ấm chén Bát Tràng' },
    recipients,
    quotes,
    allocations: overrides.allocations ?? [],
    statusLogs: [],
  };
}

describe('Challenger 2: Adversarial Security & Isolation Verification Suite (UC-18, BR-04, SEC-06)', () => {
  const identityMock = new MockIdentityContract();
  const txRunner = new MockTransactionRunner();
  const mockRepo = {
    findDetailById: vi.fn(),
  };

  let useCase: GetQuoteRequestByIdUseCase;
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
      { provide: QUOTE_REQUEST_REPOSITORY, useValue: mockRepo },
      {
        provide: GetQuoteRequestByIdUseCase,
        useFactory: (runner: any, repo: any) =>
          new GetQuoteRequestByIdUseCase(runner, repo),
        inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
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

    useCase = new GetQuoteRequestByIdUseCase(
      txRunner,
      mockRepo as unknown as IQuoteRequestRepository,
    );
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Adversarial Dimension 1: Anti-IDOR Resource Enumeration Resistance (SEC-06)', () => {
    it('EMP-SEC-01: Unit level proves identical error throwing across non-existent, foreign buyer, and uninvited artisan', async () => {
      const detailRecord = createMultiCompetitorDetailRecord();

      // 1. Non-existent record
      mockRepo.findDetailById.mockResolvedValueOnce(null);
      let nonExistentErr: any;
      try {
        await useCase.execute({ actor: legitimateBuyerActor, id: '999999' });
      } catch (err) {
        nonExistentErr = err;
      }

      // 2. Foreign non-owner buyer attacking record 100
      mockRepo.findDetailById.mockResolvedValueOnce(detailRecord);
      let foreignBuyerErr: any;
      try {
        await useCase.execute({ actor: attackerBuyerActor, id: '100' });
      } catch (err) {
        foreignBuyerErr = err;
      }

      // 3. Uninvited artisan attacking record 100
      mockRepo.findDetailById.mockResolvedValueOnce(detailRecord);
      let uninvitedArtisanErr: any;
      try {
        await useCase.execute({ actor: uninvitedArtisan999Actor, id: '100' });
      } catch (err) {
        uninvitedArtisanErr = err;
      }

      // Assert error class & code
      expect(nonExistentErr).toBeInstanceOf(QuoteRequestNotFoundError);
      expect(foreignBuyerErr).toBeInstanceOf(QuoteRequestNotFoundError);
      expect(uninvitedArtisanErr).toBeInstanceOf(QuoteRequestNotFoundError);

      expect(nonExistentErr.code).toBe('RESOURCE_NOT_FOUND');
      expect(foreignBuyerErr.code).toBe('RESOURCE_NOT_FOUND');
      expect(uninvitedArtisanErr.code).toBe('RESOURCE_NOT_FOUND');

      // Assert error message is strictly identical (zero leakage of authorization state)
      expect(nonExistentErr.message).toBe('QuoteRequest was not found.');
      expect(foreignBuyerErr.message).toBe('QuoteRequest was not found.');
      expect(uninvitedArtisanErr.message).toBe('QuoteRequest was not found.');
    });

    it('EMP-SEC-02: HTTP level proves identical 404 ProblemDetails bodies (zero enumeration oracle)', async () => {
      const detailRecord = createMultiCompetitorDetailRecord();

      // 1. Non-existent ID HTTP request
      identityMock.resolveSession.mockResolvedValueOnce(legitimateBuyerActor);
      mockRepo.findDetailById.mockResolvedValueOnce(null);
      const resNonExistent = await fetch(`${base}/quote-requests/999999`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=legit-buyer-token' },
      });
      expect(resNonExistent.status).toBe(404);
      const bodyNonExistent = await resNonExistent.json();

      // 2. Foreign non-owner Buyer HTTP request
      identityMock.resolveSession.mockResolvedValueOnce(attackerBuyerActor);
      mockRepo.findDetailById.mockResolvedValueOnce(detailRecord);
      const resForeignBuyer = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=attacker-buyer-token' },
      });
      expect(resForeignBuyer.status).toBe(404);
      const bodyForeignBuyer = await resForeignBuyer.json();

      // 3. Uninvited Artisan HTTP request
      identityMock.resolveSession.mockResolvedValueOnce(uninvitedArtisan999Actor);
      mockRepo.findDetailById.mockResolvedValueOnce(detailRecord);
      const resUninvitedArtisan = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=uninvited-artisan-token' },
      });
      expect(resUninvitedArtisan.status).toBe(404);
      const bodyUninvitedArtisan = await resUninvitedArtisan.json();

      // Verify uniform RFC 9457 Problem Details schema
      expect(bodyNonExistent.code).toBe('RESOURCE_NOT_FOUND');
      expect(bodyNonExistent.status).toBe(404);
      expect(bodyNonExistent.title).toBe('Không tìm thấy tài nguyên');
      expect(bodyNonExistent.detail).toBe('Tài nguyên yêu cầu không tồn tại hoặc không thể truy cập.');
      expect(bodyNonExistent.type).toBe('urn:vcraft:problem:RESOURCE_NOT_FOUND');
      expect(typeof bodyNonExistent.tracking_id).toBe('string');

      // Compare semantic problem bodies: An attacker cannot distinguish existence vs uninvited/unauthorized status
      const sanitizeProblem = (p: any) => ({
        type: p.type,
        title: p.title,
        status: p.status,
        detail: p.detail,
        code: p.code,
      });

      expect(sanitizeProblem(bodyForeignBuyer)).toEqual(sanitizeProblem(bodyNonExistent));
      expect(sanitizeProblem(bodyUninvitedArtisan)).toEqual(sanitizeProblem(bodyNonExistent));
    });
  });

  describe('Adversarial Dimension 2: Deep PII & Multi-Competitor Isolation (5+ Bidders) (BR-04, SEC-04)', () => {
    it('EMP-SEC-03: Artisan without Allocation receives ZERO PII keys and ZERO competitor data among 6 bidders', async () => {
      const multiBidRecord = createMultiCompetitorDetailRecord({ allocations: [] });
      identityMock.resolveSession.mockResolvedValueOnce(invitedArtisan200Actor);
      mockRepo.findDetailById.mockResolvedValueOnce(multiBidRecord);

      const res = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=artisan-200-token' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      const data = json.data;

      // 1. Deep scan of ALL keys in the entire JSON tree
      const allKeys = extractAllKeys(data);
      expect(allKeys.has('recipient_name')).toBe(false);
      expect(allKeys.has('recipient_phone')).toBe(false);
      expect(allKeys.has('delivery_address')).toBe(false);
      expect(allKeys.has('own_allocation_id')).toBe(false);
      expect(allKeys.has('buyer_id')).toBe(false);
      expect(allKeys.has('quotes')).toBe(false);
      expect(allKeys.has('recipients')).toBe(false);
      expect(allKeys.has('allocations')).toBe(false);

      // 2. Deep string scan of serialized response against Buyer PII
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain('Đoàn Thị Lan Anh');
      expect(serialized).not.toContain('0912345678');
      expect(serialized).not.toContain('Tràng Thi, Hoàn Kiếm');

      // 3. Deep string scan against ALL 5 competitor workshops
      const competitorWorkshops = [
        'Xưởng Gốm Bát Tràng Thịnh Vượng',
        'Hợp tác xã Gốm Sứ Chu Đậu',
        'Xưởng Gốm Nghệ Nhân Trần Lộc',
        'Cơ sở Sản Xuất Gốm Phù Lãng',
        'Xưởng Mỹ Nghệ Nam Cao',
      ];
      for (const compName of competitorWorkshops) {
        expect(serialized).not.toContain(compName);
      }

      // 4. Deep scan against competitor quote IDs & prices
      const competitorQuoteIds = ['702', '703', '704', '705', '706'];
      for (const quoteId of competitorQuoteIds) {
        expect(serialized).not.toContain(`"${quoteId}"`);
      }

      const competitorPrices = [140000, 145000, 155000, 138000, 160000];
      for (const price of competitorPrices) {
        expect(serialized).not.toContain(String(price));
      }

      // 5. Artisan 200 MUST ONLY see their own quote and recipient
      expect(data.own_recipient.workshop.id).toBe('200');
      expect(data.own_recipient.workshop.name).toBe('Xưởng Gốm Hưng Thịnh');
      expect(data.own_quote.id).toBe('701');
      expect(data.own_quote.unit_price).toBe(150000);
      expect(data.own_quote.workshop.id).toBe('200');
    });

    it('EMP-SEC-04: Artisan with Allocation unmasks Buyer PII while KEEPING competitor data 100% isolated', async () => {
      const wonAllocation = {
        entity: Allocation.reconstitute({
          id: '901',
          request_id: '100',
          workshop_id: '200',
          quote_id: '701',
          quantity: 100,
          unit_price: 150000,
          committed_delivery_at: new Date('2026-11-20T10:00:00.000Z'),
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
          created_at: new Date('2026-11-12T10:00:00.000Z'),
          updated_at: new Date('2026-11-12T10:00:00.000Z'),
        }),
      };

      const multiBidRecord = createMultiCompetitorDetailRecord({
        allocations: [wonAllocation],
      });

      identityMock.resolveSession.mockResolvedValueOnce(invitedArtisan200Actor);
      mockRepo.findDetailById.mockResolvedValueOnce(multiBidRecord);

      const res = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=artisan-200-token' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      const data = json.data as InvitedRequestWithAllocationDto;

      // 1. Buyer PII is unmasked for winning artisan
      expect(data.recipient_name).toBe('Đoàn Thị Lan Anh');
      expect(data.recipient_phone).toBe('0912345678');
      expect(data.delivery_address).toBe('Số 45 Ngõ 123 Phố Tràng Thi, Hoàn Kiếm, Hà Nội');
      expect(data.own_allocation_id).toBe('901');

      // 2. Competitor data STILL 100% isolated
      const allKeys = extractAllKeys(data);
      expect(allKeys.has('quotes')).toBe(false);
      expect(allKeys.has('recipients')).toBe(false);
      expect(allKeys.has('allocations')).toBe(false);

      const serialized = JSON.stringify(data);
      const competitorWorkshops = [
        'Xưởng Gốm Bát Tràng Thịnh Vượng',
        'Hợp tác xã Gốm Sứ Chu Đậu',
        'Xưởng Gốm Nghệ Nhân Trần Lộc',
        'Cơ sở Sản Xuất Gốm Phù Lãng',
        'Xưởng Mỹ Nghệ Nam Cao',
      ];
      for (const compName of competitorWorkshops) {
        expect(serialized).not.toContain(compName);
      }

      const competitorPrices = [140000, 145000, 155000, 138000, 160000];
      for (const price of competitorPrices) {
        expect(serialized).not.toContain(String(price));
      }
    });

    it('EMP-SEC-05: Losing competing Artisan 300 querying the same allocated record CANNOT see Buyer PII or winner allocation', async () => {
      // Record has allocation won by Workshop 200
      const wonAllocation = {
        entity: Allocation.reconstitute({
          id: '901',
          request_id: '100',
          workshop_id: '200',
          quote_id: '701',
          quantity: 100,
          unit_price: 150000,
          committed_delivery_at: new Date('2026-11-20T10:00:00.000Z'),
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
          created_at: new Date('2026-11-12T10:00:00.000Z'),
          updated_at: new Date('2026-11-12T10:00:00.000Z'),
        }),
      };

      const multiBidRecord = createMultiCompetitorDetailRecord({
        allocations: [wonAllocation],
      });

      // Artisan 300 queries
      identityMock.resolveSession.mockResolvedValueOnce(competingArtisan300Actor);
      mockRepo.findDetailById.mockResolvedValueOnce(multiBidRecord);

      const res = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=artisan-300-token' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      const data = json.data;

      // Artisan 300 has NO allocation -> PII remains strictly masked
      const allKeys = extractAllKeys(data);
      expect(allKeys.has('recipient_name')).toBe(false);
      expect(allKeys.has('recipient_phone')).toBe(false);
      expect(allKeys.has('delivery_address')).toBe(false);
      expect(allKeys.has('own_allocation_id')).toBe(false);

      // Cannot see Workshop 200's winning allocation ID '901'
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain('901');
      expect(serialized).not.toContain('Xưởng Gốm Hưng Thịnh');
      expect(serialized).not.toContain('Đoàn Thị Lan Anh');

      // Only sees own quote 702
      expect(data.own_recipient.workshop.id).toBe('300');
      expect(data.own_quote.id).toBe('702');
      expect(data.own_quote.unit_price).toBe(140000);
    });
  });

  describe('Adversarial Dimension 3: Session Security & RBAC Escalation Defenses (SEC-01, SEC-05)', () => {
    it('EMP-SEC-06: temp_password session blocked across Buyer, Artisan, and Admin (HTTP 403 TEMP_PASSWORD_RESTRICTED)', async () => {
      // 1. Buyer temp_password
      identityMock.resolveSession.mockResolvedValueOnce(tempPasswordBuyerActor);
      const resBuyer = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=temp-buyer-token' },
      });
      expect(resBuyer.status).toBe(403);
      const jsonBuyer = await resBuyer.json();
      expect(jsonBuyer.code).toBe('TEMP_PASSWORD_RESTRICTED');

      // 2. Artisan temp_password
      identityMock.resolveSession.mockResolvedValueOnce(tempPasswordArtisanActor);
      const resArtisan = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=temp-artisan-token' },
      });
      expect(resArtisan.status).toBe(403);
      const jsonArtisan = await resArtisan.json();
      expect(jsonArtisan.code).toBe('TEMP_PASSWORD_RESTRICTED');

      // 3. Admin temp_password
      identityMock.resolveSession.mockResolvedValueOnce(tempPasswordAdminActor);
      const resAdmin = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=temp-admin-token' },
      });
      expect(resAdmin.status).toBe(403);
      const jsonAdmin = await resAdmin.json();
      expect(jsonAdmin.code).toBe('TEMP_PASSWORD_RESTRICTED');
    });

    it('EMP-SEC-07: Artisan account without workshopId is denied with HTTP 403 PERMISSION_DENIED', async () => {
      // 1. Unit layer verification
      const detailRecord = createMultiCompetitorDetailRecord();
      mockRepo.findDetailById.mockResolvedValueOnce(detailRecord);

      let unitError: any;
      try {
        await useCase.execute({
          actor: artisanWithoutWorkshopActor,
          id: '100',
        });
      } catch (err) {
        unitError = err;
      }

      expect(unitError).toBeInstanceOf(TradingPermissionDeniedError);
      expect(unitError.code).toBe('PERMISSION_DENIED');
      expect(unitError.message).toBe('Artisan actor must belong to an active workshop.');

      // 2. HTTP layer verification
      identityMock.resolveSession.mockResolvedValueOnce(artisanWithoutWorkshopActor);
      mockRepo.findDetailById.mockResolvedValueOnce(detailRecord);

      const res = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=artisan-no-workshop-token' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
      expect(json.status).toBe(403);
      expect(json.title).toBe('Không có quyền');
      expect(json.detail).toBe('Bạn không có quyền thực hiện thao tác này.');
    });

    it('EMP-SEC-08: Invalid or forged role in session is denied by RolesGuard with HTTP 403 PERMISSION_DENIED', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(invalidRoleActor);

      const res = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=invalid-role-token' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('EMP-SEC-09: Unauthenticated request missing session cookie returns HTTP 401 AUTHENTICATION_REQUIRED', async () => {
      const res = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });

  describe('Adversarial Dimension 4: Post-Lifecycle Contact Visibility Persistence (BR-04)', () => {
    const wonAllocation = {
      entity: Allocation.reconstitute({
        id: '901',
        request_id: '100',
        workshop_id: '200',
        quote_id: '701',
        quantity: 100,
        unit_price: 150000,
        committed_delivery_at: new Date('2026-11-20T10:00:00.000Z'),
        status: 'handed_over',
        version: 2,
        started_at: new Date('2026-11-12T10:00:00.000Z'),
        started_by: '20',
        handed_over_at: new Date('2026-11-19T10:00:00.000Z'),
        handed_over_by: '20',
        delivery_note: 'Đã hoàn tất giao hàng',
        admin_handed_over: false,
        admin_delivery_evidence: null,
        admin_handover_reason: null,
        admin_handover_actual_at: null,
        created_at: new Date('2026-11-12T10:00:00.000Z'),
        updated_at: new Date('2026-11-19T10:00:00.000Z'),
      }),
    };

    it('EMP-SEC-10: In DELIVERED status, winner Artisan preserves contact visibility, but losers/uninvited/foreign buyers remain blocked', async () => {
      const deliveredRecord = createMultiCompetitorDetailRecord({
        request: { status: 'delivered' },
        allocations: [wonAllocation],
      });

      // 1. Winner Artisan (Workshop 200) -> Contact remains visible
      identityMock.resolveSession.mockResolvedValueOnce(invitedArtisan200Actor);
      mockRepo.findDetailById.mockResolvedValueOnce(deliveredRecord);
      const resWinner = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=winner-token' },
      });
      expect(resWinner.status).toBe(200);
      const jsonWinner = await resWinner.json();
      expect(jsonWinner.data.status).toBe('delivered');
      expect(jsonWinner.data.recipient_name).toBe('Đoàn Thị Lan Anh');
      expect(jsonWinner.data.recipient_phone).toBe('0912345678');
      expect(jsonWinner.data.delivery_address).toBe('Số 45 Ngõ 123 Phố Tràng Thi, Hoàn Kiếm, Hà Nội');
      expect(jsonWinner.data.own_allocation_id).toBe('901');

      // 2. Competing Artisan (Workshop 300 without allocation) -> Contact remains strictly masked
      identityMock.resolveSession.mockResolvedValueOnce(competingArtisan300Actor);
      mockRepo.findDetailById.mockResolvedValueOnce(deliveredRecord);
      const resLoser = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=loser-token' },
      });
      expect(resLoser.status).toBe(200);
      const jsonLoser = await resLoser.json();
      expect(jsonLoser.data.status).toBe('delivered');
      const loserKeys = extractAllKeys(jsonLoser.data);
      expect(loserKeys.has('recipient_name')).toBe(false);
      expect(loserKeys.has('recipient_phone')).toBe(false);
      expect(loserKeys.has('delivery_address')).toBe(false);
      expect(loserKeys.has('own_allocation_id')).toBe(false);

      // 3. Foreign Buyer -> Uniform 404
      identityMock.resolveSession.mockResolvedValueOnce(attackerBuyerActor);
      mockRepo.findDetailById.mockResolvedValueOnce(deliveredRecord);
      const resBuyer = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=attacker-buyer-token' },
      });
      expect(resBuyer.status).toBe(404);
      expect((await resBuyer.json()).code).toBe('RESOURCE_NOT_FOUND');

      // 4. Uninvited Artisan -> Uniform 404
      identityMock.resolveSession.mockResolvedValueOnce(uninvitedArtisan999Actor);
      mockRepo.findDetailById.mockResolvedValueOnce(deliveredRecord);
      const resUninvited = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=uninvited-token' },
      });
      expect(resUninvited.status).toBe(404);
      expect((await resUninvited.json()).code).toBe('RESOURCE_NOT_FOUND');
    });

    it('EMP-SEC-11: In CANCELLED status, winner Artisan preserves contact visibility, but losers/uninvited/foreign buyers remain blocked', async () => {
      const cancelledRecord = createMultiCompetitorDetailRecord({
        request: {
          status: 'cancelled',
          cancelled_at: new Date('2026-11-15T10:00:00.000Z'),
          cancelled_by: '10',
          cancel_reason: 'Người mua quyết định hủy do kế hoạch thay đổi',
        },
        allocations: [wonAllocation],
      });

      // 1. Winner Artisan (Workshop 200) -> Contact remains visible
      identityMock.resolveSession.mockResolvedValueOnce(invitedArtisan200Actor);
      mockRepo.findDetailById.mockResolvedValueOnce(cancelledRecord);
      const resWinner = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=winner-token' },
      });
      expect(resWinner.status).toBe(200);
      const jsonWinner = await resWinner.json();
      expect(jsonWinner.data.status).toBe('cancelled');
      expect(jsonWinner.data.recipient_name).toBe('Đoàn Thị Lan Anh');
      expect(jsonWinner.data.recipient_phone).toBe('0912345678');
      expect(jsonWinner.data.delivery_address).toBe('Số 45 Ngõ 123 Phố Tràng Thi, Hoàn Kiếm, Hà Nội');
      expect(jsonWinner.data.own_allocation_id).toBe('901');

      // 2. Competing Artisan (Workshop 300 without allocation) -> Contact remains strictly masked
      identityMock.resolveSession.mockResolvedValueOnce(competingArtisan300Actor);
      mockRepo.findDetailById.mockResolvedValueOnce(cancelledRecord);
      const resLoser = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=loser-token' },
      });
      expect(resLoser.status).toBe(200);
      const jsonLoser = await resLoser.json();
      expect(jsonLoser.data.status).toBe('cancelled');
      const loserKeys = extractAllKeys(jsonLoser.data);
      expect(loserKeys.has('recipient_name')).toBe(false);
      expect(loserKeys.has('recipient_phone')).toBe(false);
      expect(loserKeys.has('delivery_address')).toBe(false);
      expect(loserKeys.has('own_allocation_id')).toBe(false);

      // 3. Foreign Buyer -> Uniform 404
      identityMock.resolveSession.mockResolvedValueOnce(attackerBuyerActor);
      mockRepo.findDetailById.mockResolvedValueOnce(cancelledRecord);
      const resBuyer = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=attacker-buyer-token' },
      });
      expect(resBuyer.status).toBe(404);
      expect((await resBuyer.json()).code).toBe('RESOURCE_NOT_FOUND');

      // 4. Uninvited Artisan -> Uniform 404
      identityMock.resolveSession.mockResolvedValueOnce(uninvitedArtisan999Actor);
      mockRepo.findDetailById.mockResolvedValueOnce(cancelledRecord);
      const resUninvited = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=uninvited-token' },
      });
      expect(resUninvited.status).toBe(404);
      expect((await resUninvited.json()).code).toBe('RESOURCE_NOT_FOUND');
    });
  });
});
