import { describe, expect, it } from 'vitest';
import {
  CancelQuoteRequestByAdminUseCase,
  CancelQuoteRequestByBuyerUseCase,
  ConfirmDeliveryByAdminUseCase,
  ConfirmDeliveryUseCase,
  GetAllocationBatchesUseCase,
  GetAllocationByIdUseCase,
  GetAllocationHistoryUseCase,
  HandoverAllocationByAdminUseCase,
  HandoverAllocationUseCase,
  LinkAllocationBatchesUseCase,
  ListArtisanAllocationsUseCase,
  ListQuoteRequestAllocationsUseCase,
  StartAllocationProductionUseCase,
} from '../../../../src/modules/trading/application/use-cases';
import {
  AllocationNotFoundError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import {
  ADMIN,
  ARTISAN,
  BUYER,
  NOW,
  OTHER_ARTISAN,
  createTradingTestDeps,
  makeAllocation,
  makeAllocationDetailRecord,
  makeAllocationDto,
  makeRequest,
} from '../../../support/trading-unit-harness';

describe('Trading Fulfillment, Cancellation & Admin Override Use Cases — All 13 Endpoints (UC-23..27, BR-04, BR-21..26)', () => {
  it('Allocation read endpoints (ListRequestAllocations, ListArtisanAllocations, GetDetail, GetHistory, GetBatches) enforce RBAC & BR-04', async () => {
    const deps = createTradingTestDeps();
    const allocDto = makeAllocationDto();
    deps.quoteRequestRepo.findById.mockResolvedValue(makeRequest({ status: 'in_production', version: 5 }));
    deps.allocationRepo.findAllocationsWithDetails.mockResolvedValue({ rows: [allocDto], totalRecords: 1 });
    deps.allocationRepo.findArtisanAllocations.mockResolvedValue({ rows: [allocDto], totalRecords: 1 });
    deps.allocationRepo.findDetailById.mockResolvedValue(makeAllocationDetailRecord());
    deps.allocationRepo.findById.mockResolvedValue(makeAllocation({ status: 'in_production', version: 2 }));
    deps.allocationLogRepo.findEventsWithPagination.mockResolvedValue({
      rows: [{ id: '1', event_type: 'started', prev_status: 'not_started', new_status: 'in_production', is_admin_action: false, performed_by: { id: '20', display_name: 'Artisan' }, reason: null, evidence: null, actual_handover_at: null, created_at: NOW.toISOString() }],
      totalRecords: 1,
    });
    deps.allocationBatchRepo.findBatchesWithPagination.mockResolvedValue({
      rows: [{ batch_id: '901', batch_name: 'Lô 901', batch_status: 'published', linked_quantity: 5000, trace_url: '/api/v1/trace/901', linked_at: NOW.toISOString() }],
      totalRecords: 1,
    });

    // 1. ListQuoteRequestAllocations (Buyer/Admin/owning Artisan)
    expect((await new ListQuoteRequestAllocationsUseCase(deps.txRunner, deps.quoteRequestRepo, deps.allocationRepo).execute({ actor: BUYER, requestId: '1001' })).data).toHaveLength(1);

    // 2. ListArtisanAllocations (Artisan only)
    const artList = new ListArtisanAllocationsUseCase(deps.txRunner, deps.allocationRepo);
    expect((await artList.execute({ actor: ARTISAN })).data).toHaveLength(1);
    await expect(artList.execute({ actor: BUYER })).rejects.toThrow(TradingPermissionDeniedError);

    // 3. GetAllocationById unlocks Buyer contact for winning Artisan & blocks non-owning Artisan (404)
    const getDetail = new GetAllocationByIdUseCase(deps.txRunner, deps.allocationRepo);
    const detail = await getDetail.execute({ actor: ARTISAN, id: '5001' });
    expect(detail).toMatchObject({ recipient_name: 'Nguyễn Văn Mua', recipient_phone: '0901234567' });
    await expect(getDetail.execute({ actor: OTHER_ARTISAN, id: '5001' })).rejects.toThrow(AllocationNotFoundError);

    // 4 & 5. GetAllocationHistory & GetAllocationBatches
    expect((await new GetAllocationHistoryUseCase(deps.txRunner, deps.allocationRepo, deps.allocationLogRepo, deps.quoteRequestRepo).execute({ actor: ARTISAN, id: '5001' })).data).toHaveLength(1);
    expect((await new GetAllocationBatchesUseCase(deps.txRunner, deps.allocationRepo, deps.allocationBatchRepo, deps.quoteRequestRepo).execute({ actor: BUYER, id: '5001' })).data).toHaveLength(1);
  });

  it('StartProduction, LinkBatches, Handover & Buyer ConfirmDelivery progress full fulfillment lifecycle (BR-24, BR-25)', async () => {
    const deps = createTradingTestDeps();

    // 1. StartAllocationProduction: first start transitions QuoteRequest buyer_accepted -> in_production
    const acceptedReq = makeRequest({ status: 'buyer_accepted', version: 4 });
    const notStartedAlloc = makeAllocation({ status: 'not_started', version: 1 });
    deps.quoteRequestRepo.lockById.mockResolvedValue(acceptedReq);
    deps.allocationRepo.lockById.mockResolvedValue(notStartedAlloc);
    deps.allocationRepo.findById.mockResolvedValue(notStartedAlloc);
    const started = await new StartAllocationProductionUseCase(deps.txRunner, deps.allocationRepo, deps.quoteRequestRepo, deps.workshopContract).execute({
      actor: ARTISAN,
      allocationId: '5001',
      expectedAllocationVersion: 1,
      now: NOW,
    });
    expect(started.allocation.status).toBe('in_production');
    expect(deps.quoteRequestRepo.update).toHaveBeenCalledTimes(1);

    // 2. LinkAllocationBatches: verifies owned batches & clears traceability warning
    const inProdReq = makeRequest({ status: 'in_production', version: 5 });
    const inProdAlloc = makeAllocation({ status: 'in_production', version: 2, started_at: NOW, started_by: '20' });
    deps.quoteRequestRepo.lockById.mockResolvedValue(inProdReq);
    deps.allocationRepo.lockById.mockResolvedValue(inProdAlloc);
    deps.allocationRepo.findById.mockResolvedValue(inProdAlloc);
    const linked = await new LinkAllocationBatchesUseCase(
      deps.txRunner,
      deps.allocationRepo,
      deps.quoteRequestRepo,
      deps.traceabilityContract,
      deps.allocationBatchRepo,
      deps.workshopContract,
    ).execute({
      actor: ARTISAN,
      allocationId: '5001',
      expectedAllocationVersion: 2,
      links: [{ batch_id: '901', linked_quantity: 5000 }],
      now: NOW,
    });
    expect(linked.allocation.version).toBe(3);
    expect(linked.allocation.traceability_warning).toBeNull();

    // 3. HandoverAllocation: in_production -> handed_over
    const handed = await new HandoverAllocationUseCase(deps.txRunner, deps.allocationRepo, deps.quoteRequestRepo, deps.workshopContract).execute({
      actor: ARTISAN,
      allocationId: '5001',
      expectedAllocationVersion: 2,
      deliveryNote: 'Bàn giao đủ 5000 chiếc',
      now: NOW,
    });
    expect(handed.allocation.status).toBe('handed_over');

    // 4. ConfirmDelivery: all allocations handed_over -> QuoteRequest delivered (BR-25)
    const handedAlloc = makeAllocation({ status: 'handed_over', version: 3, started_at: NOW, handed_over_at: NOW });
    deps.allocationRepo.lockByRequestId.mockResolvedValueOnce([handedAlloc]);
    const confirmed = await new ConfirmDeliveryUseCase(deps.txRunner, deps.quoteRequestRepo, deps.allocationRepo).execute({
      actor: BUYER,
      requestId: '1001',
      expectedRequestVersion: 5,
      now: NOW,
    });
    expect(confirmed.request.status).toBe('delivered');

    // ConfirmDelivery blocked if any allocation is still in_production (BR-25)
    deps.allocationRepo.lockByRequestId.mockResolvedValueOnce([inProdAlloc]);
    await expect(
      new ConfirmDeliveryUseCase(deps.txRunner, deps.quoteRequestRepo, deps.allocationRepo).execute({
        actor: BUYER,
        requestId: '1001',
        expectedRequestVersion: 5,
        now: NOW,
      }),
    ).rejects.toThrow(InvalidStateTransitionError);
  });

  it('Buyer Cancel, Admin Cancel, Admin Handover & Admin ConfirmDelivery enforce BR-21, BR-22, BR-24, BR-25', async () => {
    const deps = createTradingTestDeps();

    // 1. CancelQuoteRequestByBuyer: allowed pre-accept, blocked post-accept (BR-21)
    deps.quoteRequestRepo.lockById.mockResolvedValueOnce(makeRequest({ status: 'artisans_bidding', version: 3 }));
    const buyerCancelUc = new CancelQuoteRequestByBuyerUseCase(deps.txRunner, deps.quoteRequestRepo);
    const buyerCancelled = await buyerCancelUc.execute({ actor: BUYER, requestId: '1001', expectedRequestVersion: 3, cancelReason: 'Không còn nhu cầu', now: NOW });
    expect(buyerCancelled.request.cancelled_at).toBe(NOW.toISOString());

    deps.quoteRequestRepo.lockById.mockResolvedValueOnce(makeRequest({ status: 'buyer_accepted', version: 4 }));
    await expect(buyerCancelUc.execute({ actor: BUYER, requestId: '1001', expectedRequestVersion: 4, now: NOW })).rejects.toThrow(InvalidStateTransitionError);

    // 2. CancelQuoteRequestByAdmin: allowed post-accept & requires reason + goodsHandlingNote (BR-21/BR-22)
    deps.quoteRequestRepo.lockById.mockResolvedValue(makeRequest({ status: 'in_production', version: 5 }));
    const adminCancelUc = new CancelQuoteRequestByAdminUseCase(deps.txRunner, deps.quoteRequestRepo);
    const adminCancelled = await adminCancelUc.execute({
      actor: ADMIN,
      requestId: '1001',
      expectedRequestVersion: 5,
      cancelReason: 'Thiên tai ngập xưởng',
      goodsHandlingNote: 'Hai bên tự đối soát phần đã giao',
      now: NOW,
    });
    expect(adminCancelled.request.cancelled_at).toBe(NOW.toISOString());
    await expect(
      adminCancelUc.execute({ actor: ADMIN, requestId: '1001', expectedRequestVersion: 5, cancelReason: '', goodsHandlingNote: 'note', now: NOW }),
    ).rejects.toThrow(InvalidTradingInputError);

    // 3. HandoverAllocationByAdmin: only in_production, requires reason/evidence/non-future time (BR-24)
    const inProdAlloc = makeAllocation({ status: 'in_production', version: 2, started_at: NOW, started_by: '20' });
    deps.allocationRepo.findById.mockResolvedValue(inProdAlloc);
    deps.allocationRepo.lockById.mockResolvedValue(inProdAlloc);
    const adminHandoverUc = new HandoverAllocationByAdminUseCase(deps.txRunner, deps.allocationRepo, deps.quoteRequestRepo, deps.workshopContract);
    const adminHanded = await adminHandoverUc.execute({
      actor: ADMIN,
      allocationId: '5001',
      expectedAllocationVersion: 2,
      reason: 'Hộ không thể đăng nhập',
      evidence: 'Biên bản ký nhận số 01',
      actualHandoverAt: NOW,
      now: NOW,
    });
    expect(adminHanded.allocation.status).toBe('handed_over');
    expect(adminHanded.allocation.admin_handed_over).toBe(true);

    // 4. ConfirmDeliveryByAdmin: requires all allocations handed_over + reason + evidence (BR-25)
    deps.allocationRepo.lockByRequestId.mockResolvedValue([makeAllocation({ status: 'handed_over', version: 3, started_at: NOW, handed_over_at: NOW })]);
    const adminConfirmUc = new ConfirmDeliveryByAdminUseCase(deps.txRunner, deps.quoteRequestRepo, deps.allocationRepo);
    const adminConfirmed = await adminConfirmUc.execute({
      actor: ADMIN,
      requestId: '1001',
      expectedRequestVersion: 5,
      reason: 'Xác minh đã giao đủ',
      evidence: 'Phiếu giao nhận có chữ ký Buyer',
      now: NOW,
    });
    expect(adminConfirmed.request.status).toBe('delivered');
    await expect(
      adminConfirmUc.execute({ actor: ADMIN, requestId: '1001', expectedRequestVersion: 5, reason: 'Thiếu căn cứ', evidence: '', now: NOW }),
    ).rejects.toThrow(InvalidTradingInputError);
  });
});
