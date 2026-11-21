import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../../src/infrastructure/database/prisma/prisma.service';
import { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import {
  InvalidTradingInputError,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import {
  PrismaQuoteRequestRepository,
  QuoteRequestMapper,
} from '../../../../src/modules/trading/adapters/persistence';
import { ListAdminQuoteRequestsUseCase } from '../../../../src/modules/trading/application/use-cases/requests/list-admin-quote-requests.use-case';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';

const BASE_NOW = new Date('2026-11-13T10:00:00.000Z');
const BIDDING_DEADLINE = new Date('2026-11-20T10:00:00.000Z');
const DELIVERY_DEADLINE = new Date('2026-12-01T10:00:00.000Z');

function buildQuoteRequestPrismaRow(
  overrides: Partial<{
    id: bigint;
    buyer_id: bigint;
    category_id: bigint | null;
    spec: string | null;
    quantity: number | null;
    unit: string | null;
    unit_set_description: string | null;
    status: string;
    delivery_mode: string | null;
    delivery_region: string | null;
    delivery_address: string | null;
    recipient_name: string | null;
    recipient_phone: string | null;
    bidding_deadline: Date | null;
    delivery_deadline: Date | null;
    bidding_closed_at: Date | null;
    version: number;
    cancelled_at: Date | null;
    cancelled_by: bigint | null;
    cancel_reason: string | null;
    created_at: Date;
    updated_at: Date;
  }> = {},
) {
  return {
    id: 1001n,
    buyer_id: 10n,
    category_id: 5n,
    spec: 'Handcrafted ceramic tea set',
    quantity: 50,
    unit: 'piece',
    unit_set_description: null,
    status: 'artisans_bidding',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hanoi',
    delivery_address: '123 Hang Gai, Hoan Kiem, Hanoi',
    recipient_name: 'Nguyen Van B',
    recipient_phone: '0912345678',
    bidding_deadline: BIDDING_DEADLINE,
    delivery_deadline: DELIVERY_DEADLINE,
    bidding_closed_at: null,
    version: 1,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: BASE_NOW,
    updated_at: BASE_NOW,
    ...overrides,
  };
}

function createMockTxRunner(mockClient: Record<string, unknown>) {
  const mockPrismaService = {
    $transaction: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) => await fn(mockClient),
    ),
  } as unknown as PrismaService;

  const txRunner = new PrismaTransactionRunner(mockPrismaService);
  return { txRunner, mockPrismaService };
}

const adminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-admin',
  sessionLevel: 'normal',
});

const buyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer',
  sessionLevel: 'normal',
});

const tempAdminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-temp-admin',
  sessionLevel: 'temp_password',
});

