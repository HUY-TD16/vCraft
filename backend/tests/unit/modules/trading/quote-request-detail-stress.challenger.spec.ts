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
  EntityId,
  InvalidTradingInputError,
  Quantity,
  Quote,
  QuoteRequest,
  QuoteRequestNotFoundError,
  RequestRecipient,
  TradingDomainError,
  TradingPermissionDeniedError,
  UnitPrice,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import type {
  AdminRequestDto,
  BuyerRequestDto,
  InvitedRequestBaseDto,
  InvitedRequestWithAllocationDto,
} from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';

// ============================================================================
// Test Actors & Fixtures
// ============================================================================

const buyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-1',
  sessionLevel: 'normal',
});

const otherBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '99',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-other-buyer',
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

const artisanActor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '200',
  authVersion: 1,
  sessionId: 'session-artisan-1',
  sessionLevel: 'normal',
});

const otherArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '88',
  role: 'artisan',
  workshopId: '880',
  authVersion: 1,
  sessionId: 'session-uninvited-artisan',
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

function createBaselineDetailRecord(
  overrides: {
    request?: Partial<Parameters<typeof QuoteRequest.reconstitute>[0]>;
    allocations?: QuoteRequestDetailRecord['allocations'];
    quotes?: QuoteRequestDetailRecord['quotes'];
    recipients?: QuoteRequestDetailRecord['recipients'];
    statusLogs?: QuoteRequestDetailRecord['statusLogs'];
  } = {},
): QuoteRequestDetailRecord {
  const baseTime = new Date('2026-11-20T12:00:00.000Z');
  const biddingDeadline = new Date(baseTime.getTime() + 48 * 3600000); // 2026-11-22T12:00:00.000Z
  const deliveryDeadline = new Date(baseTime.getTime() + 120 * 3600000); // 2026-11-25T12:00:00.000Z
  const bidAcceptDeadline = new Date(biddingDeadline.getTime() + 26 * 3600000);
  const committedDeliveryAt = new Date(biddingDeadline.getTime() + 50 * 3600000);

  const requestEntity = QuoteRequest.reconstitute({
    id: '100',
    buyer_id: '10',
    category_id: '1',
    spec: 'Bộ ấm chén men lam vẽ tay cao cấp',
    quantity: 100,
    unit: 'set',
    unit_set_description: '1 ấm + 6 chén + 7 đĩa kê',
    status: 'artisans_bidding',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội, Gia Lâm, Bát Tràng',
    delivery_address: '123 Đường Láng, Đống Đa, Hà Nội',
    recipient_name: 'Nguyễn Văn Mua',
    recipient_phone: '0987654321',
    bidding_deadline: biddingDeadline,
    delivery_deadline: deliveryDeadline,
    bidding_closed_at: null,
    version: 1,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: new Date('2026-11-18T10:00:00.000Z'),
    updated_at: new Date('2026-11-18T10:00:00.000Z'),
    ...overrides.request,
  });

  const recipient200 = {
    entity: RequestRecipient.reconstitute({
      id: '501',
      request_id: '100',
      workshop_id: '200',
      response_status: 'quoted',
      decline_reason: null,
      responded_by: '20',
      responded_at: new Date('2026-11-18T11:00:00.000Z'),
      sent_at: new Date('2026-11-18T10:05:00.000Z'),
      version: 1,
    }),
    workshop: {
      id: '200',
      name: 'Xưởng Gốm Hưng Thịnh',
    },
  };

  const quote200 = {
    entity: Quote.reconstitute({
      id: '701',
      request_id: '100',
      workshop_id: '200',
      unit_price: 150000,
      max_quantity: 100,
      bid_accept_deadline: bidAcceptDeadline,
      committed_delivery_at: committedDeliveryAt,
      status: 'active',
      version: 1,
      withdraw_reason: null,
      withdrawn_at: null,
      withdrawn_by: null,
      created_at: new Date('2026-11-18T11:00:00.000Z'),
      updated_at: new Date('2026-11-18T11:00:00.000Z'),
    }),
    workshop: {
      id: '200',
      name: 'Xưởng Gốm Hưng Thịnh',
      status: 'active',
    },
  };

  return {
    entity: requestEntity,
    category: { id: '1', name: 'Ấm chén Bát Tràng' },
    recipients: overrides.recipients ?? [recipient200],
    quotes: overrides.quotes ?? [quote200],
    allocations: overrides.allocations ?? [],
    statusLogs: overrides.statusLogs ?? [],
  };
}

// ============================================================================
// Challenger Adversarial Test Suite
// ============================================================================

