import { vi } from 'vitest';
import type { AuthenticatedActor } from '../../src/common/application/types/contract-types';
import type {
  AllocationDto,
  BuyerRequestSummaryDto,
  InvitedRequestBaseDto,
} from '../../src/modules/trading/application/dtos/trading-persistence.dtos';
import type {
  AllocationDetailRecord,
  IAllocationBatchRepository,
  IAllocationLogRepository,
  IAllocationRepository,
  IContactEditHistoryRepository,
  IIdempotencyRecordRepository,
  IQuoteRepository,
  IQuoteRequestRepository,
  IRecipientResponseHistoryRepository,
  IRequestRecipientRepository,
  IStatusLogRepository,
  QuoteRequestDetailRecord,
} from '../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import {
  Allocation,
  Quote,
  QuoteRequest,
  RequestRecipient,
} from '../../src/modules/trading/domain';
import { MockCatalogContract } from './mocks/catalog.mock';
import { MockTraceabilityContract } from './mocks/traceability.mock';
import { MockTransactionRunner } from './mocks/transaction-runner.mock';
import { MockWorkshopContract } from './mocks/workshop.mock';

export const NOW = new Date('2026-11-15T10:00:00.000Z');
export const SENT_AT = new Date('2026-11-10T08:00:00.000Z');
export const BIDDING_DEADLINE = new Date('2026-11-20T10:00:00.000Z');
export const BID_ACCEPT_DEADLINE = new Date('2026-11-25T10:00:00.000Z');
export const COMMITTED_DELIVERY = new Date('2026-11-28T10:00:00.000Z');
export const DELIVERY_DEADLINE = new Date('2026-11-30T10:00:00.000Z');
export const VALID_UUID = '11111111-2222-4333-8444-555555555555';

const actor = (
  accountId: string,
  role: AuthenticatedActor['role'],
  workshopId: string | null = null,
  sessionLevel: AuthenticatedActor['sessionLevel'] = 'normal',
): AuthenticatedActor =>
  Object.freeze({
    accountId,
    role,
    workshopId,
    authVersion: 1,
    sessionId: `sess-${role}-${accountId}`,
    sessionLevel,
  });

export const BUYER = actor('10', 'buyer');
export const OTHER_BUYER = actor('99', 'buyer');
export const ARTISAN = actor('20', 'artisan', '301');
export const OTHER_ARTISAN = actor('21', 'artisan', '302');
export const ADMIN = actor('1', 'admin');
export const TEMP_BUYER = actor('10', 'buyer', null, 'temp_password');

export const makeRequest = (
  overrides: Partial<Parameters<typeof QuoteRequest.reconstitute>[0]> = {},
): QuoteRequest =>
  QuoteRequest.reconstitute({
    id: '1001',
    buyer_id: '10',
    category_id: '5',
    spec: '5000 bát gốm men rạn Bát Tràng',
    quantity: 5000,
    unit: 'piece',
    unit_set_description: null,
    status: 'artisans_bidding',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội',
    delivery_address: 'Thôn 1 Làng Cổ Bát Tràng, Gia Lâm',
    recipient_name: 'Nguyễn Văn Mua',
    recipient_phone: '0901234567',
    bidding_deadline: BIDDING_DEADLINE,
    delivery_deadline: DELIVERY_DEADLINE,
    bidding_closed_at: null,
    version: 3,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: SENT_AT,
    updated_at: SENT_AT,
    ...overrides,
  });

export const makeRecipient = (
  overrides: Partial<Parameters<typeof RequestRecipient.reconstitute>[0]> = {},
): RequestRecipient =>
  RequestRecipient.reconstitute({
    id: '2001',
    request_id: '1001',
    workshop_id: '301',
    response_status: 'quoted',
    decline_reason: null,
    responded_by: '20',
    responded_at: SENT_AT,
    sent_at: SENT_AT,
    version: 2,
    ...overrides,
  });

export const makeQuote = (
  overrides: Partial<Parameters<typeof Quote.reconstitute>[0]> = {},
): Quote =>
  Quote.reconstitute({
    id: '401',
    request_id: '1001',
    workshop_id: '301',
    unit_price: 45000,
    max_quantity: 5000,
    bid_accept_deadline: BID_ACCEPT_DEADLINE,
    committed_delivery_at: COMMITTED_DELIVERY,
    status: 'active',
    version: 1,
    withdraw_reason: null,
    withdrawn_by: null,
    withdrawn_at: null,
    created_at: SENT_AT,
    updated_at: SENT_AT,
    ...overrides,
  });

