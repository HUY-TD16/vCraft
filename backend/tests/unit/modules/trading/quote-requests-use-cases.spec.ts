import { describe, expect, it } from 'vitest';
import {
  CloseBiddingUseCase,
  CopyQuoteRequestUseCase,
  CreateDraftQuoteRequestUseCase,
  DeleteDraftQuoteRequestUseCase,
  GetContactHistoryUseCase,
  GetQuoteRequestByIdUseCase,
  GetStatusHistoryUseCase,
  ListAdminQuoteRequestsUseCase,
  ListArtisanQuoteRequestsUseCase,
  ListBuyerQuoteRequestsUseCase,
  ListQuoteRequestRecipientsUseCase,
  SendQuoteRequestUseCase,
  UpdateDraftQuoteRequestUseCase,
  UpdateRecipientContactUseCase,
} from '../../../../src/modules/trading/application/use-cases';
import {
  InvalidStateTransitionError,
  NoEligibleWorkshopError,
  QuoteRequestNotFoundError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import {
  ADMIN,
  ARTISAN,
  BIDDING_DEADLINE,
  BUYER,
  DELIVERY_DEADLINE,
  NOW,
  OTHER_BUYER,
  createTradingTestDeps,
  makeAllocation,
  makeInvitedDto,
  makeRecipient,
  makeRequest,
  makeRequestDetail,
  makeSummaryDto,
} from '../../../support/trading-unit-harness';

describe('Trading Request Use Cases — All 14 Endpoints (UC-14, UC-15, UC-17, UC-18, BR-04, BR-11..13)', () => {
  it('CreateDraft, UpdateDraft, DeleteDraft & Copy handle Buyer lifecycle and reject non-owner / non-draft', async () => {
    const deps = createTradingTestDeps();
    const draft = makeRequest({ status: 'draft_request', version: 1 });
    deps.quoteRequestRepo.findById.mockResolvedValue(draft);
    deps.quoteRequestRepo.lockById.mockResolvedValue(draft);

    // 1. CreateDraft
    const created = await new CreateDraftQuoteRequestUseCase(deps.txRunner, deps.quoteRequestRepo).execute({
      actor: BUYER,
      draft: { category_id: '5', spec: '1000 ấm trà', quantity: 1000, unit: 'piece', delivery_mode: 'at_buyer_address' },
    });
    expect(created.status).toBe('draft_request');
    expect(deps.quoteRequestRepo.createDraft).toHaveBeenCalledTimes(1);

    // 2. UpdateDraft
    const updated = await new UpdateDraftQuoteRequestUseCase(deps.txRunner, deps.quoteRequestRepo).execute({
      actor: BUYER,
      requestId: '1001',
      expectedRequestVersion: 1,
      draft: { spec: '2000 ấm trà men ngọc', quantity: 2000, unit: 'piece', delivery_mode: 'at_buyer_address' },
    });
    expect(updated.version).toBe(2);
    await expect(
      new UpdateDraftQuoteRequestUseCase(deps.txRunner, deps.quoteRequestRepo).execute({
        actor: OTHER_BUYER,
        requestId: '1001',
        expectedRequestVersion: 1,
        draft: { spec: 'IDOR' },
      }),
    ).rejects.toThrow(TradingPermissionDeniedError);

    // 3. DeleteDraft (only draft_request)
    await new DeleteDraftQuoteRequestUseCase(deps.txRunner, deps.quoteRequestRepo).execute({
      actor: BUYER,
      requestId: '1001',
      expectedRequestVersion: 1,
    });
    expect(deps.quoteRequestRepo.deleteDraft).toHaveBeenCalledTimes(1);

    // 4. CopyQuoteRequest clones into fresh draft_request without old status/history
    deps.quoteRequestRepo.findById.mockResolvedValueOnce(makeRequest({ status: 'delivered', version: 6 }));
    const copied = await new CopyQuoteRequestUseCase(deps.txRunner, deps.quoteRequestRepo).execute({ actor: BUYER, requestId: '1001' });
    expect(copied.status).toBe('draft_request');
    expect(copied.version).toBe(1);
  });

  it('UpdateRecipientContact & CloseBidding enforce ownership, version increment, and state constraints (BR-11, BR-12)', async () => {
    const deps = createTradingTestDeps();
    const sent = makeRequest({ status: 'sent_to_artisans', version: 2 });
    deps.quoteRequestRepo.lockById.mockResolvedValue(sent);

    const edited = await new UpdateRecipientContactUseCase(deps.txRunner, deps.quoteRequestRepo).execute({
      actor: BUYER,
      requestId: '1001',
      expectedRequestVersion: 2,
      recipientName: 'Nguyễn Văn Nhận Mới',
      recipientPhone: '0988111222',
    });
    expect(edited.version).toBe(3);

    const closed = await new CloseBiddingUseCase(deps.txRunner, deps.quoteRequestRepo).execute({
      actor: BUYER,
      requestId: '1001',
      expectedRequestVersion: 2,
      now: NOW,
    });
    expect(closed.bidding_closed_at).toEqual(NOW);

    // Delivered request cannot edit contact
    deps.quoteRequestRepo.lockById.mockResolvedValueOnce(makeRequest({ status: 'delivered', version: 6 }));
    await expect(
      new UpdateRecipientContactUseCase(deps.txRunner, deps.quoteRequestRepo).execute({
        actor: BUYER,
        requestId: '1001',
        expectedRequestVersion: 6,
        recipientName: 'Late',
        recipientPhone: '0900000000',
      }),
    ).rejects.toThrow(InvalidStateTransitionError);
  });

  it('SendQuoteRequest (SendRequestWorkflow) locks eligible workshops ascending, creates recipients, and fails when none eligible (BR-13)', async () => {
    const deps = createTradingTestDeps();
    const draft = makeRequest({
      status: 'draft_request',
      version: 1,
      bidding_deadline: BIDDING_DEADLINE,
      delivery_deadline: DELIVERY_DEADLINE,
    });
    deps.quoteRequestRepo.findById.mockResolvedValue(draft);
    deps.quoteRequestRepo.lockById.mockResolvedValue(draft);

    const sendUc = new SendQuoteRequestUseCase(
      deps.txRunner,
      deps.quoteRequestRepo,
      deps.recipientRepo,
      deps.catalogContract,
      deps.workshopContract,
    );
    const sent = await sendUc.execute({ actor: BUYER, requestId: '1001', expectedRequestVersion: 1, now: NOW });
    expect(sent.status).toBe('sent_to_artisans');
    expect(deps.workshopContract.lockAndAssertActive).toHaveBeenCalledWith(['301', '302'], expect.anything());
    expect(deps.recipientRepo.createMany).toHaveBeenCalledTimes(1);

    // Zero eligible workshops -> NoEligibleWorkshopError
    deps.catalogContract.givenEligibleWorkshops('5');
    await expect(sendUc.execute({ actor: BUYER, requestId: '1001', expectedRequestVersion: 1, now: NOW })).rejects.toThrow(NoEligibleWorkshopError);
  });

  it('ListBuyer, ListArtisan (BR-04 contact masking) & ListAdmin enforce role isolation and pagination', async () => {
    const deps = createTradingTestDeps();
    deps.quoteRequestRepo.findBuyerQuoteRequests.mockResolvedValue({ items: [makeSummaryDto()], total: 1 });
    deps.quoteRequestRepo.findAdminQuoteRequests.mockResolvedValue({ items: [makeSummaryDto()], total: 1 });
    deps.quoteRequestRepo.findArtisanQuoteRequests.mockResolvedValue({ items: [makeInvitedDto()], total: 1 });

    const buyerRes = await new ListBuyerQuoteRequestsUseCase(deps.txRunner, deps.quoteRequestRepo).execute({ actor: BUYER, query: { page: 1, limit: 20 } });
    expect(buyerRes.items).toHaveLength(1);
    await expect(
      new ListBuyerQuoteRequestsUseCase(deps.txRunner, deps.quoteRequestRepo).execute({ actor: ARTISAN, query: {} }),
    ).rejects.toThrow(TradingPermissionDeniedError);

    const artisanRes = await new ListArtisanQuoteRequestsUseCase(deps.txRunner, deps.quoteRequestRepo).execute({ actor: ARTISAN, query: {} });
    expect(artisanRes.items).toHaveLength(1);
    // BR-04: unallocated Artisan list item must NOT expose Buyer contact or detailed delivery_address
    expect(artisanRes.items[0]).not.toHaveProperty('recipient_name');
    expect(artisanRes.items[0]).not.toHaveProperty('recipient_phone');
    expect(artisanRes.items[0]).not.toHaveProperty('delivery_address');

    const adminRes = await new ListAdminQuoteRequestsUseCase(deps.txRunner, deps.quoteRequestRepo).execute({ actor: ADMIN, query: {} });
    expect(adminRes.items).toHaveLength(1);
    await expect(
      new ListAdminQuoteRequestsUseCase(deps.txRunner, deps.quoteRequestRepo).execute({ actor: BUYER, query: {} }),
    ).rejects.toThrow(TradingPermissionDeniedError);
  });

  it('GetQuoteRequestById masks contact for unallocated Artisan, reveals for winning Artisan/Buyer/Admin, and blocks IDOR (BR-04, SEC-06)', async () => {
    const deps = createTradingTestDeps();
    const detail = makeRequestDetail();
    deps.quoteRequestRepo.findDetailById.mockResolvedValue(detail);
    const getDetail = new GetQuoteRequestByIdUseCase(deps.txRunner, deps.quoteRequestRepo);

    // Owner Buyer & Admin see full Buyer contact
    const buyerView = await getDetail.execute({ actor: BUYER, id: '1001' });
    expect((buyerView as { recipient_phone?: string }).recipient_phone).toBe('0901234567');
    const adminView = await getDetail.execute({ actor: ADMIN, id: '1001' });
    expect((adminView as { recipient_name?: string }).recipient_name).toBe('Nguyễn Văn Mua');

    // Non-owner Buyer gets 404 (SEC-06 IDOR protection)
    await expect(getDetail.execute({ actor: OTHER_BUYER, id: '1001' })).rejects.toThrow(QuoteRequestNotFoundError);

    // Invited Artisan WITHOUT Allocation -> contact & delivery_address omitted (BR-04)
    const invitedView = await getDetail.execute({ actor: ARTISAN, id: '1001' });
    expect(invitedView).not.toHaveProperty('recipient_phone');
    expect(invitedView).not.toHaveProperty('delivery_address');

    // Winning Artisan WITH Allocation -> contact unlocked (BR-04)
    deps.quoteRequestRepo.findDetailById.mockResolvedValueOnce(
      makeRequestDetail({ entity: makeRequest({ status: 'buyer_accepted' }), allocations: [{ entity: makeAllocation() }] }),
    );
    const allocatedView = await getDetail.execute({ actor: ARTISAN, id: '1001' });
    expect(allocatedView).toMatchObject({
      own_allocation_id: '5001',
      recipient_phone: '0901234567',
    });
  });

  it('ListRecipients, GetContactHistory & GetStatusHistory enforce Buyer/Admin/winning-Artisan access and pagination', async () => {
    const deps = createTradingTestDeps();
    const req = makeRequest();
    deps.quoteRequestRepo.findById.mockResolvedValue(req);
    deps.recipientRepo.findRecipientsWithDetails.mockResolvedValue({
      rows: [{ entity: makeRecipient(), workshop: { id: '301', name: 'Xưởng Gốm Minh Long', status: 'active' }, quote: null }],
      totalRecords: 1,
    });
    deps.contactEditHistoryRepo.findEventsWithPagination.mockResolvedValue({
      rows: [{ id: '1', old_recipient_name: 'Cũ', new_recipient_name: 'Mới', old_recipient_phone: '090', new_recipient_phone: '091', edited_by: { id: '10', display_name: 'Buyer' }, edited_at: NOW.toISOString() }],
      totalRecords: 1,
    });
    deps.statusLogRepo.findEventsWithPagination.mockResolvedValue({
      rows: [{ id: '1', event_type: 'sent', prev_status: 'draft_request', new_status: 'sent_to_artisans', is_admin_action: false, performed_by: { id: '10', display_name: 'Buyer' }, reason: null, evidence: null, created_at: NOW.toISOString() }],
      totalRecords: 1,
      items: [],
      total: 1,
    });

    // ListRecipients: Buyer/Admin allowed, Artisan rejected (403)
    const recipients = await new ListQuoteRequestRecipientsUseCase(deps.txRunner, deps.quoteRequestRepo, deps.recipientRepo).execute({ actor: BUYER, requestId: '1001' });
    expect(recipients.data).toHaveLength(1);
    await expect(
      new ListQuoteRequestRecipientsUseCase(deps.txRunner, deps.quoteRequestRepo, deps.recipientRepo).execute({ actor: ARTISAN, requestId: '1001' }),
    ).rejects.toThrow(TradingPermissionDeniedError);

    // GetContactHistory: Owner Buyer allowed; unallocated Artisan blocked (404)
    const contacts = await new GetContactHistoryUseCase(deps.txRunner, deps.quoteRequestRepo, deps.contactEditHistoryRepo, deps.allocationRepo).execute({ actor: BUYER, requestId: '1001' });
    expect(contacts.data).toHaveLength(1);
    await expect(
      new GetContactHistoryUseCase(deps.txRunner, deps.quoteRequestRepo, deps.contactEditHistoryRepo, deps.allocationRepo).execute({ actor: ARTISAN, requestId: '1001' }),
    ).rejects.toThrow(QuoteRequestNotFoundError);

    // GetStatusHistory: Owner Buyer & Admin allowed; Artisan rejected (403)
    const history = await new GetStatusHistoryUseCase(deps.txRunner, deps.quoteRequestRepo, deps.statusLogRepo).execute({ actor: ADMIN, requestId: '1001' });
    expect(history.data).toHaveLength(1);
    await expect(
      new GetStatusHistoryUseCase(deps.txRunner, deps.quoteRequestRepo, deps.statusLogRepo).execute({ actor: ARTISAN, requestId: '1001' }),
    ).rejects.toThrow(TradingPermissionDeniedError);
  });
});
