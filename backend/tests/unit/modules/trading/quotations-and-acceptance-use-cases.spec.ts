import { describe, expect, it } from 'vitest';
import {
  AcceptQuoteUseCase,
  DeclineQuoteRequestUseCase,
  GetRecipientResponseHistoryUseCase,
  ListQuoteRequestQuotesUseCase,
  SubmitQuoteUseCase,
  WithdrawQuoteUseCase,
} from '../../../../src/modules/trading/application/use-cases';
import {
  BiddingClosedError,
  DeadlineViolationError,
  InvalidStateTransitionError,
  QuoteRequestNotFoundError,
  TradingResourceNotFoundError,
} from '../../../../src/modules/trading/domain';
import { MockTradingContract } from '../../../support/mocks/trading.mock';
import {
  ADMIN,
  ARTISAN,
  BID_ACCEPT_DEADLINE,
  BUYER,
  COMMITTED_DELIVERY,
  NOW,
  OTHER_ARTISAN,
  VALID_UUID,
  createTradingTestDeps,
  makeAllocationDto,
  makeQuote,
  makeRecipient,
  makeRequest,
} from '../../../support/trading-unit-harness';

describe('Trading Quotation & Direct Acceptance Use Cases — All 6 Endpoints (UC-16, UC-18, UC-19, BR-14..16, BR-20)', () => {
  it('DeclineQuoteRequest records artisan decline when open and blocks after quote or close (BR-15)', async () => {
    const deps = createTradingTestDeps();
    const req = makeRequest({ status: 'sent_to_artisans', version: 2 });
    const pendingRec = makeRecipient({ response_status: 'pending', version: 1 });
    deps.quoteRequestRepo.lockById.mockResolvedValue(req);
    deps.recipientRepo.lockByRequestAndWorkshop.mockResolvedValue(pendingRec);

    const uc = new DeclineQuoteRequestUseCase(deps.txRunner, deps.quoteRequestRepo, deps.recipientRepo, deps.quoteRepo, deps.workshopContract);
    const out = await uc.execute({
      actor: ARTISAN,
      requestId: '1001',
      expectedRecipientVersion: 1,
      declineReason: 'Xưởng kín lịch tháng này',
      now: NOW,
    });
    expect(out.recipient.response_status).toBe('declined');
    expect(out.recipient.version).toBe(2);

    // Already closed request cannot be declined
    deps.quoteRequestRepo.lockById.mockResolvedValueOnce(makeRequest({ status: 'sent_to_artisans', bidding_closed_at: NOW }));
    await expect(
      uc.execute({ actor: ARTISAN, requestId: '1001', expectedRecipientVersion: 1, now: NOW }),
    ).rejects.toThrow(BiddingClosedError);
  });

  it('SubmitQuote creates first quote (moving request to artisans_bidding), edits existing quote, and rejects invalid deadlines (BR-14)', async () => {
    const deps = createTradingTestDeps();
    const sentReq = makeRequest({ status: 'sent_to_artisans', version: 2 });
    const pendingRec = makeRecipient({ response_status: 'pending', version: 1 });
    deps.quoteRequestRepo.lockById.mockResolvedValue(sentReq);
    deps.recipientRepo.lockByRequestAndWorkshop.mockResolvedValue(pendingRec);
    deps.quoteRepo.lockByRequestAndWorkshop.mockResolvedValue(null);

    const uc = new SubmitQuoteUseCase(deps.txRunner, deps.quoteRequestRepo, deps.recipientRepo, deps.quoteRepo, deps.workshopContract);
    const created = await uc.execute({
      actor: ARTISAN,
      requestId: '1001',
      expectedRecipientVersion: 1,
      expectedQuoteVersion: null,
      unitPrice: 45000,
      maxQuantity: 5000,
      bidAcceptDeadline: BID_ACCEPT_DEADLINE,
      committedDeliveryAt: COMMITTED_DELIVERY,
      now: NOW,
    });
    expect(created.created).toBe(true);
    expect(created.result.quote.version).toBe(1);
    expect(deps.quoteRequestRepo.update).toHaveBeenCalledTimes(1); // sent_to_artisans -> artisans_bidding

    // Edit existing quote increments version 1 -> 2
    deps.quoteRequestRepo.lockById.mockResolvedValue(makeRequest({ status: 'artisans_bidding', version: 3 }));
    deps.recipientRepo.lockByRequestAndWorkshop.mockResolvedValue(makeRecipient({ response_status: 'quoted', version: 2 }));
    deps.quoteRepo.lockByRequestAndWorkshop.mockResolvedValue(makeQuote({ version: 1 }));
    const edited = await uc.execute({
      actor: ARTISAN,
      requestId: '1001',
      expectedRecipientVersion: 2,
      expectedQuoteVersion: 1,
      unitPrice: 43000,
      maxQuantity: 5000,
      bidAcceptDeadline: BID_ACCEPT_DEADLINE,
      committedDeliveryAt: COMMITTED_DELIVERY,
      now: NOW,
    });
    expect(edited.created).toBe(false);
    expect(edited.result.quote.version).toBe(2);

    // Accept deadline >= committed delivery violates BR-14
    await expect(
      uc.execute({
        actor: ARTISAN,
        requestId: '1001',
        expectedRecipientVersion: 2,
        expectedQuoteVersion: 1,
        unitPrice: 43000,
        maxQuantity: 5000,
        bidAcceptDeadline: COMMITTED_DELIVERY,
        committedDeliveryAt: COMMITTED_DELIVERY,
        now: NOW,
      }),
    ).rejects.toThrow(DeadlineViolationError);
  });

  it('WithdrawQuote succeeds even when bidding is closed and rejects withdrawal after acceptance (BR-15)', async () => {
    const deps = createTradingTestDeps();
    deps.quoteRequestRepo.lockById.mockResolvedValue(makeRequest({ status: 'artisans_bidding', bidding_closed_at: NOW, version: 3 }));
    deps.recipientRepo.lockByRequestAndWorkshop.mockResolvedValue(makeRecipient({ response_status: 'quoted', version: 2 }));
    deps.quoteRepo.lockByRequestAndWorkshop.mockResolvedValue(makeQuote({ version: 1 }));

    const uc = new WithdrawQuoteUseCase(deps.txRunner, deps.quoteRequestRepo, deps.recipientRepo, deps.quoteRepo, deps.workshopContract);
    const out = await uc.execute({
      actor: ARTISAN,
      requestId: '1001',
      expectedRecipientVersion: 2,
      expectedQuoteVersion: 1,
      withdrawReason: 'Hỏng lò nung đột xuất',
      now: NOW,
    });
    expect(out.result.quote.status).toBe('withdrawn');
    expect(out.result.quote.version).toBe(2);

    // Post-acceptance withdrawal rejected
    deps.quoteRequestRepo.lockById.mockResolvedValueOnce(makeRequest({ status: 'buyer_accepted', version: 4 }));
    await expect(
      uc.execute({ actor: ARTISAN, requestId: '1001', expectedRecipientVersion: 2, expectedQuoteVersion: 1, withdrawReason: 'Muộn', now: NOW }),
    ).rejects.toThrow(InvalidStateTransitionError);
  });

  it('ListQuoteRequestQuotes & GetRecipientResponseHistory isolate Artisan to own workshop while Buyer/Admin see all (BR-04, SEC-06)', async () => {
    const deps = createTradingTestDeps();
    deps.quoteRequestRepo.findById.mockResolvedValue(makeRequest());
    deps.recipientRepo.findByRequestAndWorkshop.mockImplementation(async (_reqId: string, wsId: string) =>
      wsId === '301' ? makeRecipient({ workshop_id: '301' }) : null,
    );
    deps.recipientRepo.findById.mockResolvedValue(makeRecipient({ id: '2001', workshop_id: '301' }));
    deps.quoteRepo.findQuotesWithDetails.mockResolvedValue({
      rows: [{ entity: makeQuote(), workshop: { id: '301', name: 'Xưởng Gốm Minh Long', status: 'active' } }],
      totalRecords: 1,
    });
    deps.recipientHistoryRepo.findEventsWithPagination.mockResolvedValue({
      rows: [{ id: '1', event_type: 'quote_submitted', quote_id: '401', quote_version: 1, quote_snapshot: null, reason: null, performed_by: { id: '20', display_name: 'Artisan' }, created_at: NOW.toISOString() }],
      totalRecords: 1,
    });

    const listQuotes = new ListQuoteRequestQuotesUseCase(deps.txRunner, deps.quoteRequestRepo, deps.recipientRepo, deps.quoteRepo);
    expect((await listQuotes.execute({ actor: BUYER, requestId: '1001' })).data).toHaveLength(1);
    expect((await listQuotes.execute({ actor: ARTISAN, requestId: '1001' })).data).toHaveLength(1);
    expect(deps.quoteRepo.findQuotesWithDetails).toHaveBeenLastCalledWith(expect.objectContaining({ workshopId: '301' }), expect.anything());
    await expect(listQuotes.execute({ actor: OTHER_ARTISAN, requestId: '1001' })).rejects.toThrow(QuoteRequestNotFoundError);

    const recHistory = new GetRecipientResponseHistoryUseCase(deps.txRunner, deps.quoteRequestRepo, deps.recipientRepo, deps.recipientHistoryRepo);
    expect((await recHistory.execute({ actor: ADMIN, requestId: '1001', recipientId: '2001' })).data).toHaveLength(1);
    await expect(recHistory.execute({ actor: OTHER_ARTISAN, requestId: '1001', recipientId: '2001' })).rejects.toThrow(TradingResourceNotFoundError);
  });

  it('AcceptQuoteUseCase delegates atomic direct acceptance through AcceptQuotationWorkflow (BR-16, BR-20)', async () => {
    const deps = createTradingTestDeps();
    const trading = new MockTradingContract();
    trading.findAcceptanceReplay.mockResolvedValue(null);
    trading.prepareAcceptance.mockResolvedValue({ workshopIds: ['301'] });
    trading.accept.mockResolvedValue({
      data: { request_id: '1001', request_status: 'buyer_accepted', request_version: 4, allocations: [makeAllocationDto()] },
      operation: {
        id: '9001',
        replayed: false,
        committed_at: NOW.toISOString(),
        current_state: { request: { id: '1001', status: 'buyer_accepted', version: 4, cancelled_at: null } },
      },
    });

    const out = await new AcceptQuoteUseCase(deps.txRunner, trading, deps.workshopContract).execute({
      actor: BUYER,
      requestId: '1001',
      quoteId: '401',
      expectedRequestVersion: 3,
      expectedQuoteVersion: 1,
      idempotencyKey: VALID_UUID,
      now: NOW,
    });
    expect(out.data.request_status).toBe('buyer_accepted');
    expect(out.data.allocations).toHaveLength(1);
    expect(deps.workshopContract.lockAndAssertActive).toHaveBeenCalledWith(['301'], expect.anything());
  });
});
