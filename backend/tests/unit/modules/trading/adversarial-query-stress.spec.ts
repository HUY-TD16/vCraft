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
  InvalidTradingInputError,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import { PrismaQuoteRequestRepository } from '../../../../src/modules/trading/adapters/persistence/repositories/quote-request.repository';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import type { InvitedRequestDto } from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';

const validArtisan: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '200',
  authVersion: 1,
  sessionId: 'session-artisan-test',
  sessionLevel: 'normal',
});

function createDummyInvitedDto(id: string): InvitedRequestDto {
  return {
    id,
    status: 'artisans_bidding',
    version: 1,
    category: { id: '3', name: 'Gốm Sứ' },
    spec: 'Mô tả thử nghiệm',
    quantity: 50,
    unit: 'piece',
    unit_set_description: null,
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội',
    bidding_deadline: '2026-12-01T10:00:00.000Z',
    delivery_deadline: '2026-12-15T10:00:00.000Z',
    bidding_closed_at: null,
    is_bidding_open: true,
    cancelled_at: null,
    created_at: '2026-11-10T10:00:00.000Z',
    updated_at: '2026-11-10T10:00:00.000Z',
    own_recipient: {
      id: '5001',
      request_id: id,
      workshop: { id: '200', name: 'Xưởng Test' },
      response_status: 'pending',
      version: 1,
      sent_at: '2026-11-10T10:05:00.000Z',
      responded_at: null,
      decline_reason: null,
      eligibility_labels: [],
    },
    own_quote: null,
  };
}

const identityMock = new MockIdentityContract();
const mockRepo = {
  findArtisanQuoteRequests: vi.fn(),
  findBuyerQuoteRequests: vi.fn(),
  createDraft: vi.fn(),
};

class StressIdentityModule {}
Module({
  providers: [{ provide: IDENTITY_CONTRACT, useValue: identityMock }],
  exports: [IDENTITY_CONTRACT],
})(StressIdentityModule);

class StressTradingModule {}
Module({
  imports: [AppConfigModule, SecurityModule.register([StressIdentityModule])],
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
})(StressTradingModule);