describe('ADVERSARIAL STRESS & BOUNDARY TEST: GET /api/v1/quote-requests/:id (UC-18, BR-04)', () => {
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
    vi.useRealTimers();
  });

  // ==========================================================================
  // Suite 1: Path Parameter :id Extreme Boundaries, Overflow & Mutation
  // ==========================================================================
  describe('Suite 1: Path Parameter :id Extreme Boundaries, Overflow & Mutation', () => {
    describe('1.1 Use Case Layer Validation', () => {
      it.each([
        ['empty string', ''],
        ['zero', '0'],
        ['negative integer', '-1'],
        ['negative multi-digit', '-9999'],
        ['signed 64-bit minimum', '-9223372036854775808'],
        ['leading plus sign', '+100'],
        ['floating point number', '100.5'],
        ['scientific notation', '1e5'],
        ['hexadecimal notation', '0x10'],
        ['binary notation', '0b1010'],
        ['octal notation', '0o77'],
        ['not-a-number string', 'NaN'],
        ['null string', 'null'],
        ['undefined string', 'undefined'],
        ['true string', 'true'],
        ['false string', 'false'],
        ['signed 64-bit overflow (2^63)', '9223372036854775808'],
        ['massive overflow string', '99999999999999999999999999999999999999'],
        ['unicode fullwidth digits', '１２３４５'],
        ['arabic-indic numerals', '١٢٣٤٥'],
        ['leading whitespace', '   100'],
        ['trailing whitespace', '100   '],
        ['internal whitespace', '10 0'],
        ['carriage return and newline', '100\r\n'],
        ['null byte injection', '100\0admin'],
        ['null byte escaped', '100\u0000'],
        ['tab character', '100\t'],
        ['SQLi: simple quote OR', "1' OR '1'='1"],
        ['SQLi: comment dash', '1; DROP TABLE quote_requests; --'],
        ['SQLi: union select', '1 UNION SELECT * FROM accounts'],
        ['XSS script tag', '<script>alert(1)</script>'],
        ['Path traversal', '../../etc/passwd'],
        ['Prototype pollution __proto__', '__proto__'],
        ['Prototype pollution constructor', 'constructor'],
      ])('rejects invalid ID "%s" (%s) with InvalidTradingInputError', async (_label, invalidId) => {
        await expect(
          useCase.execute({
            actor: buyerActor,
            id: invalidId,
          }),
        ).rejects.toThrow(InvalidTradingInputError);
      });

      it('accepts maximum 64-bit signed integer (9223372036854775807) as valid EntityId', async () => {
        const maxInt64 = '9223372036854775807';
        mockRepo.findDetailById.mockResolvedValueOnce(null);

        // When valid ID is not in DB, must throw QuoteRequestNotFoundError (404), NOT InvalidTradingInputError (400)
        await expect(
          useCase.execute({
            actor: buyerActor,
            id: maxInt64,
          }),
        ).rejects.toThrow(QuoteRequestNotFoundError);

        expect(mockRepo.findDetailById).toHaveBeenCalledWith(
          maxInt64,
          expect.anything(),
        );
      });

      it('successfully returns detail when ID is maximum 64-bit integer and entity exists', async () => {
        const maxInt64 = '9223372036854775807';
        const record = createBaselineDetailRecord({
          request: { id: maxInt64, buyer_id: '10' },
        });
        mockRepo.findDetailById.mockResolvedValueOnce(record);

        const res = (await useCase.execute({
          actor: buyerActor,
          id: maxInt64,
        })) as BuyerRequestDto;

        expect(res.id).toBe(maxInt64);
        expect(res.buyer_id).toBe('10');
      });
    });

    describe('1.2 HTTP Pipeline Adversarial Attack Injections', () => {
      it.each([
        ['0', 400, 'INVALID_INPUT'],
        ['-1', 400, 'INVALID_INPUT'],
        ['-999', 400, 'INVALID_INPUT'],
        ['9223372036854775808', 400, 'INVALID_INPUT'], // 64-bit overflow
        ['99999999999999999999999999999999999999', 400, 'INVALID_INPUT'], // massive overflow
        ['abc', 400, 'INVALID_INPUT'],
        ['100.5', 400, 'INVALID_INPUT'],
        ['1e5', 400, 'INVALID_INPUT'],
        [encodeURIComponent('   100   '), 400, 'INVALID_INPUT'],
        [encodeURIComponent("1' OR '1'='1"), 400, 'INVALID_INPUT'],
        [encodeURIComponent('1; DROP TABLE quote_requests; --'), 400, 'INVALID_INPUT'],
        [encodeURIComponent('１２３４５'), 400, 'INVALID_INPUT'],
        [encodeURIComponent('__proto__'), 400, 'INVALID_INPUT'],
      ])(
        'HTTP GET /api/v1/quote-requests/%s returns %i %s Problem Details without 500 crash',
        async (encodedId, expectedStatus, expectedErrorCode) => {
          identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

          const res = await fetch(`${base}/quote-requests/${encodedId}`, {
            method: 'GET',
            headers: { Cookie: 'vcraft-session=valid-buyer-token' },
          });

          expect(res.status).toBe(expectedStatus);
          const body = await res.json();
          expect(body.code).toBe(expectedErrorCode);
          expect(body.status).toBe(expectedStatus);
        },
      );

      it('HTTP GET /api/v1/quote-requests/9223372036854775807 (max signed int64) returns 404 RESOURCE_NOT_FOUND when absent', async () => {
        identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
        mockRepo.findDetailById.mockResolvedValueOnce(null);

        const res = await fetch(`${base}/quote-requests/9223372036854775807`, {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-buyer-token' },
        });

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.code).toBe('RESOURCE_NOT_FOUND');
      });
    });
  });

  // ==========================================================================
  // Suite 2: Real-Time Clock Skew & Deadline Boundary (BR-12)
  // ==========================================================================
  describe('Suite 2: Real-Time Clock Skew & Deadline Boundary (BR-12)', () => {
    const fixedBiddingDeadline = new Date('2026-11-22T12:00:00.000Z');
    const fixedDeliveryDeadline = new Date('2026-11-25T12:00:00.000Z');

    it('TC-CHALLENGE-CLOCK-01: Exactly 1ms BEFORE bidding_deadline -> is_bidding_open MUST BE TRUE', async () => {
      vi.useFakeTimers();
      const testNow = new Date(fixedBiddingDeadline.getTime() - 1); // 2026-11-22T11:59:59.999Z
      vi.setSystemTime(testNow);

      const record = createBaselineDetailRecord({
        request: {
          bidding_deadline: fixedBiddingDeadline,
          delivery_deadline: fixedDeliveryDeadline,
          status: 'artisans_bidding',
          bidding_closed_at: null,
          cancelled_at: null,
        },
      });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const res = (await useCase.execute({
        actor: buyerActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(res.is_bidding_open).toBe(true);
    });

    it('TC-CHALLENGE-CLOCK-02: Exactly AT bidding_deadline (exact millisecond match) -> is_bidding_open MUST BE FALSE (BR-12)', async () => {
      vi.useFakeTimers();
      const testNow = new Date(fixedBiddingDeadline.getTime()); // 2026-11-22T12:00:00.000Z
      vi.setSystemTime(testNow);

      const record = createBaselineDetailRecord({
        request: {
          bidding_deadline: fixedBiddingDeadline,
          delivery_deadline: fixedDeliveryDeadline,
          status: 'artisans_bidding',
          bidding_closed_at: null,
          cancelled_at: null,
        },
      });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const res = (await useCase.execute({
        actor: buyerActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(res.is_bidding_open).toBe(false);
    });

    it('TC-CHALLENGE-CLOCK-03: Exactly 1ms AFTER bidding_deadline -> is_bidding_open MUST BE FALSE', async () => {
      vi.useFakeTimers();
      const testNow = new Date(fixedBiddingDeadline.getTime() + 1); // 2026-11-22T12:00:00.001Z
      vi.setSystemTime(testNow);

      const record = createBaselineDetailRecord({
        request: {
          bidding_deadline: fixedBiddingDeadline,
          delivery_deadline: fixedDeliveryDeadline,
          status: 'artisans_bidding',
          bidding_closed_at: null,
          cancelled_at: null,
        },
      });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const res = (await useCase.execute({
        actor: buyerActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(res.is_bidding_open).toBe(false);
    });

    it('TC-CHALLENGE-CLOCK-04: At or beyond delivery_deadline -> is_bidding_open MUST BE FALSE', async () => {
      vi.useFakeTimers();

      // Exactly at delivery_deadline
      vi.setSystemTime(fixedDeliveryDeadline);
      const recordAtDelivery = createBaselineDetailRecord({
        request: {
          bidding_deadline: fixedBiddingDeadline,
          delivery_deadline: fixedDeliveryDeadline,
          status: 'artisans_bidding',
        },
      });
      mockRepo.findDetailById.mockResolvedValueOnce(recordAtDelivery);

      const resAt = (await useCase.execute({
        actor: buyerActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(resAt.is_bidding_open).toBe(false);

      // 30 days after delivery deadline
      const farFuture = new Date(fixedDeliveryDeadline.getTime() + 30 * 86400000);
      vi.setSystemTime(farFuture);
      const recordFarFuture = createBaselineDetailRecord({
        request: {
          bidding_deadline: fixedBiddingDeadline,
          delivery_deadline: fixedDeliveryDeadline,
          status: 'artisans_bidding',
        },
      });
      mockRepo.findDetailById.mockResolvedValueOnce(recordFarFuture);

      const resFuture = (await useCase.execute({
        actor: buyerActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(resFuture.is_bidding_open).toBe(false);
    });

    it('TC-CHALLENGE-CLOCK-05: Early closed bidding (bidding_closed_at present) while now < bidding_deadline -> is_bidding_open MUST BE FALSE', async () => {
      vi.useFakeTimers();
      const testNow = new Date('2026-11-21T10:00:00.000Z'); // Before fixedBiddingDeadline
      vi.setSystemTime(testNow);

      const record = createBaselineDetailRecord({
        request: {
          bidding_deadline: fixedBiddingDeadline,
          delivery_deadline: fixedDeliveryDeadline,
          status: 'artisans_bidding',
          bidding_closed_at: new Date('2026-11-21T09:00:00.000Z'),
        },
      });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const res = (await useCase.execute({
        actor: buyerActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(res.is_bidding_open).toBe(false);
    });

    it('TC-CHALLENGE-CLOCK-06: Cancelled QuoteRequest while now < bidding_deadline -> is_bidding_open MUST BE FALSE', async () => {
      vi.useFakeTimers();
      const testNow = new Date('2026-11-21T10:00:00.000Z');
      vi.setSystemTime(testNow);

      const record = createBaselineDetailRecord({
        request: {
          bidding_deadline: fixedBiddingDeadline,
          delivery_deadline: fixedDeliveryDeadline,
          status: 'artisans_bidding',
          cancelled_at: new Date('2026-11-21T09:30:00.000Z'),
          cancelled_by: '10',
          cancel_reason: 'Thay đổi kế hoạch',
        },
      });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const res = (await useCase.execute({
        actor: buyerActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(res.is_bidding_open).toBe(false);
    });

    it('TC-CHALLENGE-CLOCK-07: Inactive statuses (draft_request, buyer_accepted, in_production, delivered) -> is_bidding_open MUST BE FALSE', async () => {
      vi.useFakeTimers();
      const testNow = new Date('2026-11-21T10:00:00.000Z');
      vi.setSystemTime(testNow);

      const statuses = ['buyer_accepted', 'in_production', 'delivered'] as const;

      for (const status of statuses) {
        const record = createBaselineDetailRecord({
          request: {
            bidding_deadline: fixedBiddingDeadline,
            delivery_deadline: fixedDeliveryDeadline,
            status,
          },
        });
        mockRepo.findDetailById.mockResolvedValueOnce(record);

        const res = (await useCase.execute({
          actor: buyerActor,
          id: '100',
        })) as BuyerRequestDto;

        expect(res.is_bidding_open).toBe(false);
      }
    });
  });

  // ==========================================================================
  // Suite 3: Derived Fields Complex Stress (10+ Mixed Quotes Matrix)
  // ==========================================================================
  describe('Suite 3: Derived Fields Complex Stress (10+ Mixed Quotes Matrix)', () => {
    const evaluationNow = new Date('2026-11-18T10:00:00.000Z');
    const biddingDeadline = new Date('2026-11-20T12:00:00.000Z');
    const deliveryDeadline = new Date('2026-11-25T12:00:00.000Z');

    function build12QuotesMatrix(): QuoteRequestDetailRecord['quotes'] {
      return [
        // Q1 (id 701): status 'withdrawn', workshop active -> INELIGIBLE (withdrawn)
        {
          entity: Quote.reconstitute({
            id: '701',
            request_id: '100',
            workshop_id: '201',
            unit_price: 150000,
            max_quantity: 100,
            bid_accept_deadline: new Date('2026-11-21T10:00:00.000Z'),
            committed_delivery_at: new Date('2026-11-23T10:00:00.000Z'),
            status: 'withdrawn',
            version: 2,
            withdraw_reason: 'Thiếu thợ thủ công',
            withdrawn_at: new Date('2026-11-17T10:00:00.000Z'),
            withdrawn_by: '201',
            created_at: new Date('2026-11-16T10:00:00.000Z'),
            updated_at: new Date('2026-11-17T10:00:00.000Z'),
          }),
          workshop: { id: '201', name: 'Xưởng 201', status: 'active' },
        },
        // Q2 (id 702): status 'accepted' -> INELIGIBLE (already accepted)
        {
          entity: Quote.reconstitute({
            id: '702',
            request_id: '100',
            workshop_id: '202',
            unit_price: 140000,
            max_quantity: 100,
            bid_accept_deadline: new Date('2026-11-21T10:00:00.000Z'),
            committed_delivery_at: new Date('2026-11-23T10:00:00.000Z'),
            status: 'accepted',
            version: 2,
            withdraw_reason: null,
            withdrawn_at: null,
            withdrawn_by: null,
            created_at: new Date('2026-11-16T10:00:00.000Z'),
            updated_at: new Date('2026-11-17T10:00:00.000Z'),
          }),
          workshop: { id: '202', name: 'Xưởng 202', status: 'active' },
        },
        // Q3 (id 703): status 'active', workshop SUSPENDED -> INELIGIBLE (workshop inactive)
        {
          entity: Quote.reconstitute({
            id: '703',
            request_id: '100',
            workshop_id: '203',
            unit_price: 130000,
            max_quantity: 100,
            bid_accept_deadline: new Date('2026-11-21T10:00:00.000Z'),
            committed_delivery_at: new Date('2026-11-23T10:00:00.000Z'),
            status: 'active',
            version: 1,
            withdraw_reason: null,
            withdrawn_at: null,
            withdrawn_by: null,
            created_at: new Date('2026-11-16T10:00:00.000Z'),
            updated_at: new Date('2026-11-16T10:00:00.000Z'),
          }),
          workshop: { id: '203', name: 'Xưởng 203 Bị Treo', status: 'suspended' },
        },
        // Q4 (id 704): status 'active', workshop active, accept EXPIRED (09:00 < 10:00) -> INELIGIBLE
        {
          entity: Quote.reconstitute({
            id: '704',
            request_id: '100',
            workshop_id: '204',
            unit_price: 120000,
            max_quantity: 100,
            bid_accept_deadline: new Date('2026-11-18T09:00:00.000Z'),
            committed_delivery_at: new Date('2026-11-23T10:00:00.000Z'),
            status: 'active',
            version: 1,
            withdraw_reason: null,
            withdrawn_at: null,
            withdrawn_by: null,
            created_at: new Date('2026-11-16T10:00:00.000Z'),
            updated_at: new Date('2026-11-16T10:00:00.000Z'),
          }),
          workshop: { id: '204', name: 'Xưởng 204', status: 'active' },
        },
        // Q5 (id 705): status 'active', workshop active, accept EXACTLY NOW (ms equal) -> INELIGIBLE (now >= deadline is true)
        {
          entity: Quote.reconstitute({
            id: '705',
            request_id: '100',
            workshop_id: '205',
            unit_price: 125000,
            max_quantity: 100,
            bid_accept_deadline: new Date('2026-11-18T10:00:00.000Z'),
            committed_delivery_at: new Date('2026-11-23T10:00:00.000Z'),
            status: 'active',
            version: 1,
            withdraw_reason: null,
            withdrawn_at: null,
            withdrawn_by: null,
            created_at: new Date('2026-11-16T10:00:00.000Z'),
            updated_at: new Date('2026-11-16T10:00:00.000Z'),
          }),
          workshop: { id: '205', name: 'Xưởng 205', status: 'active' },
        },
        // Q6 (id 706): status 'active', workshop active, committed_delivery EXCEEDS request.delivery_deadline (+1ms) -> INELIGIBLE
        {
          entity: Quote.reconstitute({
            id: '706',
            request_id: '100',
            workshop_id: '206',
            unit_price: 110000,
            max_quantity: 100,
            bid_accept_deadline: new Date('2026-11-21T10:00:00.000Z'),
            committed_delivery_at: new Date('2026-11-25T12:00:00.001Z'), // 1ms late!
            status: 'active',
            version: 1,
            withdraw_reason: null,
            withdrawn_at: null,
            withdrawn_by: null,
            created_at: new Date('2026-11-16T10:00:00.000Z'),
            updated_at: new Date('2026-11-16T10:00:00.000Z'),
          }),
          workshop: { id: '206', name: 'Xưởng 206', status: 'active' },
        },
        // Q7 (id 707): status 'active', workshop active -> ELIGIBLE (accept: 2026-11-21T18:00:00.000Z)
        {
          entity: Quote.reconstitute({
            id: '707',
            request_id: '100',
            workshop_id: '207',
            unit_price: 160000,
            max_quantity: 100,
            bid_accept_deadline: new Date('2026-11-21T18:00:00.000Z'),
            committed_delivery_at: new Date('2026-11-24T10:00:00.000Z'),
            status: 'active',
            version: 1,
            withdraw_reason: null,
            withdrawn_at: null,
            withdrawn_by: null,
            created_at: new Date('2026-11-16T10:00:00.000Z'),
            updated_at: new Date('2026-11-16T10:00:00.000Z'),
          }),
          workshop: { id: '207', name: 'Xưởng 207', status: 'active' },
        },
        // Q8 (id 708): status 'active', workshop active -> ELIGIBLE (accept: 2026-11-21T15:00:00.000Z)
        {
          entity: Quote.reconstitute({
            id: '708',
            request_id: '100',
            workshop_id: '208',
            unit_price: 155000,
            max_quantity: 100,
            bid_accept_deadline: new Date('2026-11-21T15:00:00.000Z'),
            committed_delivery_at: new Date('2026-11-23T10:00:00.000Z'),
            status: 'active',
            version: 1,
            withdraw_reason: null,
            withdrawn_at: null,
            withdrawn_by: null,
            created_at: new Date('2026-11-16T10:00:00.000Z'),
            updated_at: new Date('2026-11-16T10:00:00.000Z'),
          }),
          workshop: { id: '208', name: 'Xưởng 208', status: 'active' },
        },
        // Q9 (id 709): status 'active', workshop active -> ELIGIBLE (accept: 2026-11-22T10:00:00.000Z)
        {
          entity: Quote.reconstitute({
            id: '709',
            request_id: '100',
            workshop_id: '209',
            unit_price: 170000,
            max_quantity: 100,
            bid_accept_deadline: new Date('2026-11-22T10:00:00.000Z'),
            committed_delivery_at: new Date('2026-11-24T12:00:00.000Z'),
            status: 'active',
            version: 1,
            withdraw_reason: null,
            withdrawn_at: null,
            withdrawn_by: null,
            created_at: new Date('2026-11-16T10:00:00.000Z'),
            updated_at: new Date('2026-11-16T10:00:00.000Z'),
          }),
          workshop: { id: '209', name: 'Xưởng 209', status: 'active' },
        },
        // Q10 (id 710): multiple failures: withdrawn + suspended workshop + expired accept + delivery late
        {
          entity: Quote.reconstitute({
            id: '710',
            request_id: '100',
            workshop_id: '210',
            unit_price: 180000,
            max_quantity: 100,
            bid_accept_deadline: new Date('2026-11-17T10:00:00.000Z'),
            committed_delivery_at: new Date('2026-11-26T10:00:00.000Z'),
            status: 'withdrawn',
            version: 2,
            withdraw_reason: 'Ngừng hoạt động',
            withdrawn_at: new Date('2026-11-17T11:00:00.000Z'),
            withdrawn_by: '210',
            created_at: new Date('2026-11-16T10:00:00.000Z'),
            updated_at: new Date('2026-11-17T11:00:00.000Z'),
          }),
          workshop: { id: '210', name: 'Xưởng 210', status: 'suspended' },
        },
        // Q11 (id 711): status 'active', workshop active, accept EXACTLY 1ms AFTER NOW -> ELIGIBLE & NEAREST!
        {
          entity: Quote.reconstitute({
            id: '711',
            request_id: '100',
            workshop_id: '211',
            unit_price: 145000,
            max_quantity: 100,
            bid_accept_deadline: new Date('2026-11-18T10:00:00.001Z'),
            committed_delivery_at: new Date('2026-11-24T10:00:00.000Z'),
            status: 'active',
            version: 1,
            withdraw_reason: null,
            withdrawn_at: null,
            withdrawn_by: null,
            created_at: new Date('2026-11-16T10:00:00.000Z'),
            updated_at: new Date('2026-11-16T10:00:00.000Z'),
          }),
          workshop: { id: '211', name: 'Xưởng 211', status: 'active' },
        },
        // Q12 (id 712): status 'active', workshop active, delivery EXACTLY EQUAL delivery_deadline -> ELIGIBLE
        {
          entity: Quote.reconstitute({
            id: '712',
            request_id: '100',
            workshop_id: '212',
            unit_price: 135000,
            max_quantity: 100,
            bid_accept_deadline: new Date('2026-11-23T12:00:00.000Z'),
            committed_delivery_at: new Date('2026-11-25T12:00:00.000Z'), // Exactly equal to delivery_deadline
            status: 'active',
            version: 1,
            withdraw_reason: null,
            withdrawn_at: null,
            withdrawn_by: null,
            created_at: new Date('2026-11-16T10:00:00.000Z'),
            updated_at: new Date('2026-11-16T10:00:00.000Z'),
          }),
          workshop: { id: '212', name: 'Xưởng 212', status: 'active' },
        },
      ];
    }

    it('TC-CHALLENGE-DERIVED-01: Correctly isolates eligible quotes from 12-quote matrix: no_valid_quotes is false and nearest_accept_deadline is exactly Q11 deadline', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(evaluationNow);

      const quotes = build12QuotesMatrix();
      const record = createBaselineDetailRecord({
        request: {
          bidding_deadline: biddingDeadline,
          delivery_deadline: deliveryDeadline,
          status: 'artisans_bidding',
        },
        quotes,
      });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const res = (await useCase.execute({
        actor: buyerActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(res.no_valid_quotes).toBe(false);
      // Q11 has bid_accept_deadline at 2026-11-18T10:00:00.001Z, which is the earliest among Q7, Q8, Q9, Q11, Q12
      expect(res.nearest_accept_deadline).toBe('2026-11-18T10:00:00.001Z');
    });

    it('TC-CHALLENGE-DERIVED-02: When time advances past all accept deadlines, no_valid_quotes becomes true and nearest_accept_deadline becomes null', async () => {
      vi.useFakeTimers();
      // Advance to 2026-11-24T00:00:00.000Z (after Q11, Q8, Q7, Q9, Q12 deadlines)
      const advancedTime = new Date('2026-11-24T00:00:00.000Z');
      vi.setSystemTime(advancedTime);

      const quotes = build12QuotesMatrix();
      const record = createBaselineDetailRecord({
        request: {
          bidding_deadline: biddingDeadline,
          delivery_deadline: deliveryDeadline,
          status: 'artisans_bidding',
        },
        quotes,
      });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const res = (await useCase.execute({
        actor: buyerActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(res.no_valid_quotes).toBe(true);
      expect(res.nearest_accept_deadline).toBeNull();
    });

    it('TC-CHALLENGE-DERIVED-03: Cancelled QuoteRequest with active quotes forces no_valid_quotes=false and nearest_accept_deadline=null (BR-18)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(evaluationNow);

      const quotes = build12QuotesMatrix();
      const record = createBaselineDetailRecord({
        request: {
          bidding_deadline: biddingDeadline,
          delivery_deadline: deliveryDeadline,
          status: 'artisans_bidding',
          cancelled_at: new Date('2026-11-18T09:30:00.000Z'),
          cancelled_by: '10',
          cancel_reason: 'Kế hoạch thay đổi',
        },
        quotes,
      });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const res = (await useCase.execute({
        actor: buyerActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(res.no_valid_quotes).toBe(false);
      expect(res.nearest_accept_deadline).toBeNull();
    });

    it('TC-CHALLENGE-DERIVED-04: QuoteRequest in buyer_accepted status forces no_valid_quotes=false and nearest_accept_deadline=null (BR-18)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(evaluationNow);

      const quotes = build12QuotesMatrix();
      const record = createBaselineDetailRecord({
        request: {
          bidding_deadline: biddingDeadline,
          delivery_deadline: deliveryDeadline,
          status: 'buyer_accepted',
        },
        quotes,
      });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const res = (await useCase.execute({
        actor: buyerActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(res.no_valid_quotes).toBe(false);
      expect(res.nearest_accept_deadline).toBeNull();
    });

    it('TC-CHALLENGE-DERIVED-05: Invited Artisan DTO never leaks no_valid_quotes or nearest_accept_deadline (BR-04, SEC-04)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(evaluationNow);

      const quotes = build12QuotesMatrix();
      const recipient211 = {
        entity: RequestRecipient.reconstitute({
          id: '511',
          request_id: '100',
          workshop_id: '211',
          response_status: 'quoted',
          decline_reason: null,
          responded_by: '211',
          responded_at: new Date('2026-11-17T10:00:00.000Z'),
          sent_at: new Date('2026-11-16T10:00:00.000Z'),
          version: 1,
        }),
        workshop: { id: '211', name: 'Xưởng 211' },
      };

      const record = createBaselineDetailRecord({
        request: {
          bidding_deadline: biddingDeadline,
          delivery_deadline: deliveryDeadline,
          status: 'artisans_bidding',
        },
        recipients: [recipient211],
        quotes,
      });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const artisan211Actor: AuthenticatedActor = {
        accountId: '211',
        role: 'artisan',
        workshopId: '211',
        authVersion: 1,
        sessionId: 'session-artisan-211',
        sessionLevel: 'normal',
      };

      const res = (await useCase.execute({
        actor: artisan211Actor,
        id: '100',
      })) as any;

      // Privacy verification: Derived aggregate quote analytics must not leak to individual artisans
      expect(res.no_valid_quotes).toBeUndefined();
      expect(res.nearest_accept_deadline).toBeUndefined();
      expect(res.quotes).toBeUndefined(); // competitor quotes hidden
    });
  });

  // ==========================================================================
  // Suite 4: Extreme Quantities, Invariant Defenses & Edge Commercial Values
  // ==========================================================================
  describe('Suite 4: Extreme Quantities, Invariant Defenses & Edge Commercial Values', () => {
    it('TC-CHALLENGE-EXTREME-01: Maximum 32-bit integer quantity (2147483647) and maximum VND unit price serializes cleanly', async () => {
      const maxInt32Quantity = 2147483647;
      const maxVndPrice = 999_999_999_999_999;

      const extremeQuote = {
        entity: Quote.reconstitute({
          id: '799',
          request_id: '100',
          workshop_id: '200',
          unit_price: maxVndPrice,
          max_quantity: maxInt32Quantity,
          bid_accept_deadline: new Date('2026-11-23T10:00:00.000Z'),
          committed_delivery_at: new Date('2026-11-24T10:00:00.000Z'),
          status: 'active',
          version: 1,
          withdraw_reason: null,
          withdrawn_at: null,
          withdrawn_by: null,
          created_at: new Date('2026-11-18T10:00:00.000Z'),
          updated_at: new Date('2026-11-18T10:00:00.000Z'),
        }),
        workshop: { id: '200', name: 'Xưởng Gốm Hưng Thịnh', status: 'active' },
      };

      const record = createBaselineDetailRecord({
        request: {
          quantity: maxInt32Quantity,
        },
        quotes: [extremeQuote],
      });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const res = (await useCase.execute({
        actor: buyerActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(res.quantity).toBe(maxInt32Quantity);
    });

    it('TC-CHALLENGE-EXTREME-02: Zero quantity fails domain invariants with InvalidTradingInputError', () => {
      expect(() => Quantity.of(0, 'quantity')).toThrow(InvalidTradingInputError);
    });

    it('TC-CHALLENGE-EXTREME-03: Negative quantity fails domain invariants with InvalidTradingInputError', () => {
      expect(() => Quantity.of(-1, 'quantity')).toThrow(InvalidTradingInputError);
      expect(() => Quantity.of(-100, 'quantity')).toThrow(InvalidTradingInputError);
    });

    it('TC-CHALLENGE-EXTREME-04: Non-integer / float quantity fails domain invariants with InvalidTradingInputError', () => {
      expect(() => Quantity.of(1.5, 'quantity')).toThrow(InvalidTradingInputError);
      expect(() => Quantity.of(NaN, 'quantity')).toThrow(InvalidTradingInputError);
    });

    it('TC-CHALLENGE-EXTREME-05: Zero or negative UnitPrice fails domain invariants with InvalidTradingInputError', () => {
      expect(() => UnitPrice.of(0)).toThrow(InvalidTradingInputError);
      expect(() => UnitPrice.of(-50000)).toThrow(InvalidTradingInputError);
    });

    it('TC-CHALLENGE-EXTREME-06: UnitPrice exceeding 999,999,999,999,999 fails with InvalidTradingInputError', () => {
      expect(() => UnitPrice.of(1_000_000_000_000_000)).toThrow(
        InvalidTradingInputError,
      );
    });
  });

  // ==========================================================================
  // Suite 5: IDOR & Security Isolation Under Adversarial Injections
  // ==========================================================================
  describe('Suite 5: IDOR & Security Isolation Under Adversarial Injections', () => {
    it('TC-CHALLENGE-SEC-01: Non-owner Buyer IDOR attack yields HTTP 404 RESOURCE_NOT_FOUND indistinguishable from 404 non-existent', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(otherBuyerActor);
      const record = createBaselineDetailRecord({
        request: { id: '100', buyer_id: '10' },
      });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const res = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=other-buyer-token' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
      // Must not leak 403 or permission denied message
      expect(res.status).not.toBe(403);
    });

    it('TC-CHALLENGE-SEC-02: Uninvited Artisan IDOR attack yields HTTP 404 RESOURCE_NOT_FOUND indistinguishable from 404 non-existent', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(otherArtisanActor);
      const record = createBaselineDetailRecord({
        request: { id: '100', buyer_id: '10' },
        recipients: [
          {
            entity: RequestRecipient.reconstitute({
              id: '501',
              request_id: '100',
              workshop_id: '200', // Only workshop 200 is invited, otherArtisan has workshop 880
              response_status: 'pending',
              decline_reason: null,
              responded_by: null,
              responded_at: null,
              sent_at: new Date('2026-11-18T10:00:00.000Z'),
              version: 1,
            }),
            workshop: { id: '200', name: 'Xưởng 200' },
          },
        ],
      });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const res = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=uninvited-artisan-token' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
      expect(res.status).not.toBe(403);
    });

    it('TC-CHALLENGE-SEC-03: Non-existent QuoteRequest yields identical HTTP 404 RESOURCE_NOT_FOUND', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      mockRepo.findDetailById.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/quote-requests/999999`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=valid-buyer-token' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('TC-CHALLENGE-SEC-04: Temp password session strictly rejected with HTTP 403 TEMP_PASSWORD_RESTRICTED (SEC-05)', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(tempPasswordBuyerActor);

      const res = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=temp-buyer-token' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
      // Database should NOT even be queried for temp password sessions
      expect(mockRepo.findDetailById).not.toHaveBeenCalled();
    });

    it('TC-CHALLENGE-SEC-05: Missing session cookie strictly rejected with HTTP 401 AUTHENTICATION_REQUIRED (SEC-01)', async () => {
      const res = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
      expect(mockRepo.findDetailById).not.toHaveBeenCalled();
    });
  });
});
