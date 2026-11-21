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
  InvalidTradingInputError,
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

// Test Actors
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
  accountId: '25',
  role: 'artisan',
  workshopId: '250',
  authVersion: 1,
  sessionId: 'session-other-artisan',
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

function createSampleDetailRecord(
  overrides: {
    request?: Partial<Parameters<typeof QuoteRequest.reconstitute>[0]>;
    allocations?: QuoteRequestDetailRecord['allocations'];
    quotes?: QuoteRequestDetailRecord['quotes'];
    recipients?: QuoteRequestDetailRecord['recipients'];
    statusLogs?: QuoteRequestDetailRecord['statusLogs'];
  } = {},
): QuoteRequestDetailRecord {
  const now = new Date();
  const biddingDeadline = new Date(now.getTime() + 48 * 3600000); // +48h
  const deliveryDeadline = new Date(now.getTime() + 120 * 3600000); // +120h (> biddingDeadline + 24h)
  const bidAcceptDeadline = new Date(biddingDeadline.getTime() + 26 * 3600000); // >= biddingDeadline + 24h
  const committedDeliveryAt = new Date(biddingDeadline.getTime() + 50 * 3600000); // <= deliveryDeadline

  const requestEntity = QuoteRequest.reconstitute({
    id: '100',
    buyer_id: '10',
    category_id: '1',
    spec: 'Bộ ấm chén men lam vẽ tay truyền thống',
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
    created_at: new Date('2026-11-10T10:00:00.000Z'),
    updated_at: new Date('2026-11-10T10:00:00.000Z'),
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
      responded_at: new Date('2026-11-10T11:00:00.000Z'),
      sent_at: new Date('2026-11-10T10:05:00.000Z'),
      version: 1,
    }),
    workshop: {
      id: '200',
      name: 'Xưởng Gốm Hưng Thịnh',
    },
  };

  const recipient300 = {
    entity: RequestRecipient.reconstitute({
      id: '502',
      request_id: '100',
      workshop_id: '300',
      response_status: 'quoted',
      decline_reason: null,
      responded_by: '30',
      responded_at: new Date('2026-11-10T12:00:00.000Z'),
      sent_at: new Date('2026-11-10T10:05:00.000Z'),
      version: 1,
    }),
    workshop: {
      id: '300',
      name: 'Xưởng Gốm Bát Tràng Thịnh Vượng',
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
      created_at: new Date('2026-11-10T11:00:00.000Z'),
      updated_at: new Date('2026-11-10T11:00:00.000Z'),
    }),
    workshop: {
      id: '200',
      name: 'Xưởng Gốm Hưng Thịnh',
      status: 'active',
    },
  };

  const quote300 = {
    entity: Quote.reconstitute({
      id: '702',
      request_id: '100',
      workshop_id: '300',
      unit_price: 140000,
      max_quantity: 100,
      bid_accept_deadline: new Date(biddingDeadline.getTime() + 28 * 3600000),
      committed_delivery_at: new Date(biddingDeadline.getTime() + 55 * 3600000),
      status: 'active',
      version: 1,
      withdraw_reason: null,
      withdrawn_at: null,
      withdrawn_by: null,
      created_at: new Date('2026-11-10T12:00:00.000Z'),
      updated_at: new Date('2026-11-10T12:00:00.000Z'),
    }),
    workshop: {
      id: '300',
      name: 'Xưởng Gốm Bát Tràng Thịnh Vượng',
      status: 'active',
    },
  };

  return {
    entity: requestEntity,
    category: { id: '1', name: 'Ấm chén Bát Tràng' },
    recipients: overrides.recipients ?? [recipient200, recipient300],
    quotes: overrides.quotes ?? [quote200, quote300],
    allocations: overrides.allocations ?? [],
    statusLogs: overrides.statusLogs ?? [],
  };
}

