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
import {
  QuoteRequest,
  TradingDomainError,
  TradingPermissionDeniedError,
  InvalidTradingInputError,
} from '../../../../src/modules/trading/domain';
import { QuoteRequestMapper } from '../../../../src/modules/trading/adapters/persistence/mappers/quote-request.mapper';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import type {
  InvitedRequestBaseDto,
  InvitedRequestDto,
  InvitedRequestWithAllocationDto,
  QuoteDto,
  RecipientDto,
} from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';

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

const tempPasswordArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '200',
  authVersion: 1,
  sessionId: 'session-temp-artisan',
  sessionLevel: 'temp_password',
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

function createSampleInvitedWithAllocationDto(
  overrides: Partial<InvitedRequestWithAllocationDto> = {},
): InvitedRequestWithAllocationDto {
  const base = createSampleInvitedRequestDto() as InvitedRequestBaseDto;
  return Object.freeze({
    ...base,
    own_allocation_id: '8001',
    recipient_name: 'Nguyễn Văn A',
    recipient_phone: '0912345678',
    delivery_address: '123 Phố Cổ Bát Tràng, Gia Lâm, Hà Nội',
    ...overrides,
  });
}

const identityMock = new MockIdentityContract();

// Memory repository mock backing both unit and http tests
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

class TestTradingModule {}
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
})(TestTradingModule);