export const makeAllocation = (
  overrides: Partial<Parameters<typeof Allocation.reconstitute>[0]> = {},
): Allocation =>
  Allocation.reconstitute({
    id: '5001',
    request_id: '1001',
    workshop_id: '301',
    quote_id: '401',
    quantity: 5000,
    unit_price: 45000,
    committed_delivery_at: COMMITTED_DELIVERY,
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
    created_at: NOW,
    updated_at: NOW,
    batch_links: [],
    ...overrides,
  });

export const makeAllocationDto = (overrides: Partial<AllocationDto> = {}): AllocationDto => ({
  id: '5001',
  request_id: '1001',
  workshop: { id: '301', name: 'Xưởng Gốm Minh Long' },
  quote_id: '401',
  quantity: 5000,
  unit_price: 45000,
  committed_delivery_at: COMMITTED_DELIVERY.toISOString(),
  status: 'not_started',
  version: 1,
  started_at: null,
  started_by: null,
  handed_over_at: null,
  handed_over_by: null,
  delivery_note: null,
  admin_handed_over: false,
  admin_handover_reason: null,
  admin_delivery_evidence: null,
  admin_handover_actual_at: null,
  traceability_warning: 'NO_BATCH_LINK',
  ...overrides,
});

export const makeAllocationDetailRecord = (
  overrides: Partial<AllocationDetailRecord> = {},
): AllocationDetailRecord => ({
  allocation: makeAllocationDto(),
  requestBuyerId: '10',
  recipientName: 'Nguyễn Văn Mua',
  recipientPhone: '0901234567',
  deliveryAddress: 'Thôn 1 Làng Cổ Bát Tràng, Gia Lâm',
  ...overrides,
});

export const makeRequestDetail = (
  overrides: Partial<QuoteRequestDetailRecord> = {},
): QuoteRequestDetailRecord => ({
  entity: makeRequest(),
  category: { id: '5', name: 'Bát đĩa gốm' },
  recipients: [
    {
      entity: makeRecipient(),
      workshop: { id: '301', name: 'Xưởng Gốm Minh Long', status: 'active' },
      quote: { id: '401', status: 'active', bid_accept_deadline: BID_ACCEPT_DEADLINE },
    },
  ],
  quotes: [
    {
      entity: makeQuote(),
      workshop: { id: '301', name: 'Xưởng Gốm Minh Long', status: 'active' },
    },
  ],
  allocations: [],
  statusLogs: [],
  ...overrides,
});

export const makeSummaryDto = (overrides: Partial<BuyerRequestSummaryDto> = {}): BuyerRequestSummaryDto => ({
  id: '1001',
  status: 'artisans_bidding',
  version: 3,
  category: { id: '5', name: 'Bát đĩa gốm' },
  quantity: 5000,
  unit: 'piece',
  bidding_deadline: BIDDING_DEADLINE.toISOString(),
  delivery_deadline: DELIVERY_DEADLINE.toISOString(),
  is_bidding_open: true,
  cancelled_at: null,
  split_requested_at: null,
  coordination_state: null,
  no_valid_quotes: false,
  nearest_accept_deadline: BID_ACCEPT_DEADLINE.toISOString(),
  created_at: SENT_AT.toISOString(),
  ...overrides,
});

export const makeInvitedDto = (overrides: Partial<InvitedRequestBaseDto> = {}): InvitedRequestBaseDto => ({
  id: '1001',
  status: 'artisans_bidding',
  version: 3,
  category: { id: '5', name: 'Bát đĩa gốm' },
  spec: '5000 bát gốm men rạn',
  quantity: 5000,
  unit: 'piece',
  unit_set_description: null,
  delivery_mode: 'at_buyer_address',
  delivery_region: 'Hà Nội',
  bidding_deadline: BIDDING_DEADLINE.toISOString(),
  delivery_deadline: DELIVERY_DEADLINE.toISOString(),
  bidding_closed_at: null,
  is_bidding_open: true,
  cancelled_at: null,
  created_at: SENT_AT.toISOString(),
  updated_at: SENT_AT.toISOString(),
  own_recipient: {
    id: '2001',
    request_id: '1001',
    workshop: { id: '301', name: 'Xưởng Gốm Minh Long' },
    response_status: 'pending',
    version: 1,
    sent_at: SENT_AT.toISOString(),
    responded_at: null,
    decline_reason: null,
    eligibility_labels: [],
  },
  own_quote: null,
  ...overrides,
});