describe('Challenger 2 Empirical Verification: Domain Logic & Business Rules (Milestone 1)', () => {
  // =========================================================================
  // 1. DYNAMIC FIELD CALCULATION ACCURACY: is_bidding_open
  // =========================================================================
  describe('1. Dynamic Field Calculation Accuracy: is_bidding_open', () => {
    it('CHAL-DYN-01: returns true when now < bidding_deadline and status in [sent_to_artisans, artisans_bidding]', () => {
      const rowSent = buildQuoteRequestPrismaRow({
        status: 'sent_to_artisans',
        bidding_deadline: BIDDING_DEADLINE,
        bidding_closed_at: null,
        cancelled_at: null,
      });
      const entitySent = QuoteRequestMapper.toDomain(rowSent);
      const summarySent = QuoteRequestMapper.toSummaryDto(entitySent, {
        category: null,
        now: new Date(BIDDING_DEADLINE.getTime() - 1000), // 1s before deadline
      });
      expect(summarySent.is_bidding_open).toBe(true);

      const rowBidding = buildQuoteRequestPrismaRow({
        status: 'artisans_bidding',
        bidding_deadline: BIDDING_DEADLINE,
        bidding_closed_at: null,
        cancelled_at: null,
      });
      const entityBidding = QuoteRequestMapper.toDomain(rowBidding);
      const summaryBidding = QuoteRequestMapper.toSummaryDto(entityBidding, {
        category: null,
        now: new Date(BIDDING_DEADLINE.getTime() - 1), // 1ms before deadline
      });
      expect(summaryBidding.is_bidding_open).toBe(true);
    });

    it('CHAL-DYN-02: returns false at the exact millisecond boundary when now === bidding_deadline', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'artisans_bidding',
        bidding_deadline: BIDDING_DEADLINE,
      });
      const entity = QuoteRequestMapper.toDomain(row);
      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: new Date(BIDDING_DEADLINE.getTime()), // exact deadline
      });
      expect(summary.is_bidding_open).toBe(false);
    });

    it('CHAL-DYN-03: returns false when now > bidding_deadline (bidding expired)', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'artisans_bidding',
        bidding_deadline: BIDDING_DEADLINE,
      });
      const entity = QuoteRequestMapper.toDomain(row);
      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: new Date(BIDDING_DEADLINE.getTime() + 1000), // 1s past deadline
      });
      expect(summary.is_bidding_open).toBe(false);
    });

    it('CHAL-DYN-04: returns false when bidding_closed_at is set even if now < bidding_deadline', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'artisans_bidding',
        bidding_deadline: BIDDING_DEADLINE,
        bidding_closed_at: new Date('2026-11-15T12:00:00.000Z'),
      });
      const entity = QuoteRequestMapper.toDomain(row);
      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: new Date('2026-11-14T10:00:00.000Z'), // before closed_at and before deadline
      });
      expect(summary.is_bidding_open).toBe(false);
    });

    it('CHAL-DYN-05: returns false when cancelled_at is set even if now < bidding_deadline', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'artisans_bidding',
        bidding_deadline: BIDDING_DEADLINE,
        cancelled_at: new Date('2026-11-14T08:00:00.000Z'),
        cancelled_by: 1n,
      });
      const entity = QuoteRequestMapper.toDomain(row);
      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: new Date('2026-11-15T10:00:00.000Z'),
      });
      expect(summary.is_bidding_open).toBe(false);
    });

    it('CHAL-DYN-06: returns false when status is draft_request regardless of deadlines', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'draft_request',
        bidding_deadline: BIDDING_DEADLINE,
        delivery_mode: null,
        recipient_name: null,
        recipient_phone: null,
        delivery_address: null,
        delivery_region: null,
      });
      const entity = QuoteRequestMapper.toDomain(row);
      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: new Date('2026-11-14T10:00:00.000Z'),
      });
      expect(summary.is_bidding_open).toBe(false);
    });

    it('CHAL-DYN-07: returns false when status is buyer_accepted, in_production, or delivered', () => {
      const postBiddingStatuses = ['buyer_accepted', 'in_production', 'delivered'] as const;
      for (const status of postBiddingStatuses) {
        const row = buildQuoteRequestPrismaRow({
          status,
          bidding_deadline: BIDDING_DEADLINE,
          delivery_deadline: DELIVERY_DEADLINE,
        });
        const entity = QuoteRequestMapper.toDomain(row);
        const summary = QuoteRequestMapper.toSummaryDto(entity, {
          category: null,
          now: new Date('2026-11-14T10:00:00.000Z'),
        });
        expect(summary.is_bidding_open).toBe(false);
      }
    });

    it('CHAL-DYN-08: returns false when bidding_deadline is null (draft_request)', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'draft_request',
        bidding_deadline: null,
        delivery_deadline: null,
        delivery_mode: null,
        recipient_name: null,
        recipient_phone: null,
        delivery_address: null,
        delivery_region: null,
      });
      const entity = QuoteRequestMapper.toDomain(row);
      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: new Date('2026-11-14T10:00:00.000Z'),
      });
      expect(summary.is_bidding_open).toBe(false);
    });
  });

  // =========================================================================
  // 2. DYNAMIC FIELD CALCULATION ACCURACY: no_valid_quotes
  // =========================================================================
  describe('2. Dynamic Field Calculation Accuracy: no_valid_quotes', () => {
    it('CHAL-NVQ-01: triggers true ONLY when status is artisans_bidding and eligible quote count is 0', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'artisans_bidding',
        bidding_deadline: BIDDING_DEADLINE,
        delivery_deadline: DELIVERY_DEADLINE,
      });
      const entity = QuoteRequestMapper.toDomain(row);
      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: BASE_NOW,
        quotes: [], // 0 quotes
      });
      expect(summary.no_valid_quotes).toBe(true);
    });

    it('CHAL-NVQ-02: returns false when status is artisans_bidding and at least one eligible quote exists', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'artisans_bidding',
        delivery_deadline: DELIVERY_DEADLINE,
      });
      const entity = QuoteRequestMapper.toDomain(row);
      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: BASE_NOW,
        quotes: [
          {
            status: 'active',
            bid_accept_deadline: new Date('2026-11-25T10:00:00.000Z'),
            committed_delivery_at: new Date('2026-11-28T10:00:00.000Z'),
            workshop: { status: 'active' },
          },
        ],
      });
      expect(summary.no_valid_quotes).toBe(false);
    });

    it('CHAL-NVQ-03: returns false when status is draft_request even with 0 quotes', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'draft_request',
        delivery_mode: null,
        recipient_name: null,
        recipient_phone: null,
        delivery_address: null,
        delivery_region: null,
        bidding_deadline: null,
        delivery_deadline: null,
      });
      const entity = QuoteRequestMapper.toDomain(row);
      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: BASE_NOW,
        quotes: [],
      });
      expect(summary.no_valid_quotes).toBe(false);
    });

    it('CHAL-NVQ-04: returns false when status is sent_to_artisans even with 0 quotes', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'sent_to_artisans',
      });
      const entity = QuoteRequestMapper.toDomain(row);
      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: BASE_NOW,
        quotes: [],
      });
      expect(summary.no_valid_quotes).toBe(false);
    });

    it('CHAL-NVQ-05: returns false when status is buyer_accepted, in_production, or delivered even with 0 quotes', () => {
      const statuses = ['buyer_accepted', 'in_production', 'delivered'] as const;
      for (const status of statuses) {
        const row = buildQuoteRequestPrismaRow({ status });
        const entity = QuoteRequestMapper.toDomain(row);
        const summary = QuoteRequestMapper.toSummaryDto(entity, {
          category: null,
          now: BASE_NOW,
          quotes: [],
        });
        expect(summary.no_valid_quotes).toBe(false);
      }
    });

    it('CHAL-NVQ-06: returns false when request is cancelled even if status was artisans_bidding and quotes are 0', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'artisans_bidding',
        cancelled_at: new Date('2026-11-12T10:00:00.000Z'),
        cancelled_by: 1n,
      });
      const entity = QuoteRequestMapper.toDomain(row);
      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: BASE_NOW,
        quotes: [],
      });
      expect(summary.no_valid_quotes).toBe(false);
    });

    it('CHAL-NVQ-07: triggers true when all quotes fail eligibility rules (withdrawn, inactive workshop, expired deadline, late delivery)', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'artisans_bidding',
        delivery_deadline: DELIVERY_DEADLINE,
      });
      const entity = QuoteRequestMapper.toDomain(row);

      const quotes = [
        {
          status: 'withdrawn',
          bid_accept_deadline: new Date('2026-11-25T10:00:00.000Z'),
          committed_delivery_at: new Date('2026-11-28T10:00:00.000Z'),
          workshop: { status: 'active' },
        },
        {
          status: 'active',
          bid_accept_deadline: new Date('2026-11-25T10:00:00.000Z'),
          committed_delivery_at: new Date('2026-11-28T10:00:00.000Z'),
          workshop: { status: 'suspended' },
        },
        {
          status: 'active',
          bid_accept_deadline: new Date('2026-11-12T10:00:00.000Z'), // past relative to BASE_NOW (Nov 13)
          committed_delivery_at: new Date('2026-11-28T10:00:00.000Z'),
          workshop: { status: 'active' },
        },
        {
          status: 'active',
          bid_accept_deadline: new Date('2026-11-25T10:00:00.000Z'),
          committed_delivery_at: new Date('2026-12-05T10:00:00.000Z'), // past request delivery deadline (Dec 1)
          workshop: { status: 'active' },
        },
      ];

      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: BASE_NOW,
        quotes,
      });

      expect(summary.no_valid_quotes).toBe(true);
    });

    it('CHAL-NVQ-08: returns false when at least one quote satisfies all 4 eligibility conditions among ineligible ones', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'artisans_bidding',
        delivery_deadline: DELIVERY_DEADLINE,
      });
      const entity = QuoteRequestMapper.toDomain(row);

      const quotes = [
        {
          status: 'withdrawn',
          bid_accept_deadline: new Date('2026-11-25T10:00:00.000Z'),
          committed_delivery_at: new Date('2026-11-28T10:00:00.000Z'),
          workshop: { status: 'active' },
        },
        {
          status: 'active',
          bid_accept_deadline: new Date('2026-11-25T10:00:00.000Z'),
          committed_delivery_at: new Date('2026-11-28T10:00:00.000Z'),
          workshop: { status: 'active' }, // Fully eligible!
        },
      ];

      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: BASE_NOW,
        quotes,
      });

      expect(summary.no_valid_quotes).toBe(false);
    });
  });

  // =========================================================================
  // 3. DYNAMIC FIELD CALCULATION ACCURACY: nearest_accept_deadline
  // =========================================================================
  describe('3. Dynamic Field Calculation Accuracy: nearest_accept_deadline', () => {
    it('CHAL-NAD-01: returns the minimum accept deadline among multiple active eligible quotes', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'artisans_bidding',
        delivery_deadline: DELIVERY_DEADLINE,
      });
      const entity = QuoteRequestMapper.toDomain(row);

      const quotes = [
        {
          status: 'active',
          bid_accept_deadline: new Date('2026-11-25T10:00:00.000Z'),
          committed_delivery_at: new Date('2026-11-28T10:00:00.000Z'),
          workshop: { status: 'active' },
        },
        {
          status: 'active',
          bid_accept_deadline: new Date('2026-11-18T08:00:00.000Z'), // EARLIEST
          committed_delivery_at: new Date('2026-11-28T10:00:00.000Z'),
          workshop: { status: 'active' },
        },
        {
          status: 'active',
          bid_accept_deadline: new Date('2026-11-22T12:00:00.000Z'),
          committed_delivery_at: new Date('2026-11-28T10:00:00.000Z'),
          workshop: { status: 'active' },
        },
      ];

      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: BASE_NOW,
        quotes,
      });

      expect(summary.nearest_accept_deadline).toBe('2026-11-18T08:00:00.000Z');
    });

    it('CHAL-NAD-02: ignores ineligible quotes even if their deadline is earlier', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'artisans_bidding',
        delivery_deadline: DELIVERY_DEADLINE,
      });
      const entity = QuoteRequestMapper.toDomain(row);

      const quotes = [
        {
          status: 'active',
          bid_accept_deadline: new Date('2026-11-15T08:00:00.000Z'), // Earlier, but workshop is suspended!
          committed_delivery_at: new Date('2026-11-28T10:00:00.000Z'),
          workshop: { status: 'suspended' },
        },
        {
          status: 'active',
          bid_accept_deadline: new Date('2026-11-20T10:00:00.000Z'), // Earliest ELIGIBLE
          committed_delivery_at: new Date('2026-11-28T10:00:00.000Z'),
          workshop: { status: 'active' },
        },
      ];

      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: BASE_NOW,
        quotes,
      });

      expect(summary.nearest_accept_deadline).toBe('2026-11-20T10:00:00.000Z');
    });

    it('CHAL-NAD-03: returns null when quotes array is empty or null', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'artisans_bidding',
      });
      const entity = QuoteRequestMapper.toDomain(row);

      const summaryEmpty = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: BASE_NOW,
        quotes: [],
      });
      expect(summaryEmpty.nearest_accept_deadline).toBeNull();

      const summaryNull = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: BASE_NOW,
        quotes: null,
      });
      expect(summaryNull.nearest_accept_deadline).toBeNull();
    });

    it('CHAL-NAD-04: returns null when no quotes are eligible', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'artisans_bidding',
        delivery_deadline: DELIVERY_DEADLINE,
      });
      const entity = QuoteRequestMapper.toDomain(row);

      const quotes = [
        {
          status: 'withdrawn',
          bid_accept_deadline: new Date('2026-11-25T10:00:00.000Z'),
          committed_delivery_at: new Date('2026-11-28T10:00:00.000Z'),
          workshop: { status: 'active' },
        },
      ];

      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: BASE_NOW,
        quotes,
      });

      expect(summary.nearest_accept_deadline).toBeNull();
    });

    it('CHAL-NAD-05: returns null when request is cancelled even if eligible quotes exist', () => {
      const row = buildQuoteRequestPrismaRow({
        status: 'artisans_bidding',
        cancelled_at: new Date('2026-11-12T10:00:00.000Z'),
        cancelled_by: 1n,
      });
      const entity = QuoteRequestMapper.toDomain(row);

      const quotes = [
        {
          status: 'active',
          bid_accept_deadline: new Date('2026-11-25T10:00:00.000Z'),
          committed_delivery_at: new Date('2026-11-28T10:00:00.000Z'),
          workshop: { status: 'active' },
        },
      ];

      const summary = QuoteRequestMapper.toSummaryDto(entity, {
        category: null,
        now: BASE_NOW,
        quotes,
      });

      expect(summary.nearest_accept_deadline).toBeNull();
    });

    it('CHAL-NAD-06: returns null when request is buyer_accepted, in_production, or delivered even if quotes exist', () => {
      const statuses = ['buyer_accepted', 'in_production', 'delivered'] as const;
      for (const status of statuses) {
        const row = buildQuoteRequestPrismaRow({ status });
        const entity = QuoteRequestMapper.toDomain(row);

        const quotes = [
          {
            status: 'active',
            bid_accept_deadline: new Date('2026-11-25T10:00:00.000Z'),
            committed_delivery_at: new Date('2026-11-28T10:00:00.000Z'),
            workshop: { status: 'active' },
          },
        ];

        const summary = QuoteRequestMapper.toSummaryDto(entity, {
          category: null,
          now: BASE_NOW,
          quotes,
        });

        expect(summary.nearest_accept_deadline).toBeNull();
      }
    });
  });

  // =========================================================================
  // 4. MULTI-FILTER INTERACTION IN PERSISTENCE LAYER
  // =========================================================================
  describe('4. Multi-Filter Interaction in Persistence Layer', () => {
    it('CHAL-FLT-01: builds correct where clause when filtering by status alone', async () => {
      let capturedWhere: Record<string, unknown> | undefined;
      const mockClient = {
        quoteRequest: {
          count: vi.fn().mockImplementation(async ({ where }) => {
            capturedWhere = where;
            return 0;
          }),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      const { txRunner } = createMockTxRunner(mockClient);
      const repo = new PrismaQuoteRequestRepository(txRunner);

      // Status: bidding -> status in [sent_to_artisans, artisans_bidding], cancelled_at: null
      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests({ status: 'bidding', page: 1, limit: 10 }, tx);
      });

      expect(capturedWhere).toEqual({
        status: { in: ['sent_to_artisans', 'artisans_bidding'] },
        cancelled_at: null,
      });

      // Status: draft -> status: draft_request, cancelled_at: null
      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests({ status: 'draft', page: 1, limit: 10 }, tx);
      });
      expect(capturedWhere).toEqual({
        status: 'draft_request',
        cancelled_at: null,
      });

      // Status: accepted -> status: buyer_accepted, cancelled_at: null
      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests({ status: 'accepted', page: 1, limit: 10 }, tx);
      });
      expect(capturedWhere).toEqual({
        status: 'buyer_accepted',
        cancelled_at: null,
      });

      // Status: cancelled -> cancelled_at: { not: null }
      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests({ status: 'cancelled', page: 1, limit: 10 }, tx);
      });
      expect(capturedWhere).toEqual({
        cancelled_at: { not: null },
      });
    });

    it('CHAL-FLT-02: combines status with explicit cancelled flag', async () => {
      let capturedWhere: Record<string, unknown> | undefined;
      const mockClient = {
        quoteRequest: {
          count: vi.fn().mockImplementation(async ({ where }) => {
            capturedWhere = where;
            return 0;
          }),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      const { txRunner } = createMockTxRunner(mockClient);
      const repo = new PrismaQuoteRequestRepository(txRunner);

      // status: bidding + cancelled: true
      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests(
          { status: 'bidding', cancelled: true, page: 1, limit: 10 },
          tx,
        );
      });
      expect(capturedWhere).toEqual({
        status: { in: ['sent_to_artisans', 'artisans_bidding'] },
        cancelled_at: { not: null },
      });

      // status: bidding + cancelled: false
      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests(
          { status: 'bidding', cancelled: false, page: 1, limit: 10 },
          tx,
        );
      });
      expect(capturedWhere).toEqual({
        status: { in: ['sent_to_artisans', 'artisans_bidding'] },
        cancelled_at: null,
      });
    });

    it('CHAL-FLT-03: combines buyer_id and category_id filters', async () => {
      let capturedWhere: Record<string, unknown> | undefined;
      const mockClient = {
        quoteRequest: {
          count: vi.fn().mockImplementation(async ({ where }) => {
            capturedWhere = where;
            return 0;
          }),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      const { txRunner } = createMockTxRunner(mockClient);
      const repo = new PrismaQuoteRequestRepository(txRunner);

      // buyer_id only
      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests({ buyerId: '100', page: 1, limit: 10 }, tx);
      });
      expect(capturedWhere).toEqual({ buyer_id: 100n });

      // category_id only
      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests({ categoryId: '55', page: 1, limit: 10 }, tx);
      });
      expect(capturedWhere).toEqual({ category_id: 55n });

      // buyer_id + category_id
      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests(
          { buyerId: '100', categoryId: '55', page: 1, limit: 10 },
          tx,
        );
      });
      expect(capturedWhere).toEqual({
        AND: [{ buyer_id: 100n }, { category_id: 55n }],
      });
    });

    it('CHAL-FLT-04: multi-filter interaction: status + buyer_id + category_id + cancelled', async () => {
      let capturedWhere: Record<string, unknown> | undefined;
      const mockClient = {
        quoteRequest: {
          count: vi.fn().mockImplementation(async ({ where }) => {
            capturedWhere = where;
            return 0;
          }),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      const { txRunner } = createMockTxRunner(mockClient);
      const repo = new PrismaQuoteRequestRepository(txRunner);

      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests(
          {
            buyerId: '77',
            categoryId: '88',
            status: 'artisans_bidding',
            cancelled: false,
            page: 1,
            limit: 20,
          },
          tx,
        );
      });

      expect(capturedWhere).toEqual({
        AND: [
          { buyer_id: 77n },
          { category_id: 88n },
          {
            status: 'artisans_bidding',
            cancelled_at: null,
          },
        ],
      });
    });

    it('CHAL-FLT-05: no filters passed results in empty where object (matches all requests)', async () => {
      let capturedWhere: Record<string, unknown> | undefined;
      const mockClient = {
        quoteRequest: {
          count: vi.fn().mockImplementation(async ({ where }) => {
            capturedWhere = where;
            return 0;
          }),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      const { txRunner } = createMockTxRunner(mockClient);
      const repo = new PrismaQuoteRequestRepository(txRunner);

      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests({ page: 1, limit: 20 }, tx);
      });

      expect(capturedWhere).toEqual({});
    });
  });

  // =========================================================================
  // 5. DETERMINISTIC SORTING & SECONDARY TIE-BREAKER: id desc
  // =========================================================================
  describe('5. Deterministic Sorting & Secondary Tie-Breaker: id desc', () => {
    it('CHAL-SRT-01: default sort produces [{ created_at: "desc" }, { id: "desc" }]', async () => {
      let capturedOrderBy: unknown;
      const mockClient = {
        quoteRequest: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockImplementation(async ({ orderBy }) => {
            capturedOrderBy = orderBy;
            return [];
          }),
        },
      };
      const { txRunner } = createMockTxRunner(mockClient);
      const repo = new PrismaQuoteRequestRepository(txRunner);

      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests({ page: 1, limit: 10 }, tx);
      });

      expect(capturedOrderBy).toEqual([{ created_at: 'desc' }, { id: 'desc' }]);
    });

    it('CHAL-SRT-02: sort_by="created_at" and order="asc" produces [{ created_at: "asc" }, { id: "desc" }]', async () => {
      let capturedOrderBy: unknown;
      const mockClient = {
        quoteRequest: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockImplementation(async ({ orderBy }) => {
            capturedOrderBy = orderBy;
            return [];
          }),
        },
      };
      const { txRunner } = createMockTxRunner(mockClient);
      const repo = new PrismaQuoteRequestRepository(txRunner);

      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests(
          { sortBy: 'created_at', order: 'asc', page: 1, limit: 10 },
          tx,
        );
      });

      expect(capturedOrderBy).toEqual([{ created_at: 'asc' }, { id: 'desc' }]);
    });

    it('CHAL-SRT-03: sort_by="updated_at" produces [{ updated_at: order }, { id: "desc" }]', async () => {
      let capturedOrderBy: unknown;
      const mockClient = {
        quoteRequest: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockImplementation(async ({ orderBy }) => {
            capturedOrderBy = orderBy;
            return [];
          }),
        },
      };
      const { txRunner } = createMockTxRunner(mockClient);
      const repo = new PrismaQuoteRequestRepository(txRunner);

      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests(
          { sortBy: 'updated_at', order: 'desc', page: 1, limit: 10 },
          tx,
        );
      });

      expect(capturedOrderBy).toEqual([{ updated_at: 'desc' }, { id: 'desc' }]);
    });

    it('CHAL-SRT-04: sort_by="bidding_deadline" produces [{ bidding_deadline: order }, { id: "desc" }]', async () => {
      let capturedOrderBy: unknown;
      const mockClient = {
        quoteRequest: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockImplementation(async ({ orderBy }) => {
            capturedOrderBy = orderBy;
            return [];
          }),
        },
      };
      const { txRunner } = createMockTxRunner(mockClient);
      const repo = new PrismaQuoteRequestRepository(txRunner);

      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests(
          { sortBy: 'bidding_deadline', order: 'asc', page: 1, limit: 10 },
          tx,
        );
      });

      expect(capturedOrderBy).toEqual([{ bidding_deadline: 'asc' }, { id: 'desc' }]);
    });

    it('CHAL-SRT-05: sort_by="delivery_deadline" produces [{ delivery_deadline: order }, { id: "desc" }]', async () => {
      let capturedOrderBy: unknown;
      const mockClient = {
        quoteRequest: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockImplementation(async ({ orderBy }) => {
            capturedOrderBy = orderBy;
            return [];
          }),
        },
      };
      const { txRunner } = createMockTxRunner(mockClient);
      const repo = new PrismaQuoteRequestRepository(txRunner);

      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests(
          { sortBy: 'delivery_deadline', order: 'desc', page: 1, limit: 10 },
          tx,
        );
      });

      expect(capturedOrderBy).toEqual([{ delivery_deadline: 'desc' }, { id: 'desc' }]);
    });

    it('CHAL-SRT-06: sort_by="quantity" produces [{ quantity: order }, { id: "desc" }]', async () => {
      let capturedOrderBy: unknown;
      const mockClient = {
        quoteRequest: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockImplementation(async ({ orderBy }) => {
            capturedOrderBy = orderBy;
            return [];
          }),
        },
      };
      const { txRunner } = createMockTxRunner(mockClient);
      const repo = new PrismaQuoteRequestRepository(txRunner);

      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests(
          { sortBy: 'quantity', order: 'asc', page: 1, limit: 10 },
          tx,
        );
      });

      expect(capturedOrderBy).toEqual([{ quantity: 'asc' }, { id: 'desc' }]);
    });

    it('CHAL-SRT-07: sort_by="id" does not duplicate tie-breaker, produces single [{ id: order }]', async () => {
      let capturedOrderByAsc: unknown;
      let capturedOrderByDesc: unknown;
      const mockClient = {
        quoteRequest: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi
            .fn()
            .mockImplementationOnce(async ({ orderBy }) => {
              capturedOrderByAsc = orderBy;
              return [];
            })
            .mockImplementationOnce(async ({ orderBy }) => {
              capturedOrderByDesc = orderBy;
              return [];
            }),
        },
      };
      const { txRunner } = createMockTxRunner(mockClient);
      const repo = new PrismaQuoteRequestRepository(txRunner);

      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests(
          { sortBy: 'id', order: 'asc', page: 1, limit: 10 },
          tx,
        );
      });
      expect(capturedOrderByAsc).toEqual([{ id: 'asc' }]);

      await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests(
          { sortBy: 'id', order: 'desc', page: 1, limit: 10 },
          tx,
        );
      });
      expect(capturedOrderByDesc).toEqual([{ id: 'desc' }]);
    });

    it('CHAL-SRT-08: verifies deterministic sorting stability when primary timestamp is identical', async () => {
      // Simulate rows from database where created_at is identical:
      // Prisma orderBy [{ created_at: 'desc' }, { id: 'desc' }] returns rows sorted by id desc
      const sameTime = new Date('2026-11-13T10:00:00.000Z');
      const rows = [
        buildQuoteRequestPrismaRow({ id: 500n, created_at: sameTime }),
        buildQuoteRequestPrismaRow({ id: 400n, created_at: sameTime }),
        buildQuoteRequestPrismaRow({ id: 300n, created_at: sameTime }),
        buildQuoteRequestPrismaRow({ id: 200n, created_at: sameTime }),
        buildQuoteRequestPrismaRow({ id: 100n, created_at: sameTime }),
      ];

      const mockClient = {
        quoteRequest: {
          count: vi.fn().mockResolvedValue(5),
          findMany: vi.fn().mockResolvedValue(rows),
        },
      };
      const { txRunner } = createMockTxRunner(mockClient);
      const repo = new PrismaQuoteRequestRepository(txRunner);

      const result = await txRunner.run(async (tx) => {
        return repo.findAdminQuoteRequests(
          { sortBy: 'created_at', order: 'desc', page: 1, limit: 10 },
          tx,
        );
      });

      expect(result.items.length).toBe(5);
      const ids = result.items.map((i) => BigInt(i.id));
      expect(ids).toEqual([500n, 400n, 300n, 200n, 100n]);
    });
  });

  // =========================================================================
  // 6. END-TO-END USE CASE & BOUNDARY STRESS
  // =========================================================================
  describe('6. End-to-End Use Case & Boundary Stress', () => {
    it('CHAL-E2E-01: rejects non-admin actors with TradingPermissionDeniedError', async () => {
      const mockRepo = {
        findAdminQuoteRequests: vi.fn(),
      };
      const { txRunner } = createMockTxRunner({});
      const useCase = new ListAdminQuoteRequestsUseCase(txRunner, mockRepo as any);

      await expect(
        useCase.execute({
          actor: buyerActor,
          query: { page: 1, limit: 20 },
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);
      expect(mockRepo.findAdminQuoteRequests).not.toHaveBeenCalled();
    });

    it('CHAL-E2E-02: rejects admin with temp_password session with TEMP_PASSWORD_RESTRICTED', async () => {
      const mockRepo = {
        findAdminQuoteRequests: vi.fn(),
      };
      const { txRunner } = createMockTxRunner({});
      const useCase = new ListAdminQuoteRequestsUseCase(txRunner, mockRepo as any);

      await expect(
        useCase.execute({
          actor: tempAdminActor,
          query: { page: 1, limit: 20 },
        }),
      ).rejects.toThrow(TradingDomainError);
      expect(mockRepo.findAdminQuoteRequests).not.toHaveBeenCalled();
    });

    it('CHAL-E2E-03: rejects boundary violations on page (0, negative) and limit (0, 101, negative)', async () => {
      const mockRepo = {
        findAdminQuoteRequests: vi.fn(),
      };
      const { txRunner } = createMockTxRunner({});
      const useCase = new ListAdminQuoteRequestsUseCase(txRunner, mockRepo as any);

      // page < 1
      await expect(
        useCase.execute({
          actor: adminActor,
          query: { page: 0, limit: 20 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { page: -5, limit: 20 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      // limit < 1
      await expect(
        useCase.execute({
          actor: adminActor,
          query: { page: 1, limit: 0 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      // limit > 100
      await expect(
        useCase.execute({
          actor: adminActor,
          query: { page: 1, limit: 101 },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('CHAL-E2E-04: rejects invalid status, sort field, or order', async () => {
      const mockRepo = {
        findAdminQuoteRequests: vi.fn(),
      };
      const { txRunner } = createMockTxRunner({});
      const useCase = new ListAdminQuoteRequestsUseCase(txRunner, mockRepo as any);

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { status: 'malicious_status' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { sort_by: 'password_hash' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { order: 'sideways' as any },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('CHAL-E2E-05: rejects non-positive integer buyer_id and category_id in Use Case', async () => {
      const mockRepo = {
        findAdminQuoteRequests: vi.fn(),
      };
      const { txRunner } = createMockTxRunner({});
      const useCase = new ListAdminQuoteRequestsUseCase(txRunner, mockRepo as any);

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { buyer_id: '0' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { buyer_id: '-12' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { buyer_id: 'abc' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);

      await expect(
        useCase.execute({
          actor: adminActor,
          query: { category_id: '12.34' },
        }),
      ).rejects.toThrow(InvalidTradingInputError);
    });

    it('CHAL-E2E-06: extreme pagination (page=999999) safely returns empty data and correct total', async () => {
      const mockRepo = {
        findAdminQuoteRequests: vi.fn().mockResolvedValue({
          items: [],
          total: 5,
        }),
      };
      const { txRunner } = createMockTxRunner({});
      const useCase = new ListAdminQuoteRequestsUseCase(txRunner, mockRepo as any);

      const result = await useCase.execute({
        actor: adminActor,
        query: { page: 999999, limit: 20 },
      });

      expect(result.data).toEqual([]);
      expect(result.pagination.page).toBe(999999);
      expect(result.pagination.limit).toBe(20);
      expect(result.pagination.total_records).toBe(5);
      expect(result.pagination.total_pages).toBe(1);
    });
  });
});