describe('Milestone 1: List Artisan Quote Requests (GET /api/v1/artisan/quote-requests — UC-18, BR-04, BR-13)', () => {
  describe('ListArtisanQuoteRequestsUseCase (Application & Domain Isolation)', () => {
    it('TC-01: executes with default pagination (page=1, limit=20, created_at desc) and passes actor workshopId', async () => {
      const txRunner = new MockTransactionRunner();
      const items = [
        createSampleInvitedRequestDto({ id: '1' }),
        createSampleInvitedRequestDto({ id: '2' }),
      ];
      const singleRepo = {
        findArtisanQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items, total: 2 }),
      };
      const useCase = new ListArtisanQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const result = await useCase.execute({
        actor: artisanActor,
        query: { page: 1, limit: 20 },
      });

      expect(singleRepo.findArtisanQuoteRequests).toHaveBeenCalledWith(
        expect.objectContaining({
          workshopId: '200',
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

    it('TC-02: executes with custom pagination (page=2, limit=10)', async () => {
      const txRunner = new MockTransactionRunner();
      const items = [createSampleInvitedRequestDto({ id: '11' })];
      const singleRepo = {
        findArtisanQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items, total: 25 }),
      };
      const useCase = new ListArtisanQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const result = await useCase.execute({
        actor: artisanActor,
        query: { page: 2, limit: 10 },
      });

      expect(singleRepo.findArtisanQuoteRequests).toHaveBeenCalledWith(
        expect.objectContaining({
          workshopId: '200',
          page: 2,
          limit: 10,
        }),
        expect.anything(),
      );
      expect(result.pagination).toEqual({
        page: 2,
        limit: 10,
        total_records: 25,
        total_pages: 3,
      });
    });

    it('TC-03: handles empty list smoothly (items: [], total: 0)', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        findArtisanQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items: [], total: 0 }),
      };
      const useCase = new ListArtisanQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      const result = await useCase.execute({
        actor: artisanActor,
        query: {},
      });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.pagination.total_records).toBe(0);
      expect(result.pagination.total_pages).toBe(0);
    });

    it('TC-04: maps status aliases correctly (bidding, accepted) and passes direct status', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        findArtisanQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items: [], total: 0 }),
      };
      const useCase = new ListArtisanQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      // 1. Alias 'bidding'
      await useCase.execute({
        actor: artisanActor,
        query: { status: 'bidding' },
      });
      expect(singleRepo.findArtisanQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: ['sent_to_artisans', 'artisans_bidding'],
        }),
        expect.anything(),
      );

      // 2. Alias 'accepted'
      await useCase.execute({
        actor: artisanActor,
        query: { status: 'accepted' },
      });
      expect(singleRepo.findArtisanQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'buyer_accepted',
        }),
        expect.anything(),
      );

      // 3. Direct status 'in_production'
      await useCase.execute({
        actor: artisanActor,
        query: { status: 'in_production' },
      });
      expect(singleRepo.findArtisanQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'in_production',
        }),
        expect.anything(),
      );
    });

    it('TC-05: passes response_status filter to repository', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        findArtisanQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items: [], total: 0 }),
      };
      const useCase = new ListArtisanQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await useCase.execute({
        actor: artisanActor,
        query: { response_status: 'quoted' },
      });

      expect(singleRepo.findArtisanQuoteRequests).toHaveBeenCalledWith(
        expect.objectContaining({
          responseStatus: 'quoted',
        }),
        expect.anything(),
      );
    });

    it('TC-06: handles search keyword, trims whitespace and rejects > 100 chars', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        findArtisanQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items: [], total: 0 }),
      };
      const useCase = new ListArtisanQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      // Valid search with whitespace
      await useCase.execute({
        actor: artisanActor,
        query: { search: '  ấm tử sa  ' },
      });
      expect(singleRepo.findArtisanQuoteRequests).toHaveBeenCalledWith(
        expect.objectContaining({
          search: 'ấm tử sa',
        }),
        expect.anything(),
      );

      // Search exceeding 100 characters
      const longSearch = 'x'.repeat(101);
      await expect(
        useCase.execute({
          actor: artisanActor,
          query: { search: longSearch },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('TC-07: handles custom sort_by and order, rejects invalid sort_by', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = {
        findArtisanQuoteRequests: vi
          .fn()
          .mockResolvedValue({ items: [], total: 0 }),
      };
      const useCase = new ListArtisanQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await useCase.execute({
        actor: artisanActor,
        query: { sort_by: 'delivery_deadline', order: 'asc' },
      });
      expect(singleRepo.findArtisanQuoteRequests).toHaveBeenCalledWith(
        expect.objectContaining({
          sortBy: 'delivery_deadline',
          order: 'asc',
        }),
        expect.anything(),
      );

      // Invalid sort_by
      await expect(
        useCase.execute({
          actor: artisanActor,
          query: { sort_by: 'unsupported_field' as any },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('TC-08: role isolation: rejects buyer and admin actors with 403 TradingPermissionDeniedError', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { findArtisanQuoteRequests: vi.fn() };
      const useCase = new ListArtisanQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      // Buyer
      await expect(
        useCase.execute({ actor: buyerActor, query: {} }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      // Admin
      await expect(
        useCase.execute({ actor: adminActor, query: {} }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('TC-09: workshop isolation (SEC-06): rejects artisan actor with workshopId: null', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { findArtisanQuoteRequests: vi.fn() };
      const useCase = new ListArtisanQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({ actor: artisanWithoutWorkshopActor, query: {} }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('TC-10: temp_password restriction (SEC-05): rejects temp password session', async () => {
      const txRunner = new MockTransactionRunner();
      const singleRepo = { findArtisanQuoteRequests: vi.fn() };
      const useCase = new ListArtisanQuoteRequestsUseCase(
        txRunner as any,
        singleRepo as any,
      );

      await expect(
        useCase.execute({ actor: tempPasswordArtisanActor, query: {} }),
      ).rejects.toThrow(TradingDomainError);
    });
  });

  describe('BR-04 / SEC-04 Data Masking Verification', () => {
    it('TC-11: BR-04 Data Masking when workshop has NO allocation (omits recipient_name, phone, address, own_allocation_id)', () => {
      const entity = QuoteRequest.reconstitute({
        id: '10001',
        buyer_id: '10',
        category_id: '3',
        spec: 'Bình hoa men lam Bát Tràng',
        quantity: 50,
        unit: 'piece',
        unit_set_description: null,
        status: 'artisans_bidding',
        delivery_mode: 'at_buyer_address',
        delivery_region: 'Hà Nội, Gia Lâm',
        delivery_address: 'Số 99 Hàng Đào, Hoàn Kiếm, Hà Nội (Địa Chỉ Mật)',
        recipient_name: 'Trần Thị B (Tên Người Nhận Mật)',
        recipient_phone: '0988776655',
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

      const recipientDto: RecipientDto = {
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

      const quoteDto: QuoteDto = {
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

      // When ownAllocationId is null/undefined
      const dto = QuoteRequestMapper.toInvitedRequestDto(entity, {
        category: { id: '3', name: 'Gốm Bát Tràng' },
        now: new Date('2026-11-12T10:00:00Z'),
        ownRecipient: recipientDto,
        ownQuote: quoteDto,
        ownAllocationId: null,
      });

      // Assert that sensitive fields are completely omitted/undefined
      expect((dto as any).recipient_name).toBeUndefined();
      expect((dto as any).recipient_phone).toBeUndefined();
      expect((dto as any).delivery_address).toBeUndefined();
      expect((dto as any).own_allocation_id).toBeUndefined();
      expect((dto as any).buyer_id).toBeUndefined();

      // Assert that non-sensitive fields are present
      expect(dto.delivery_region).toBe('Hà Nội, Gia Lâm');
      expect(dto.delivery_mode).toBe('at_buyer_address');
      expect(dto.spec).toBe('Bình hoa men lam Bát Tràng');
      expect(dto.own_recipient).toBe(recipientDto);
      expect(dto.own_quote).toBe(quoteDto);
    });

    it('TC-12: BR-04 Data Unmasking when workshop HAS confirmed allocation', () => {
      const entity = QuoteRequest.reconstitute({
        id: '10001',
        buyer_id: '10',
        category_id: '3',
        spec: 'Bình hoa men lam Bát Tràng',
        quantity: 50,
        unit: 'piece',
        unit_set_description: null,
        status: 'buyer_accepted',
        delivery_mode: 'at_buyer_address',
        delivery_region: 'Hà Nội, Gia Lâm',
        delivery_address: 'Số 99 Hàng Đào, Hoàn Kiếm, Hà Nội',
        recipient_name: 'Trần Thị B',
        recipient_phone: '0988776655',
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

      const recipientDto: RecipientDto = {
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

      const quoteDto: QuoteDto = {
        id: '7001',
        request_id: '10001',
        workshop: { id: '200', name: 'Xưởng Gốm An Thịnh' },
        unit_price: 250000,
        max_quantity: 50,
        bid_accept_deadline: '2026-12-05T10:00:00.000Z',
        committed_delivery_at: '2026-12-14T10:00:00.000Z',
        status: 'accepted',
        version: 2,
        withdraw_reason: null,
        withdrawn_at: null,
        is_eligible: true,
        ineligible_reasons: [],
        created_at: '2026-11-11T10:00:00.000Z',
        updated_at: '2026-11-15T10:00:00.000Z',
      };

      // With ownAllocationId = '8001'
      const dto = QuoteRequestMapper.toInvitedRequestDto(entity, {
        category: { id: '3', name: 'Gốm Bát Tràng' },
        now: new Date('2026-11-16T10:00:00Z'),
        ownRecipient: recipientDto,
        ownQuote: quoteDto,
        ownAllocationId: '8001',
      }) as InvitedRequestWithAllocationDto;

      expect(dto.own_allocation_id).toBe('8001');
      expect(dto.recipient_name).toBe('Trần Thị B');
      expect(dto.recipient_phone).toBe('0988776655');
      expect(dto.delivery_address).toBe('Số 99 Hàng Đào, Hoàn Kiếm, Hà Nội');
      expect((dto as any).buyer_id).toBeUndefined();
    });

    it('TC-13: Historic allocation retention: artisan with allocation retains contact info after request cancelled or delivered', () => {
      // 1. Cancelled request with allocation
      const cancelledEntity = QuoteRequest.reconstitute({
        id: '10002',
        buyer_id: '10',
        category_id: '3',
        spec: 'Lọ hoa gốm đỏ',
        quantity: 20,
        unit: 'piece',
        unit_set_description: null,
        status: 'buyer_accepted',
        delivery_mode: 'at_buyer_address',
        delivery_region: 'Đà Nẵng',
        delivery_address: '456 Bạch Đằng, Đà Nẵng',
        recipient_name: 'Lê Văn C',
        recipient_phone: '0905123456',
        bidding_deadline: new Date('2026-11-15T10:00:00Z'),
        delivery_deadline: new Date('2026-12-01T10:00:00Z'),
        bidding_closed_at: new Date('2026-11-14T10:00:00Z'),
        version: 3,
        cancelled_at: new Date('2026-11-20T10:00:00Z'),
        cancelled_by: '10',
        cancel_reason: 'Buyer thay đổi kế hoạch sản xuất',
        created_at: new Date('2026-11-10T10:00:00Z'),
        updated_at: new Date('2026-11-20T10:00:00Z'),
      });

      const recipientDto: RecipientDto = {
        id: '5002',
        request_id: '10002',
        workshop: { id: '200', name: 'Xưởng Gốm An Thịnh' },
        response_status: 'quoted',
        version: 1,
        sent_at: '2026-11-10T10:00:00.000Z',
        responded_at: '2026-11-11T10:00:00.000Z',
        decline_reason: null,
        eligibility_labels: [],
      };

      // Artisan with historic allocation on cancelled request
      const allocatedDto = QuoteRequestMapper.toInvitedRequestDto(
        cancelledEntity,
        {
          category: { id: '3', name: 'Gốm Bát Tràng' },
          now: new Date('2026-11-21T10:00:00Z'),
          ownRecipient: recipientDto,
          ownQuote: null,
          ownAllocationId: '8002',
        },
      ) as InvitedRequestWithAllocationDto;

      expect(allocatedDto.own_allocation_id).toBe('8002');
      expect(allocatedDto.recipient_name).toBe('Lê Văn C');
      expect(allocatedDto.recipient_phone).toBe('0905123456');
      expect(allocatedDto.delivery_address).toBe('456 Bạch Đằng, Đà Nẵng');
      expect(allocatedDto.cancelled_at).toBe('2026-11-20T10:00:00.000Z');

      // Another artisan without allocation on the SAME cancelled request
      const unallocatedDto = QuoteRequestMapper.toInvitedRequestDto(
        cancelledEntity,
        {
          category: { id: '3', name: 'Gốm Bát Tràng' },
          now: new Date('2026-11-21T10:00:00Z'),
          ownRecipient: { ...recipientDto, id: '5003', workshop: { id: '201', name: 'Xưởng Khác' } },
          ownQuote: null,
          ownAllocationId: null,
        },
      );

      expect((unallocatedDto as any).recipient_name).toBeUndefined();
      expect((unallocatedDto as any).recipient_phone).toBeUndefined();
      expect((unallocatedDto as any).delivery_address).toBeUndefined();
      expect((unallocatedDto as any).own_allocation_id).toBeUndefined();
    });

    it('TC-14: Zero-Knowledge Competitor Isolation: never expose competitor quotes or recipients', () => {
      const dto = createSampleInvitedRequestDto();

      // DTO has only own_recipient and own_quote
      expect(dto).toHaveProperty('own_recipient');
      expect(dto).toHaveProperty('own_quote');

      // Competitor collections must NOT exist
      expect((dto as any).recipients).toBeUndefined();
      expect((dto as any).quotes).toBeUndefined();
      expect((dto as any).allocations).toBeUndefined();
      expect((dto as any).buyer).toBeUndefined();
      expect((dto as any).buyer_id).toBeUndefined();
    });
  });

  describe('ArtisanQuoteRequestController (HTTP Endpoints & Guards)', () => {
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

    it('TC-15: GET /artisan/quote-requests succeeds with 200 OK and enveloped pagination', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);
      mockRepo.findArtisanQuoteRequests.mockResolvedValueOnce({
        items: [createSampleInvitedRequestDto({ id: '10001' })],
        total: 1,
      });

      const res = await fetch(`${base}/artisan/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=valid-artisan-token' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('10001');
      expect(json.data[0].own_recipient.workshop.id).toBe('200');
      expect(json.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 1,
        total_pages: 1,
      });
    });

    it('TC-16: GET /artisan/quote-requests rejects unauthenticated request with 401', async () => {
      const res = await fetch(`${base}/artisan/quote-requests`, {
        method: 'GET',
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('TC-17: GET /artisan/quote-requests rejects non-artisan role (buyer) with 403', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(buyerActor);
      const res = await fetch(`${base}/artisan/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=buyer-token' },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
    });

    it('TC-18: GET /artisan/quote-requests rejects temp_password session with 403', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(
        tempPasswordArtisanActor,
      );
      const res = await fetch(`${base}/artisan/quote-requests`, {
        method: 'GET',
        headers: { Cookie: 'vcraft-session=temp-artisan-token' },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
    });

    it('TC-19: query validation rejects invalid inputs and unknown parameters with 400 Bad Request', async () => {
      // 1. Unknown query parameter (strict Zod schema)
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);
      const resUnknown = await fetch(
        `${base}/artisan/quote-requests?unexpected_param=value`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-artisan-token' },
        },
      );
      expect(resUnknown.status).toBe(400);
      const jsonUnknown = await resUnknown.json();
      expect(jsonUnknown.code).toBe('INVALID_INPUT');
      expect(jsonUnknown.errors[0].field).toBe('/unexpected_param');

      // 2. page=0
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);
      const resPageZero = await fetch(
        `${base}/artisan/quote-requests?page=0`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-artisan-token' },
        },
      );
      expect(resPageZero.status).toBe(400);

      // 3. limit=101
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);
      const resLimitExceed = await fetch(
        `${base}/artisan/quote-requests?limit=101`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-artisan-token' },
        },
      );
      expect(resLimitExceed.status).toBe(400);

      // 4. invalid status
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);
      const resInvalidStatus = await fetch(
        `${base}/artisan/quote-requests?status=invalid_status`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-artisan-token' },
        },
      );
      expect(resInvalidStatus.status).toBe(400);

      // 5. invalid response_status
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);
      const resInvalidResponseStatus = await fetch(
        `${base}/artisan/quote-requests?response_status=unknown_response`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-artisan-token' },
        },
      );
      expect(resInvalidResponseStatus.status).toBe(400);

      // 6. invalid sort_by
      identityMock.resolveSession.mockResolvedValueOnce(artisanActor);
      const resInvalidSort = await fetch(
        `${base}/artisan/quote-requests?sort_by=hacker_field`,
        {
          method: 'GET',
          headers: { Cookie: 'vcraft-session=valid-artisan-token' },
        },
      );
      expect(resInvalidSort.status).toBe(400);
    });
  });
});
