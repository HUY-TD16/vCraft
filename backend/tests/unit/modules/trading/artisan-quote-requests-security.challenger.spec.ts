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
import { ListArtisanQuoteRequestsUseCase } from '../../../../src/modules/trading/application/use-cases/requests/list-artisan-quote-requests.use-case';
import { ArtisanQuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/artisan-quote-request.controller';
import { PrismaQuoteRequestRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository';
import { QuoteRequestMapper } from '../../../../src/modules/trading/adapters/persistence/mappers/quote-request.mapper';
import {
  QuoteRequest,
  TradingDomainError,
  TradingPermissionDeniedError,
  InvalidTradingInputError,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import type {
  InvitedRequestBaseDto,
  InvitedRequestDto,
  InvitedRequestWithAllocationDto,
  QuoteDto,
  RecipientDto,
} from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';

// Test Actors
const artisanActor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '200',
  authVersion: 1,
  sessionId: 'session-artisan-1',
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

const tempPasswordArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '22',
  role: 'artisan',
  workshopId: '200',
  authVersion: 1,
  sessionId: 'session-temp-artisan',
  sessionLevel: 'temp_password',
});

const buyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-1',
  sessionLevel: 'normal',
});

const adminActor: AuthenticatedActor = Object.freeze({
  accountId: '99',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-admin-1',
  sessionLevel: 'normal',
});

function createSampleInvitedRequestDto(
  overrides: Partial<InvitedRequestDto> = {},
): InvitedRequestDto {
  return Object.freeze({
    id: '10001',
    status: 'artisans_bidding',
    version: 1,
    category: { id: '3', name: 'Ấm chén Bát Tràng' },
    spec: 'Ấm chén tử sa men rạn cao cấp',
    quantity: 100,
    unit: 'set',
    unit_set_description: 'Bộ ấm chén 6 chén 1 ấm',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội, Gia Lâm, Bát Tràng',
    bidding_deadline: '2026-12-01T10:00:00.000Z',
    delivery_deadline: '2026-12-15T10:00:00.000Z',
    bidding_closed_at: null,
    is_bidding_open: true,
    cancelled_at: null,
    created_at: '2026-11-10T10:00:00.000Z',
    updated_at: '2026-11-10T10:00:00.000Z',
    own_recipient: {
      id: '5001',
      request_id: '10001',
      workshop: { id: '200', name: 'Xưởng Gốm Bát Tràng Hưng Thịnh' },
      response_status: 'pending',
      version: 1,
      sent_at: '2026-11-10T10:05:00.000Z',
      responded_at: null,
      decline_reason: null,
      eligibility_labels: [],
    },
    own_quote: null,
    ...overrides,
  } as InvitedRequestDto);
}

const identityMock = new MockIdentityContract();

const mockRepo = {
  findArtisanQuoteRequests: vi.fn(),
  findBuyerQuoteRequests: vi.fn(),
  createDraft: vi.fn(),
};

class TestIdentityModule {}
Module({
  providers: [{ provide: IDENTITY_CONTRACT, useValue: identityMock }],
  exports: [IDENTITY_CONTRACT],
})(TestIdentityModule);

class TestTradingSecurityModule {}
Module({
  imports: [AppConfigModule, SecurityModule.register([TestIdentityModule])],
  controllers: [ArtisanQuoteRequestController],
  providers: [
    { provide: TRANSACTION_RUNNER, useClass: MockTransactionRunner },
    { provide: QUOTE_REQUEST_REPOSITORY, useValue: mockRepo },
    {
      provide: ListArtisanQuoteRequestsUseCase,
      useFactory: (txRunner: any, repo: any) =>
        new ListArtisanQuoteRequestsUseCase(txRunner, repo),
      inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
    },
  ],
})(TestTradingSecurityModule);