describe('API GET /api/v1/quote-requests/:id (UC-18, BR-04) — Test Suite', () => {
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

    useCase = new GetQuoteRequestByIdUseCase(txRunner, mockRepo as unknown as IQuoteRequestRepository);
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Suite A: GetQuoteRequestByIdUseCase (Unit Layer & Domain Isolation)', () => {
    it('TC-UC18-01: Buyer owner retrieves full QuoteRequest details with BuyerRequestDto', async () => {
      const record = createSampleDetailRecord();
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const result = (await useCase.execute({
        actor: buyerActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(mockRepo.findDetailById).toHaveBeenCalledWith('100', expect.anything());
      expect(result.id).toBe('100');
      expect(result.buyer_id).toBe('10');
      expect(result.recipient_name).toBe('Nguyễn Văn Mua');
      expect(result.recipient_phone).toBe('0987654321');
      expect(result.delivery_address).toBe('123 Đường Láng, Đống Đa, Hà Nội');
      expect(result.split_requested_at).toBeNull();
      expect(result.coordination_state).toBeNull();
      expect(result.is_bidding_open).toBe(true);
      expect(result.no_valid_quotes).toBe(false);
      expect(result.nearest_accept_deadline).toBeDefined();
      expect(result.delivery_confirmation).toBeNull();
    });

    it('TC-UC18-02: Admin retrieves full QuoteRequest details regardless of buyer ownership', async () => {
      const record = createSampleDetailRecord();
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const result = (await useCase.execute({
        actor: adminActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(result.id).toBe('100');
      expect(result.buyer_id).toBe('10');
      expect(result.recipient_name).toBe('Nguyễn Văn Mua');
      expect(result.recipient_phone).toBe('0987654321');
      expect(result.delivery_address).toBe('123 Đường Láng, Đống Đa, Hà Nội');
      expect(result.split_requested_at).toBeNull();
    });

    it('TC-UC18-03: Invited Artisan WITHOUT allocation receives InvitedRequestBaseDto with strict data masking (BR-04)', async () => {
      const record = createSampleDetailRecord({ allocations: [] });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const result = (await useCase.execute({
        actor: artisanActor,
        id: '100',
      })) as InvitedRequestBaseDto;

      // Sensitive Buyer contact and address MUST be undefined
      expect((result as any).recipient_name).toBeUndefined();
      expect((result as any).recipient_phone).toBeUndefined();
      expect((result as any).delivery_address).toBeUndefined();
      expect((result as any).own_allocation_id).toBeUndefined();
      expect((result as any).buyer_id).toBeUndefined();

      // Only generalized delivery region is visible
      expect(result.delivery_region).toBe('Hà Nội, Gia Lâm, Bát Tràng');

      // Own recipient and quote are present
      expect(result.own_recipient.workshop.id).toBe('200');
      expect(result.own_quote?.id).toBe('701');
      expect(result.own_quote?.unit_price).toBe(150000);

      // Competitor quote 702 or workshop 300 must NOT be exposed
      expect((result as any).quotes).toBeUndefined();
      expect((result as any).recipients).toBeUndefined();
    });

    it('TC-UC18-04: Invited Artisan WITH won allocation receives InvitedRequestWithAllocationDto with unmasked contact (BR-04)', async () => {
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

      const record = createSampleDetailRecord({ allocations: [wonAllocation] });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const result = (await useCase.execute({
        actor: artisanActor,
        id: '100',
      })) as InvitedRequestWithAllocationDto;

      // Contact and address unmasked for winning artisan
      expect(result.recipient_name).toBe('Nguyễn Văn Mua');
      expect(result.recipient_phone).toBe('0987654321');
      expect(result.delivery_address).toBe('123 Đường Láng, Đống Đa, Hà Nội');
      expect(result.own_allocation_id).toBe('901');

      // Competitor quotes still strictly absent
      expect((result as any).quotes).toBeUndefined();
      expect((result as any).recipients).toBeUndefined();
    });

    it('TC-UC18-05: Non-owner Buyer is rejected with HTTP 404 QuoteRequestNotFoundError to prevent IDOR enumeration (SEC-06)', async () => {
      const record = createSampleDetailRecord(); // owned by buyer 10
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      await expect(
        useCase.execute({
          actor: otherBuyerActor, // buyer 99
          id: '100',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);
    });

    it('TC-UC18-06: Uninvited Artisan is rejected with HTTP 404 QuoteRequestNotFoundError to prevent IDOR enumeration (SEC-06)', async () => {
      const record = createSampleDetailRecord(); // invited workshops: 200, 300
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      await expect(
        useCase.execute({
          actor: otherArtisanActor, // workshop 250
          id: '100',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);
    });

    it('TC-UC18-07: Non-existent QuoteRequest ID throws QuoteRequestNotFoundError (HTTP 404)', async () => {
      mockRepo.findDetailById.mockResolvedValueOnce(null);

      await expect(
        useCase.execute({
          actor: buyerActor,
          id: '999999',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);
    });

    it('TC-UC18-08: Artisan actor without workshopId throws TradingPermissionDeniedError (HTTP 403)', async () => {
      const record = createSampleDetailRecord();
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      await expect(
        useCase.execute({
          actor: artisanWithoutWorkshopActor,
          id: '100',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('TC-UC18-09: Invalid ID format (non-numeric, zero, negative) throws InvalidTradingInputError (HTTP 400)', async () => {
      await expect(
        useCase.execute({
          actor: buyerActor,
          id: 'invalid-string',
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: buyerActor,
          id: '-10',
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: buyerActor,
          id: '0',
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('TC-UC18-10: Session with temp_password level is restricted with HTTP 403 TEMP_PASSWORD_RESTRICTED (SEC-05)', async () => {
      await expect(
        useCase.execute({
          actor: tempPasswordBuyerActor,
          id: '100',
        }),
      ).rejects.toThrow(TradingDomainError);

      try {
        await useCase.execute({
          actor: tempPasswordBuyerActor,
          id: '100',
        });
      } catch (err: any) {
        expect(err.code).toBe('TEMP_PASSWORD_RESTRICTED');
      }
    });

    it('TC-UC18-11: Artisan with Allocation preserves contact unmasking even when QuoteRequest is delivered or cancelled (BR-04)', async () => {
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
          delivery_note: 'Đã giao đầy đủ',
          admin_handed_over: false,
          admin_delivery_evidence: null,
          admin_handover_reason: null,
          admin_handover_actual_at: null,
          created_at: new Date('2026-11-12T10:00:00.000Z'),
          updated_at: new Date('2026-11-19T10:00:00.000Z'),
        }),
      };

      // Test delivered state
      const deliveredRecord = createSampleDetailRecord({
        request: { status: 'delivered' },
        allocations: [wonAllocation],
      });
      mockRepo.findDetailById.mockResolvedValueOnce(deliveredRecord);

      const deliveredRes = (await useCase.execute({
        actor: artisanActor,
        id: '100',
      })) as InvitedRequestWithAllocationDto;

      expect(deliveredRes.status).toBe('delivered');
      expect(deliveredRes.recipient_name).toBe('Nguyễn Văn Mua');
      expect(deliveredRes.recipient_phone).toBe('0987654321');
      expect(deliveredRes.delivery_address).toBe('123 Đường Láng, Đống Đa, Hà Nội');

      // Test cancelled state
      const cancelledRecord = createSampleDetailRecord({
        request: {
          cancelled_at: new Date('2026-11-15T10:00:00.000Z'),
          cancelled_by: '10',
          cancel_reason: 'Người mua hủy do thay đổi kế hoạch',
        },
        allocations: [wonAllocation],
      });
      mockRepo.findDetailById.mockResolvedValueOnce(cancelledRecord);

      const cancelledRes = (await useCase.execute({
        actor: artisanActor,
        id: '100',
      })) as InvitedRequestWithAllocationDto;

      expect(cancelledRes.recipient_name).toBe('Nguyễn Văn Mua');
      expect(cancelledRes.recipient_phone).toBe('0987654321');
      expect(cancelledRes.delivery_address).toBe('123 Đường Láng, Đống Đa, Hà Nội');
      expect(cancelledRes.own_allocation_id).toBe('901');
    });

    it('TC-UC18-12: Correctly derives no_valid_quotes, nearest_accept_deadline, and delivery_confirmation snapshot', async () => {
      // 1. Withdrawn quotes -> no_valid_quotes should be true
      const recordWithdrawn = createSampleDetailRecord();
      const withdrawnQuote = {
        entity: Quote.reconstitute({
          id: '701',
          request_id: '100',
          workshop_id: '200',
          unit_price: 150000,
          max_quantity: 100,
          bid_accept_deadline: new Date(
            recordWithdrawn.entity.bidding_deadline!.getTime() + 26 * 3600000,
          ),
          committed_delivery_at: new Date(
            recordWithdrawn.entity.bidding_deadline!.getTime() + 50 * 3600000,
          ),
          status: 'withdrawn',
          version: 2,
          withdraw_reason: 'Hết nguyên liệu',
          withdrawn_at: new Date(),
          withdrawn_by: '20',
          created_at: new Date(),
          updated_at: new Date(),
        }),
        workshop: { id: '200', name: 'Xưởng Gốm Hưng Thịnh', status: 'active' },
      };

      const recordWithdrawnFinal = createSampleDetailRecord({ quotes: [withdrawnQuote] });
      mockRepo.findDetailById.mockResolvedValueOnce(recordWithdrawnFinal);

      const resWithdrawn = (await useCase.execute({
        actor: buyerActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(resWithdrawn.no_valid_quotes).toBe(true);
      expect(resWithdrawn.nearest_accept_deadline).toBeNull();

      // 2. Delivered QuoteRequest with StatusLog delivery confirmation snapshot
      const deliveryStatusLog = {
        entity: {
          id: '801',
          request_id: '100',
          event_type: 'received_by_buyer' as const,
          prev_status: 'in_production' as const,
          new_status: 'delivered' as const,
          performed_by: '10',
          is_admin_action: false,
          note: 'Đã nhận đủ 100 bộ nguyên vẹn',
          evidence: 'https://cdn.vcraft.vn/evidence/delivered-100.jpg',
          created_at: new Date('2026-11-20T15:00:00.000Z'),
        },
        performedBy: {
          id: '10',
          display_name: 'Nguyễn Văn Mua',
        },
      };

      const recordDelivered = createSampleDetailRecord({
        request: { status: 'delivered' },
        statusLogs: [deliveryStatusLog],
      });
      mockRepo.findDetailById.mockResolvedValueOnce(recordDelivered);

      const resDelivered = (await useCase.execute({
        actor: buyerActor,
        id: '100',
      })) as BuyerRequestDto;

      expect(resDelivered.delivery_confirmation).not.toBeNull();
      expect(resDelivered.delivery_confirmation?.performed_by.display_name).toBe('Nguyễn Văn Mua');
      expect(resDelivered.delivery_confirmation?.is_admin_action).toBe(false);
      expect(resDelivered.delivery_confirmation?.reason).toBe('Đã nhận đủ 100 bộ nguyên vẹn');
      expect(resDelivered.delivery_confirmation?.evidence).toBe('https://cdn.vcraft.vn/evidence/delivered-100.jpg');
    });
  });

  describe('Suite B: QuoteRequestController (HTTP Integration Pipeline & Security Guards)', () => {
    it('TC-HTTP-01: GET /api/v1/quote-requests/:id by Buyer owner returns 200 OK wrapped in { success: true, data: BuyerRequestDto }', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const record = createSampleDetailRecord();
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const res = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=valid-buyer-token' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('100');
      expect(json.data.buyer_id).toBe('10');
      expect(json.data.recipient_name).toBe('Nguyễn Văn Mua');
      expect(json.data.recipient_phone).toBe('0987654321');
      expect(json.data.delivery_address).toBe('123 Đường Láng, Đống Đa, Hà Nội');
      expect(json.data.split_requested_at).toBeNull();
    });

    it('TC-HTTP-02: GET /api/v1/quote-requests/:id by Artisan without Allocation returns 200 OK with strict contact masking (BR-04)', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);
      const record = createSampleDetailRecord({ allocations: [] });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const res = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=valid-artisan-token' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.recipient_name).toBeUndefined();
      expect(json.data.recipient_phone).toBeUndefined();
      expect(json.data.delivery_address).toBeUndefined();
      expect(json.data.own_allocation_id).toBeUndefined();
      expect(json.data.buyer_id).toBeUndefined();
      expect(json.data.own_recipient.workshop.id).toBe('200');
      expect(json.data.own_quote.id).toBe('701');
      // No competitor quote leaked
      expect(json.data.quotes).toBeUndefined();
    });

    it('TC-HTTP-03: GET /api/v1/quote-requests/:id by Artisan WITH Allocation returns 200 OK with contact unmasked', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);
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

      const record = createSampleDetailRecord({ allocations: [wonAllocation] });
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const res = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=valid-artisan-token' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.recipient_name).toBe('Nguyễn Văn Mua');
      expect(json.data.recipient_phone).toBe('0987654321');
      expect(json.data.delivery_address).toBe('123 Đường Láng, Đống Đa, Hà Nội');
      expect(json.data.own_allocation_id).toBe('901');
      expect(json.data.quotes).toBeUndefined();
    });

    it('TC-HTTP-04: Non-owner Buyer or uninvited Artisan receives HTTP 404 RESOURCE_NOT_FOUND (SEC-06 Anti-IDOR)', async () => {
      // 1. Non-owner Buyer
      identityMock.resolveSession.mockResolvedValueOnce(otherBuyerActor);
      const record = createSampleDetailRecord();
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const resBuyer = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=valid-other-buyer-token' },
      });

      expect(resBuyer.status).toBe(404);
      const jsonBuyer = await resBuyer.json();
      expect(jsonBuyer.code).toBe('RESOURCE_NOT_FOUND');

      // 2. Uninvited Artisan
      identityMock.resolveSession.mockResolvedValueOnce(otherArtisanActor);
      mockRepo.findDetailById.mockResolvedValueOnce(record);

      const resArtisan = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=valid-other-artisan-token' },
      });

      expect(resArtisan.status).toBe(404);
      const jsonArtisan = await resArtisan.json();
      expect(jsonArtisan.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('TC-HTTP-05: Authentication and temp_password session restrictions (SEC-01, SEC-05)', async () => {
      // 1. Missing cookie -> 401 AUTHENTICATION_REQUIRED
      const resUnauth = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
      });
      expect(resUnauth.status).toBe(401);
      const jsonUnauth = await resUnauth.json();
      expect(jsonUnauth.code).toBe('AUTHENTICATION_REQUIRED');

      // 2. temp_password session level -> 403 TEMP_PASSWORD_RESTRICTED
      identityMock.resolveSession.mockResolvedValueOnce(tempPasswordArtisanActor);
      const resTemp = await fetch(`${base}/quote-requests/100`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=temp-artisan-token' },
      });
      expect(resTemp.status).toBe(403);
      const jsonTemp = await resTemp.json();
      expect(jsonTemp.code).toBe('TEMP_PASSWORD_RESTRICTED');
    });

    it('TC-HTTP-06: Malformed path parameter :id returns HTTP 400 INVALID_INPUT', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);

      const res = await fetch(`${base}/quote-requests/invalid-id`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=valid-buyer-token' },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });
  });
});