/** Creates typed Vitest mock stubs for all 10 Trading repositories & cross-module contracts. */
export function createTradingTestDeps() {
  const txRunner = new MockTransactionRunner();
  const workshopContract = new MockWorkshopContract().givenActiveWorkshops('301', '302');
  workshopContract.getWorkshopSummary.mockResolvedValue({
    id: '301',
    name: 'Xưởng Gốm Minh Long',
    status: 'active',
    isProfilePublic: true,
  });
  const catalogContract = new MockCatalogContract().givenEligibleWorkshops('5', '301', '302');
  const traceabilityContract = new MockTraceabilityContract();
  traceabilityContract.assertOwnedBatches.mockResolvedValue([
    { id: '901', name: 'Lô 901', status: 'published', traceUrl: '/api/v1/trace/901' },
  ]);

  const quoteRequestRepo: { [K in keyof IQuoteRequestRepository]-?: ReturnType<typeof vi.fn> } = {
    createDraft: vi.fn(async ({ request }) => request),
    update: vi.fn(async ({ request }) => request),
    deleteDraft: vi.fn(async () => undefined),
    findById: vi.fn(async () => null),
    findDraftDetailById: vi.fn(async () => null),
    findDetailById: vi.fn(async () => null),
    lockById: vi.fn(async () => null),
    lockByIds: vi.fn(async () => []),
    findBuyerQuoteRequests: vi.fn(async () => ({ items: [], total: 0 })),
    findArtisanQuoteRequests: vi.fn(async () => ({ items: [], total: 0 })),
    findAdminQuoteRequests: vi.fn(async () => ({ items: [], total: 0 })),
  };

  const contactEditHistoryRepo: { [K in keyof IContactEditHistoryRepository]: ReturnType<typeof vi.fn> } = {
    create: vi.fn(),
    listByRequestId: vi.fn(async () => []),
    listEventsByRequestId: vi.fn(async () => []),
    findEventsWithPagination: vi.fn(async () => ({ rows: [], totalRecords: 0 })),
  };

  const recipientRepo: { [K in keyof IRequestRecipientRepository]: ReturnType<typeof vi.fn> } = {
    createMany: vi.fn(async (items: Array<{ request_id: string; workshop_id: string; sent_at: Date }>) =>
      items.map((x, idx) =>
        makeRecipient({ id: String(2001 + idx), request_id: x.request_id, workshop_id: x.workshop_id, response_status: 'pending', version: 1, sent_at: x.sent_at }),
      ),
    ),
    update: vi.fn(async ({ recipient }) => recipient),
    findById: vi.fn(async () => null),
    findByRequestAndWorkshop: vi.fn(async () => null),
    listByRequestId: vi.fn(async () => []),
    lockById: vi.fn(async () => null),
    lockByRequestAndWorkshop: vi.fn(async () => null),
    lockByIds: vi.fn(async () => []),
    findRecipientsWithDetails: vi.fn(async () => ({ rows: [], totalRecords: 0 })),
  };

  const recipientHistoryRepo: { [K in keyof IRecipientResponseHistoryRepository]: ReturnType<typeof vi.fn> } = {
    create: vi.fn(),
    listByRecipientId: vi.fn(async () => []),
    listEventsByRecipientId: vi.fn(async () => []),
    findEventsWithPagination: vi.fn(async () => ({ rows: [], totalRecords: 0 })),
    findSnapshotByQuoteVersion: vi.fn(async () => null),
  };

  const quoteRepo: { [K in keyof IQuoteRepository]: ReturnType<typeof vi.fn> } = {
    create: vi.fn(async ({ quote }) => quote),
    update: vi.fn(async ({ quote }) => quote),
    findById: vi.fn(async () => null),
    findByRequestAndWorkshop: vi.fn(async () => null),
    listByRequestId: vi.fn(async () => []),
    findQuotesWithDetails: vi.fn(async () => ({ rows: [], totalRecords: 0 })),
    lockById: vi.fn(async () => null),
    lockByRequestAndWorkshop: vi.fn(async () => null),
    lockByIds: vi.fn(async () => []),
  };

  const allocationRepo: { [K in keyof IAllocationRepository]: ReturnType<typeof vi.fn> } = {
    create: vi.fn(async ({ allocation }) => allocation),
    createMany: vi.fn(async (entries: Array<{ allocation: Allocation }>) => entries.map((e) => e.allocation)),
    update: vi.fn(async ({ allocation }) => allocation),
    findById: vi.fn(async () => null),
    findByRequestAndWorkshop: vi.fn(async () => null),
    listByRequestId: vi.fn(async () => []),
    listByWorkshopId: vi.fn(async () => []),
    findAllocationsWithDetails: vi.fn(async () => ({ rows: [], totalRecords: 0 })),
    findArtisanAllocations: vi.fn(async () => ({ rows: [], totalRecords: 0 })),
    findDetailById: vi.fn(async () => null),
    lockById: vi.fn(async () => null),
    lockByRequestId: vi.fn(async () => []),
    lockByIds: vi.fn(async () => []),
  };

  const allocationBatchRepo: { [K in keyof IAllocationBatchRepository]: ReturnType<typeof vi.fn> } = {
    replaceForAllocation: vi.fn(async ({ links }) => links),
    listByAllocationId: vi.fn(async () => []),
    findBatchesWithPagination: vi.fn(async () => ({ rows: [], totalRecords: 0 })),
  };

  const allocationLogRepo: { [K in keyof IAllocationLogRepository]: ReturnType<typeof vi.fn> } = {
    create: vi.fn(),
    createMany: vi.fn(async () => []),
    listByAllocationId: vi.fn(async () => []),
    listEventsByAllocationId: vi.fn(async () => []),
    findEventsWithPagination: vi.fn(async () => ({ rows: [], totalRecords: 0 })),
  };

  const statusLogRepo: { [K in keyof IStatusLogRepository]: ReturnType<typeof vi.fn> } = {
    create: vi.fn(),
    createMany: vi.fn(async () => []),
    listByRequestId: vi.fn(async () => []),
    listEventsByRequestId: vi.fn(async () => []),
    findEventsWithPagination: vi.fn(async () => ({ rows: [], totalRecords: 0, items: [], total: 0 })),
  };

  const idempotencyRepo: { [K in keyof IIdempotencyRecordRepository]: ReturnType<typeof vi.fn> } = {
    findByScope: vi.fn(async () => null),
    findAndVerifyReplay: vi.fn(async () => null),
    save: vi.fn(async (input) => ({ id: '9001', ...input })),
    deleteExpiredBefore: vi.fn(async () => 0),
  };

  return {
    txRunner,
    workshopContract,
    catalogContract,
    traceabilityContract,
    quoteRequestRepo: quoteRequestRepo as unknown as IQuoteRequestRepository & typeof quoteRequestRepo,
    contactEditHistoryRepo: contactEditHistoryRepo as unknown as IContactEditHistoryRepository & typeof contactEditHistoryRepo,
    recipientRepo: recipientRepo as unknown as IRequestRecipientRepository & typeof recipientRepo,
    recipientHistoryRepo: recipientHistoryRepo as unknown as IRecipientResponseHistoryRepository & typeof recipientHistoryRepo,
    quoteRepo: quoteRepo as unknown as IQuoteRepository & typeof quoteRepo,
    allocationRepo: allocationRepo as unknown as IAllocationRepository & typeof allocationRepo,
    allocationBatchRepo: allocationBatchRepo as unknown as IAllocationBatchRepository & typeof allocationBatchRepo,
    allocationLogRepo: allocationLogRepo as unknown as IAllocationLogRepository & typeof allocationLogRepo,
    statusLogRepo: statusLogRepo as unknown as IStatusLogRepository & typeof statusLogRepo,
    idempotencyRepo: idempotencyRepo as unknown as IIdempotencyRecordRepository & typeof idempotencyRepo,
  };
}