describe('Artisan Quote Requests Security & Isolation Challenger (Adversarial Suite)', () => {
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
      TestTradingSecurityModule,
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

  describe('1. IDOR and Workshop Isolation Challenges', () => {
    it('TC-SEC-01: Parameter pollution / tampering with workshop_id in query string is rejected with 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);

      // Attacker tries to inject workshop_id of another workshop via query
      const res = await fetch(
        `${base}/artisan/quote-requests?workshop_id=999`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-artisan-token' },
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors).toBeDefined();
      expect(json.errors[0].field).toBe('/workshop_id');
      // Verify repository was never called
      expect(mockRepo.findArtisanQuoteRequests).not.toHaveBeenCalled();
    });

    it('TC-SEC-02: Parameter pollution with workshopId (camelCase) is also rejected with 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);

      const res = await fetch(
        `${base}/artisan/quote-requests?workshopId=999`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-artisan-token' },
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors[0].field).toBe('/workshopId');
      expect(mockRepo.findArtisanQuoteRequests).not.toHaveBeenCalled();
    });

    it('TC-SEC-03: Repository strictly enforces workshop_id = BigInt(actor.workshopId) in SQL/Prisma where clause and relational includes', async () => {
      // Direct adversarial audit of PrismaQuoteRequestRepository
      const dummyClient = {
        quoteRequest: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      const mockTxRunner = {
        getClient: vi.fn().mockReturnValue(dummyClient),
      } as any;

      const repo = new PrismaQuoteRequestRepository(mockTxRunner);

      const queryInput = {
        workshopId: '200',
        page: 1,
        limit: 10,
        status: 'artisans_bidding' as const,
        responseStatus: 'pending' as const,
        sortBy: 'created_at' as const,
        order: 'desc' as const,
        search: 'bình gốm',
        now: new Date('2026-11-12T10:00:00Z'),
      };

      await repo.findArtisanQuoteRequests(queryInput, {} as any);

      // Verify Prisma client findMany call arguments
      expect(dummyClient.quoteRequest.findMany).toHaveBeenCalledTimes(1);
      const callArgs = dummyClient.quoteRequest.findMany.mock.calls[0][0];

      // 1. Where clause must enforce workshop_id BigInt(200) inside requestRecipients.some
      expect(callArgs.where).toBeDefined();
      const andConditions = callArgs.where.AND;
      expect(Array.isArray(andConditions)).toBe(true);

      const recipientFilter = andConditions.find(
        (c: any) => c.requestRecipients !== undefined,
      );
      expect(recipientFilter).toBeDefined();
      expect(recipientFilter.requestRecipients.some.workshop_id).toBe(200n);
      expect(recipientFilter.requestRecipients.some.response_status).toBe('pending');

      // 2. Relational includes MUST strictly filter requestRecipients, quotes, and allocations by workshop_id: 200n
      expect(callArgs.include.requestRecipients.where).toEqual({ workshop_id: 200n });
      expect(callArgs.include.quotes.where).toEqual({ workshop_id: 200n });
      expect(callArgs.include.allocations.where).toEqual({ workshop_id: 200n });
    });

    it('TC-SEC-04: Numeric ID search does NOT bypass workshop isolation in PrismaQuoteRequestRepository', async () => {
      const dummyClient = {
        quoteRequest: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      const mockTxRunner = {
        getClient: vi.fn().mockReturnValue(dummyClient),
      } as any;

      const repo = new PrismaQuoteRequestRepository(mockTxRunner);

      // Artisan searches directly for QuoteRequest ID 99999 belonging to another workshop
      await repo.findArtisanQuoteRequests(
        {
          workshopId: '200',
          page: 1,
          limit: 10,
          search: '99999',
          now: new Date('2026-11-12T10:00:00Z'),
        },
        {} as any,
      );

      const callArgs = dummyClient.quoteRequest.findMany.mock.calls[0][0];
      const andConditions = callArgs.where.AND;

      // Ensure the search clause is AND'ed with the recipient filter, NEVER replacing it
      const recipientFilter = andConditions.find(
        (c: any) => c.requestRecipients !== undefined,
      );
      expect(recipientFilter.requestRecipients.some.workshop_id).toBe(200n);

      const searchFilter = andConditions.find((c: any) => c.OR !== undefined);
      expect(searchFilter).toBeDefined();
      // Search condition checks id: 99999n in OR, but composite query is AND'ed with workshop_id = 200n
      expect(searchFilter.OR).toContainEqual({ id: 99999n });
    });

    it('TC-SEC-05: Artisan account with workshopId === null is blocked with 403 PERMISSION_DENIED over HTTP', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(
        artisanWithoutWorkshopActor,
      );

      const res = await fetch(`${base}/artisan/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=artisan-no-workshop-token' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
      expect(mockRepo.findArtisanQuoteRequests).not.toHaveBeenCalled();
    });

    it('TC-SEC-06: Artisan account with workshopId === null is blocked at UseCase level with TradingPermissionDeniedError', async () => {
      const txRunner = new MockTransactionRunner();
      const useCase = new ListArtisanQuoteRequestsUseCase(
        txRunner as any,
        mockRepo as any,
      );

      await expect(
        useCase.execute({
          actor: artisanWithoutWorkshopActor,
          query: {},
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('TC-SEC-07: Actor with sessionLevel === "temp_password" is blocked with 403 TEMP_PASSWORD_RESTRICTED over HTTP', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(
        tempPasswordArtisanActor,
      );

      const res = await fetch(`${base}/artisan/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=temp-password-artisan-token' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
      expect(mockRepo.findArtisanQuoteRequests).not.toHaveBeenCalled();
    });

    it('TC-SEC-08: Actor with sessionLevel === "temp_password" is blocked at UseCase level with TradingDomainError', async () => {
      const txRunner = new MockTransactionRunner();
      const useCase = new ListArtisanQuoteRequestsUseCase(
        txRunner as any,
        mockRepo as any,
      );

      await expect(
        useCase.execute({
          actor: tempPasswordArtisanActor,
          query: {},
        }),
      ).rejects.toThrow(TradingDomainError);
    });

    it('TC-SEC-09: Buyer role calling artisan route is blocked with HTTP 403 PERMISSION_DENIED', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/artisan/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=buyer-token' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
      expect(mockRepo.findArtisanQuoteRequests).not.toHaveBeenCalled();
    });

    it('TC-SEC-10: Buyer role calling UseCase directly is blocked with TradingPermissionDeniedError', async () => {
      const txRunner = new MockTransactionRunner();
      const useCase = new ListArtisanQuoteRequestsUseCase(
        txRunner as any,
        mockRepo as any,
      );

      await expect(
        useCase.execute({
          actor: buyerActor,
          query: {},
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('TC-SEC-11: Admin role calling artisan route is blocked with HTTP 403 PERMISSION_DENIED', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(adminActor);

      const res = await fetch(`${base}/artisan/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=admin-token' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
      expect(mockRepo.findArtisanQuoteRequests).not.toHaveBeenCalled();
    });

    it('TC-SEC-12: Admin role calling UseCase directly is blocked with TradingPermissionDeniedError', async () => {
      const txRunner = new MockTransactionRunner();
      const useCase = new ListArtisanQuoteRequestsUseCase(
        txRunner as any,
        mockRepo as any,
      );

      await expect(
        useCase.execute({
          actor: adminActor,
          query: {},
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('TC-SEC-13: Unauthenticated caller is blocked with HTTP 401 AUTHENTICATION_REQUIRED', async () => {
      const res = await fetch(`${base}/artisan/quote-requests`, {
        method: 'GET',
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
      expect(mockRepo.findArtisanQuoteRequests).not.toHaveBeenCalled();
    });
  });

  describe('2. Data Masking (BR-04) & Zero-Knowledge Challenges', () => {
    const sensitiveEntity = QuoteRequest.reconstitute({
      id: '10001',
      buyer_id: '10',
      category_id: '3',
      spec: 'Bình hoa men rạn Bát Tràng thế kỷ 18',
      quantity: 50,
      unit: 'piece',
      unit_set_description: null,
      status: 'artisans_bidding',
      delivery_mode: 'at_buyer_address',
      delivery_region: 'Hà Nội, Gia Lâm',
      delivery_address: 'Số 99 Hàng Gai, Hoàn Kiếm, Hà Nội (Địa Chỉ Mật)',
      recipient_name: 'Nguyễn Văn Secret (Tên Mật)',
      recipient_phone: '0988776655 (SĐT Mật)',
      bidding_deadline: new Date('2026-12-01T10:00:00Z'),
      delivery_deadline: new Date('2026-12-15T10:00:00Z'),
      bidding_closed_at: null,
      version: 1,
      cancelled_at: null,
      cancelled_by: null,
      cancel_reason: null,
      created_at: new Date('2026-11-10T10:00:00Z'),
      updated_at: new Date('2026-11-10T10:00:00Z'),
    });

    const ownRecipientDto: RecipientDto = {
      id: '5001',
      request_id: '10001',
      workshop: { id: '200', name: 'Xưởng Gốm An Thịnh' },
      response_status: 'quoted',
      version: 1,
      sent_at: '2026-11-10T10:00:00.000Z',
      responded_at: '2026-11-11T10:00:00.000Z',
      decline_reason: null,
      eligibility_labels: [],
    };

    const ownQuoteDto: QuoteDto = {
      id: '7001',
      request_id: '10001',
      workshop: { id: '200', name: 'Xưởng Gốm An Thịnh' },
      unit_price: 250000,
      max_quantity: 50,
      bid_accept_deadline: '2026-12-05T10:00:00.000Z',
      committed_delivery_at: '2026-12-14T10:00:00.000Z',
      status: 'active',
      version: 1,
      withdraw_reason: null,
      withdrawn_at: null,
      is_eligible: true,
      ineligible_reasons: [],
      created_at: '2026-11-11T10:00:00.000Z',
      updated_at: '2026-11-11T10:00:00.000Z',
    };

    it('TC-SEC-14: When no allocation is won (ownAllocationId === null/undefined), sensitive fields are absent from object and JSON', () => {
      const dto = QuoteRequestMapper.toInvitedRequestDto(sensitiveEntity, {
        category: { id: '3', name: 'Gốm Bát Tràng' },
        now: new Date('2026-11-12T10:00:00Z'),
        ownRecipient: ownRecipientDto,
        ownQuote: ownQuoteDto,
        ownAllocationId: null,
      });

      // 1. In-memory object properties
      expect((dto as any).recipient_name).toBeUndefined();
      expect((dto as any).recipient_phone).toBeUndefined();
      expect((dto as any).delivery_address).toBeUndefined();
      expect((dto as any).own_allocation_id).toBeUndefined();
      expect((dto as any).buyer_id).toBeUndefined();

      // 2. Object keys check (keys must NOT exist)
      const keys = Object.keys(dto);
      expect(keys).not.toContain('recipient_name');
      expect(keys).not.toContain('recipient_phone');
      expect(keys).not.toContain('delivery_address');
      expect(keys).not.toContain('own_allocation_id');
      expect(keys).not.toContain('buyer_id');

      // 3. Stringified JSON wire format check
      const jsonString = JSON.stringify(dto);
      expect(jsonString).not.toContain('recipient_name');
      expect(jsonString).not.toContain('recipient_phone');
      expect(jsonString).not.toContain('delivery_address');
      expect(jsonString).not.toContain('own_allocation_id');
      expect(jsonString).not.toContain('buyer_id');
      expect(jsonString).not.toContain('Nguyễn Văn Secret');
      expect(jsonString).not.toContain('0988776655');
      expect(jsonString).not.toContain('Số 99 Hàng Gai');

      // Non-sensitive regional data remains present
      expect(dto.delivery_region).toBe('Hà Nội, Gia Lâm');
      expect(dto.delivery_mode).toBe('at_buyer_address');
      expect(dto.own_recipient).toBe(ownRecipientDto);
      expect(dto.own_quote).toBe(ownQuoteDto);
    });

    it('TC-SEC-15: When allocation is won (ownAllocationId is present), contact fields are present, but buyer_id is still omitted', () => {
      const dto = QuoteRequestMapper.toInvitedRequestDto(sensitiveEntity, {
        category: { id: '3', name: 'Gốm Bát Tràng' },
        now: new Date('2026-11-12T10:00:00Z'),
        ownRecipient: ownRecipientDto,
        ownQuote: ownQuoteDto,
        ownAllocationId: '8001',
      }) as InvitedRequestWithAllocationDto;

      // Unmasked fields are populated
      expect(dto.own_allocation_id).toBe('8001');
      expect(dto.recipient_name).toBe('Nguyễn Văn Secret (Tên Mật)');
      expect(dto.recipient_phone).toBe('0988776655 (SĐT Mật)');
      expect(dto.delivery_address).toBe('Số 99 Hàng Gai, Hoàn Kiếm, Hà Nội (Địa Chỉ Mật)');

      // JSON string contains unmasked fields
      const jsonString = JSON.stringify(dto);
      expect(jsonString).toContain('"own_allocation_id":"8001"');
      expect(jsonString).toContain('Nguyễn Văn Secret');
      expect(jsonString).toContain('0988776655');
      expect(jsonString).toContain('Số 99 Hàng Gai');

      // BUT buyer_id remains strictly omitted
      expect((dto as any).buyer_id).toBeUndefined();
      expect(jsonString).not.toContain('buyer_id');
    });

    it('TC-SEC-16: Multi-workshop competitor isolation: Competitor won allocation, artisan did NOT win -> artisan remains masked', () => {
      // Scenario: QuoteRequest 10001 is won by competitor Workshop 300.
      // Artisan from Workshop 200 views the QuoteRequest.
      // Because Workshop 200 has NO allocation (ownAllocationId: null),
      // Workshop 200 MUST NOT see the contact info even though the request status is buyer_accepted or in_production.
      const acceptedEntity = QuoteRequest.reconstitute({
        id: '10001',
        buyer_id: '10',
        category_id: '3',
        spec: 'Bình hoa men rạn Bát Tràng',
        quantity: 50,
        unit: 'piece',
        unit_set_description: null,
        status: 'buyer_accepted',
        delivery_mode: 'at_buyer_address',
        delivery_region: 'Hà Nội, Gia Lâm',
        delivery_address: 'Số 99 Hàng Gai, Hoàn Kiếm, Hà Nội',
        recipient_name: 'Nguyễn Văn B',
        recipient_phone: '0912345678',
        bidding_deadline: new Date('2026-12-01T10:00:00Z'),
        delivery_deadline: new Date('2026-12-15T10:00:00Z'),
        bidding_closed_at: new Date('2026-11-15T10:00:00Z'),
        version: 2,
        cancelled_at: null,
        cancelled_by: null,
        cancel_reason: null,
        created_at: new Date('2026-11-10T10:00:00Z'),
        updated_at: new Date('2026-11-15T10:00:00Z'),
      });

      const unallocatedDto = QuoteRequestMapper.toInvitedRequestDto(acceptedEntity, {
        category: { id: '3', name: 'Gốm Bát Tràng' },
        now: new Date('2026-11-16T10:00:00Z'),
        ownRecipient: ownRecipientDto,
        ownQuote: ownQuoteDto,
        ownAllocationId: null, // Workshop 200 did not win
      });

      expect((unallocatedDto as any).recipient_name).toBeUndefined();
      expect((unallocatedDto as any).recipient_phone).toBeUndefined();
      expect((unallocatedDto as any).delivery_address).toBeUndefined();
      expect((unallocatedDto as any).own_allocation_id).toBeUndefined();

      const jsonString = JSON.stringify(unallocatedDto);
      expect(jsonString).not.toContain('recipient_name');
      expect(jsonString).not.toContain('delivery_address');
    });

    it('TC-SEC-17: Competitor quotes and other recipients are NEVER included under any circumstances', () => {
      const dto = createSampleInvitedRequestDto();

      // Only own_recipient and own_quote exist
      expect(dto.own_recipient).toBeDefined();
      expect(dto.own_recipient.workshop.id).toBe('200');

      // Competitor collections do not exist on the type or object
      expect((dto as any).quotes).toBeUndefined();
      expect((dto as any).recipients).toBeUndefined();
      expect((dto as any).requestRecipients).toBeUndefined();
      expect((dto as any).allocations).toBeUndefined();

      const jsonString = JSON.stringify(dto);
      expect(jsonString).not.toContain('"quotes":');
      expect(jsonString).not.toContain('"recipients":');
      expect(jsonString).not.toContain('"requestRecipients":');
      expect(jsonString).not.toContain('"allocations":');
    });
  });
});