describe('Adversarial Query & Stress Testing (Challenger 1)', () => {
  let app: NestExpressApplication;
  let base: string;

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/test');
    vi.stubEnv(
      'SESSION_SECRET',
      'test_secret_32_chars_for_development_purposes',
    );
    vi.stubEnv('NODE_ENV', 'development');

    app = await NestFactory.create<NestExpressApplication>(StressTradingModule, {
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

  const makeRequest = async (queryString: string) => {
    identityMock.resolveSession.mockResolvedValueOnce(validArtisan);
    return fetch(`${base}/artisan/quote-requests?${queryString}`, {
      method: 'GET',
      headers: { Cookie: 'vcraft-session=valid-artisan-session' },
    });
  };

  describe('1. Malformed / Injection & Unrecognized Parameters (Zod Strictness)', () => {
    it('ST-01: rejects unrecognized query parameter with 400 INVALID_INPUT', async () => {
      const res = await makeRequest('extra_field=bad_payload');
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: '/extra_field' }),
        ]),
      );
    });

    it('ST-02: rejects prototype pollution attempts (__proto__, constructor) with 400', async () => {
      const resProto = await makeRequest('__proto__=polluted');
      expect(resProto.status).toBe(400);
      const jsonProto = await resProto.json();
      expect(jsonProto.code).toBe('INVALID_INPUT');

      const resCtor = await makeRequest('constructor=polluted');
      expect(resCtor.status).toBe(400);
    });

    it('ST-03: rejects non-numeric page string with 400', async () => {
      const res = await makeRequest('page=abc');
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('ST-04: rejects float page (1.5) and scientific notation (1e2) with 400', async () => {
      const resFloat = await makeRequest('page=1.5');
      expect(resFloat.status).toBe(400);

      const resSci = await makeRequest('page=1e2');
      expect(resSci.status).toBe(400);
    });

    it('ST-05: rejects SQL injection in enum parameters with 400', async () => {
      const resSqlStatus = await makeRequest("status=' OR '1'='1");
      expect(resSqlStatus.status).toBe(400);

      const resSqlSort = await makeRequest("sort_by=id;DROP TABLE quote_requests;");
      expect(resSqlSort.status).toBe(400);

      const resSqlOrder = await makeRequest("order=asc;DROP TABLE");
      expect(resSqlOrder.status).toBe(400);
    });
  });

  describe('2. Extreme Pagination Boundaries', () => {
    it('ST-06: rejects page=0 with 400', async () => {
      const res = await makeRequest('page=0');
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('ST-07: rejects negative page (page=-1) with 400', async () => {
      const res = await makeRequest('page=-1');
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('ST-08: rejects limit=0 with 400', async () => {
      const res = await makeRequest('limit=0');
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
    });

    it('ST-09: rejects limit exceeding maximum (limit=101 and limit=9999) with 400', async () => {
      const res101 = await makeRequest('limit=101');
      expect(res101.status).toBe(400);

      const res9999 = await makeRequest('limit=9999');
      expect(res9999.status).toBe(400);
    });

    it('ST-10: accepts boundary limits: limit=1 and limit=100 with 200 OK', async () => {
      mockRepo.findArtisanQuoteRequests.mockResolvedValueOnce({
        items: [createDummyInvitedDto('101')],
        total: 1,
      });
      const res1 = await makeRequest('limit=1');
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.pagination.limit).toBe(1);

      mockRepo.findArtisanQuoteRequests.mockResolvedValueOnce({
        items: [createDummyInvitedDto('102')],
        total: 1,
      });
      const res100 = await makeRequest('limit=100');
      expect(res100.status).toBe(200);
      const json100 = await res100.json();
      expect(json100.pagination.limit).toBe(100);
    });

    it('ST-11: handles overflow page smoothly (page=999999 with 5 total records)', async () => {
      mockRepo.findArtisanQuoteRequests.mockResolvedValueOnce({
        items: [],
        total: 5,
      });
      const res = await makeRequest('page=999999&limit=20');
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toEqual([]);
      expect(json.pagination).toEqual({
        page: 999999,
        limit: 20,
        total_records: 5,
        total_pages: 1,
      });
    });
  });

  describe('3. Status Edge Cases & Aliases', () => {
    it('ST-12: rejects invalid statuses with 400', async () => {
      const invalidStatuses = ['pending', 'active', 'completed', 'DRAFT', 'foo_bar'];
      for (const st of invalidStatuses) {
        const res = await makeRequest(`status=${st}`);
        expect(res.status).toBe(400);
      }
    });

    it('ST-13: supports alias status "bidding" -> routes to ["sent_to_artisans", "artisans_bidding"]', async () => {
      mockRepo.findArtisanQuoteRequests.mockResolvedValueOnce({
        items: [createDummyInvitedDto('201')],
        total: 1,
      });
      const res = await makeRequest('status=bidding');
      expect(res.status).toBe(200);
      expect(mockRepo.findArtisanQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: ['sent_to_artisans', 'artisans_bidding'],
        }),
        expect.anything(),
      );
    });

    it('ST-14: supports alias status "accepted" -> routes to "buyer_accepted"', async () => {
      mockRepo.findArtisanQuoteRequests.mockResolvedValueOnce({
        items: [createDummyInvitedDto('202')],
        total: 1,
      });
      const res = await makeRequest('status=accepted');
      expect(res.status).toBe(200);
      expect(mockRepo.findArtisanQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'buyer_accepted',
        }),
        expect.anything(),
      );
    });

    it('ST-15: supports all direct domain statuses (in_production, delivered, cancelled, draft_request)', async () => {
      const domainStatuses = ['in_production', 'delivered', 'cancelled', 'draft_request'];
      for (const st of domainStatuses) {
        mockRepo.findArtisanQuoteRequests.mockResolvedValueOnce({
          items: [],
          total: 0,
        });
        const res = await makeRequest(`status=${st}`);
        expect(res.status).toBe(200);
        expect(mockRepo.findArtisanQuoteRequests).toHaveBeenLastCalledWith(
          expect.objectContaining({
            status: st,
          }),
          expect.anything(),
        );
      }
    });

    it('ST-16: validates response_status edge cases (rejects "accepted" or "unknown", accepts "quoted")', async () => {
      const resBad = await makeRequest('response_status=accepted');
      expect(resBad.status).toBe(400);

      mockRepo.findArtisanQuoteRequests.mockResolvedValueOnce({
        items: [],
        total: 0,
      });
      const resQuoted = await makeRequest('response_status=quoted');
      expect(resQuoted.status).toBe(200);
      expect(mockRepo.findArtisanQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({
          responseStatus: 'quoted',
        }),
        expect.anything(),
      );
    });
  });

  describe('4. Search Strings (Empty, Whitespace, Unicode, Special Chars, Length > 100)', () => {
    it('ST-17: handles empty search string ("search=") -> normalizes to undefined', async () => {
      mockRepo.findArtisanQuoteRequests.mockResolvedValueOnce({
        items: [],
        total: 0,
      });
      const res = await makeRequest('search=');
      expect(res.status).toBe(200);
      expect(mockRepo.findArtisanQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({
          search: undefined,
        }),
        expect.anything(),
      );
    });

    it('ST-18: handles whitespace-only search string ("search=%20%20%20") -> normalizes to undefined', async () => {
      mockRepo.findArtisanQuoteRequests.mockResolvedValueOnce({
        items: [],
        total: 0,
      });
      const res = await makeRequest('search=%20%20%20');
      expect(res.status).toBe(200);
      expect(mockRepo.findArtisanQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({
          search: undefined,
        }),
        expect.anything(),
      );
    });

    it('ST-19: supports complex Vietnamese unicode and special characters in search', async () => {
      mockRepo.findArtisanQuoteRequests.mockResolvedValueOnce({
        items: [],
        total: 0,
      });
      const keyword = encodeURIComponent('Bộ ấm chén Bát Tràng men hoả biến (VIP) #123!');
      const res = await makeRequest(`search=${keyword}`);
      expect(res.status).toBe(200);
      expect(mockRepo.findArtisanQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({
          search: 'Bộ ấm chén Bát Tràng men hoả biến (VIP) #123!',
        }),
        expect.anything(),
      );
    });

    it('ST-20: rejects search exceeding 100 characters with 400', async () => {
      const longKeyword = 'a'.repeat(101);
      const res = await makeRequest(`search=${longKeyword}`);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('INVALID_INPUT');
      expect(json.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: '/search' }),
        ]),
      );
    });

    it('ST-21: accepts search with exactly 100 characters with 200 OK', async () => {
      mockRepo.findArtisanQuoteRequests.mockResolvedValueOnce({
        items: [],
        total: 0,
      });
      const exact100 = 'x'.repeat(100);
      const res = await makeRequest(`search=${exact100}`);
      expect(res.status).toBe(200);
      expect(mockRepo.findArtisanQuoteRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({
          search: exact100,
        }),
        expect.anything(),
      );
    });
  });

  describe('5. Sorting Validation (Whitelisted Columns & Order)', () => {
    it('ST-22: rejects invalid sort columns with 400 INVALID_INPUT', async () => {
      const invalidSorts = ['price', 'buyer_id', 'password', 'status', 'workshop_id'];
      for (const col of invalidSorts) {
        const res = await makeRequest(`sort_by=${col}`);
        expect(res.status).toBe(400);
      }
    });

    it('ST-23: rejects invalid sort orders ("ascending", "none", "DESC", "1") with 400', async () => {
      const invalidOrders = ['ascending', 'none', 'DESC', '1', 'asc;DROP'];
      for (const ord of invalidOrders) {
        const res = await makeRequest(`order=${ord}`);
        expect(res.status).toBe(400);
      }
    });

    it('ST-24: accepts all whitelisted sort columns with asc/desc', async () => {
      const allowedCols = [
        'created_at',
        'bidding_deadline',
        'delivery_deadline',
        'quantity',
        'id',
      ];
      for (const col of allowedCols) {
        for (const ord of ['asc', 'desc'] as const) {
          mockRepo.findArtisanQuoteRequests.mockResolvedValueOnce({
            items: [],
            total: 0,
          });
          const res = await makeRequest(`sort_by=${col}&order=${ord}`);
          expect(res.status).toBe(200);
          expect(mockRepo.findArtisanQuoteRequests).toHaveBeenLastCalledWith(
            expect.objectContaining({
              sortBy: col,
              order: ord,
            }),
            expect.anything(),
          );
        }
      }
    });
  });

  describe('6. Direct UseCase Unit Level Edge Cases (Boundary & Error Conditions)', () => {
    const txRunner = new MockTransactionRunner();
    const useCase = new ListArtisanQuoteRequestsUseCase(
      txRunner as any,
      mockRepo as any,
    );

    it('ST-25: UseCase rejects non-artisan role with TradingPermissionDeniedError', async () => {
      await expect(
        useCase.execute({
          actor: { ...validArtisan, role: 'buyer' as any },
          query: {},
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('ST-26: UseCase rejects actor with null workshopId with TradingPermissionDeniedError', async () => {
      await expect(
        useCase.execute({
          actor: { ...validArtisan, workshopId: null },
          query: {},
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
    });

    it('ST-27: UseCase rejects temp_password session with TradingDomainError', async () => {
      await expect(
        useCase.execute({
          actor: { ...validArtisan, sessionLevel: 'temp_password' },
          query: {},
        }),
      ).rejects.toThrow(TradingDomainError);
    });

    it('ST-28: UseCase rejects invalid page in direct invocation with InvalidTradingInputError', async () => {
      await expect(
        useCase.execute({
          actor: validArtisan,
          query: { page: 0 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: validArtisan,
          query: { page: -5 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: validArtisan,
          query: { page: 1.5 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('ST-29: UseCase rejects invalid limit in direct invocation with InvalidTradingInputError', async () => {
      await expect(
        useCase.execute({
          actor: validArtisan,
          query: { limit: 0 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: validArtisan,
          query: { limit: 101 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('ST-30: UseCase rejects invalid sortBy, order, status, response_status and search > 100', async () => {
      await expect(
        useCase.execute({
          actor: validArtisan,
          query: { sort_by: 'invalid_col' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: validArtisan,
          query: { order: 'invalid_order' as any },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: validArtisan,
          query: { status: 'invalid_status' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: validArtisan,
          query: { response_status: 'invalid_resp' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: validArtisan,
          query: { search: 'x'.repeat(101) },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });
  });

  describe('7. PrismaQuoteRequestRepository.findArtisanQuoteRequests Query Assembly & Isolation Stress Tests', () => {
    it('ST-31: generates strict Prisma where conditions for status filters and search', async () => {
      const client = {
        quoteRequest: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      const txRunner = {
        getClient: vi.fn().mockReturnValue(client),
      };
      const repo = new PrismaQuoteRequestRepository(txRunner as any);

      // Search with keyword + bidding alias status + quoted response status
      await repo.findArtisanQuoteRequests(
        {
          workshopId: '200',
          page: 2,
          limit: 15,
          status: ['sent_to_artisans', 'artisans_bidding'],
          responseStatus: 'quoted',
          search: '1005',
          sortBy: 'quantity',
          order: 'desc',
          now: new Date('2026-11-12T10:00:00Z'),
        },
        {} as any,
      );

      expect(client.quoteRequest.findMany).toHaveBeenCalledWith({
        where: {
          AND: [
            {
              requestRecipients: {
                some: {
                  workshop_id: 200n,
                  response_status: 'quoted',
                },
              },
            },
            {
              status: { in: ['sent_to_artisans', 'artisans_bidding'] },
              cancelled_at: null,
            },
            {
              OR: [
                { spec: { contains: '1005', mode: 'insensitive' } },
                {
                  category: {
                    is: { name: { contains: '1005', mode: 'insensitive' } },
                  },
                },
                { id: 1005n },
              ],
            },
          ],
        },
        orderBy: [{ quantity: 'desc' }, { id: 'desc' }],
        skip: 15,
        take: 15,
        include: expect.objectContaining({
          category: true,
          requestRecipients: {
            where: { workshop_id: 200n },
            include: { workshop: true },
          },
          quotes: {
            where: { workshop_id: 200n },
            include: { workshop: true },
          },
          allocations: {
            where: { workshop_id: 200n },
          },
        }),
      });
    });

    it('ST-32: throws invariant error if recipient row is somehow missing from query response', async () => {
      const client = {
        quoteRequest: {
          count: vi.fn().mockResolvedValue(1),
          findMany: vi.fn().mockResolvedValue([
            {
              id: 9999n,
              buyer_id: 10n,
              category_id: 1n,
              spec: 'Test',
              quantity: 1,
              unit: 'piece',
              unit_set_description: null,
              status: 'artisans_bidding',
              delivery_mode: 'at_buyer_address',
              delivery_region: 'HN',
              delivery_address: '123 Test',
              recipient_name: 'A',
              recipient_phone: '0901',
              bidding_deadline: new Date('2026-11-15T10:00:00Z'),
              delivery_deadline: new Date('2026-11-20T10:00:00Z'),
              bidding_closed_at: null,
              version: 1,
              cancelled_at: null,
              cancelled_by: null,
              cancel_reason: null,
              created_at: new Date(),
              updated_at: new Date(),
              category: { id: 1n, name: 'Gốm' },
              requestRecipients: [], // Empty recipients array violates recipient invariant
              quotes: [],
              allocations: [],
            },
          ]),
        },
      };
      const txRunner = {
        getClient: vi.fn().mockReturnValue(client),
      };
      const repo = new PrismaQuoteRequestRepository(txRunner as any);

      await expect(
        repo.findArtisanQuoteRequests(
          {
            workshopId: '200',
            page: 1,
            limit: 10,
            now: new Date(),
          },
          {} as any,
        ),
      ).rejects.toThrow(
        /Integrity invariant violated: missing RequestRecipient for workshop 200 on request 9999/,
      );
    });
  });
});
