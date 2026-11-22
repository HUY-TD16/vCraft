import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BusinessRuleException } from '../../../../src/common/domain/errors/business-rule.exception';
import {
  ConcurrencyConflictError,
  DeadlineViolationError,
  EntityId,
  IdempotencyConflictError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  Quantity,
  Quote,
  QuoteRequest,
  RequestRecipient,
  TradingIdempotencyPolicy,
  UnitPrice,
  Version,
} from '../../../../src/modules/trading/domain';
import {
  BIDDING_DEADLINE,
  BID_ACCEPT_DEADLINE,
  COMMITTED_DELIVERY,
  DELIVERY_DEADLINE,
  NOW,
  makeAllocation,
  makeQuote,
  makeRecipient,
  makeRequest,
} from '../../../support/trading-unit-harness';

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listTsFiles(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('Trading Domain Core (Clean Architecture, VOs, Entities & State Machine)', () => {
  it('enforces Clean Architecture purity: zero NestJS/Prisma/Express/process.env imports in domain/', () => {
    const domainFiles = listTsFiles(join(__dirname, '../../../../src/modules/trading/domain'));
    expect(domainFiles.length).toBeGreaterThan(0);
    for (const file of domainFiles) {
      const src = readFileSync(file, 'utf-8');
      expect(src, file).not.toMatch(/from\s+['"](@nestjs\/|@prisma\/|express|.*\/generated\/prisma)/);
      expect(src, file).not.toMatch(/\bprocess\.env\b/);
    }
  });

  it('validates domain Value Objects, Error hierarchy & IdempotencyPolicy', () => {
    expect(EntityId.sortAscending(['10', '2', '100'])).toEqual(['2', '10', '100']);
    expect(() => EntityId.of('0')).toThrow(InvalidTradingInputError);
    expect(UnitPrice.of(45000).calculateLineTotal(Quantity.of(500))).toBe('22500000');
    expect(Version.of(1).next().value).toBe(2);
    expect(new ConcurrencyConflictError('stale')).toBeInstanceOf(BusinessRuleException);
    expect(() => TradingIdempotencyPolicy.assertFingerprintMatches('a'.repeat(64), 'b'.repeat(64))).toThrow(IdempotencyConflictError);
  });

  it('enforces QuoteRequest 6-step lifecycle, contact edit, close bidding, and cancellation rules (BR-11, BR-12, BR-21, BR-25, BR-27)', () => {
    const { request: draft } = QuoteRequest.createDraft({
      id: '1001',
      buyer_id: '10',
      draft: {
        category_id: '5',
        spec: '5000 bát men rạn',
        quantity: 5000,
        unit: 'piece',
        delivery_mode: 'at_buyer_address',
        delivery_region: 'Hà Nội',
        delivery_address: 'Bát Tràng',
        recipient_name: 'Nguyễn Văn Mua',
        recipient_phone: '0901234567',
        bidding_deadline: BIDDING_DEADLINE,
        delivery_deadline: DELIVERY_DEADLINE,
      },
      now: NOW,
    });
    expect(draft.status).toBe('draft_request');

    const sent = draft.sendToArtisans({ buyerId: '10', expectedVersion: 1, eligibleWorkshopIds: ['301'], now: NOW }).request;
    expect(sent.status).toBe('sent_to_artisans');
    expect(sent.version).toBe(2);

    const edited = sent.updateRecipientContact({
      buyerId: '10',
      expectedVersion: 2,
      recipientName: 'Trần Văn B',
      recipientPhone: '0988776655',
      now: NOW,
    }).request;
    expect(edited.version).toBe(3);

    const closed = edited.closeBiddingEarly({ buyerId: '10', expectedVersion: 3, now: NOW }).request;
    expect(closed.bidding_closed_at).toEqual(NOW);

    // Pre-accept Buyer cancel works; post-accept Buyer cancel rejected (BR-21)
    const buyerCancelled = closed.cancel({ actorId: '10', actorRole: 'buyer', expectedVersion: 4, cancelReason: 'Đổi kế hoạch', now: NOW }).request;
    expect(buyerCancelled.cancelled_at).toEqual(NOW);

    const accepted = makeRequest({ status: 'artisans_bidding', version: 3 }).markBuyerAccepted({ buyerId: '10', expectedVersion: 3, now: NOW }).request;
    expect(accepted.status).toBe('buyer_accepted');
    expect(() =>
      accepted.cancel({ actorId: '10', actorRole: 'buyer', expectedVersion: 4, cancelReason: 'Buyer hủy sau chốt', now: NOW }),
    ).toThrow(InvalidStateTransitionError);

    // Admin cancel post-accept succeeds; Delivered cannot be cancelled (BR-21)
    const adminCancelled = accepted.cancel({
      actorId: '1',
      actorRole: 'admin',
      expectedVersion: 4,
      cancelReason: 'Sự cố bất khả kháng',
      goodsHandlingNote: 'Chưa sản xuất',
      now: NOW,
    }).request;
    expect(adminCancelled.cancelled_at).toEqual(NOW);
    expect(() =>
      makeRequest({ status: 'delivered', version: 6 }).cancel({
        actorId: '1',
        actorRole: 'admin',
        expectedVersion: 6,
        cancelReason: 'Hủy sau giao',
        goodsHandlingNote: 'N/A',
        now: NOW,
      }),
    ).toThrow(InvalidStateTransitionError);
  });

  it('enforces Quote deadlines/capacity/withdraw & Allocation sequential progress (BR-14, BR-15, BR-24, BR-27)', () => {
    const req = makeRequest({ status: 'artisans_bidding', version: 3 });
    const recipient = makeRecipient({ response_status: 'pending', version: 1 });

    // Quote submitNew validates deadlines (BR-14: accept_deadline >= bidding_deadline + 24h) & max_quantity <= req.quantity
    expect(() =>
      Quote.submitNew({
        id: '401',
        request: req,
        recipient,
        actorId: '20',
        workshopIsActive: true,
        unitPrice: 45000,
        maxQuantity: 5000,
        bidAcceptDeadline: new Date(BIDDING_DEADLINE.getTime() + 1000),
        committedDeliveryAt: COMMITTED_DELIVERY,
        now: NOW,
      }),
    ).toThrow(DeadlineViolationError);

    expect(() =>
      Quote.submitNew({
        id: '401',
        request: req,
        recipient,
        actorId: '20',
        workshopIsActive: true,
        unitPrice: 45000,
        maxQuantity: 9999,
        bidAcceptDeadline: BID_ACCEPT_DEADLINE,
        committedDeliveryAt: COMMITTED_DELIVERY,
        now: NOW,
      }),
    ).toThrow(InvalidTradingInputError);

    const withdrawn = makeQuote().withdraw({
      request: req,
      recipient: makeRecipient({ response_status: 'quoted', version: 2 }),
      actorId: '20',
      withdrawReason: 'Kín lịch lò',
      expectedQuoteVersion: 1,
      now: NOW,
    }).quote;
    expect(withdrawn.status).toBe('withdrawn');
    expect(withdrawn.version).toBe(2);

    // Allocation sequential transitions: not_started -> in_production -> handed_over (BR-24)
    const acceptedReq = makeRequest({ status: 'buyer_accepted', version: 4 });
    const alloc = makeAllocation({ status: 'not_started', version: 1 });
    expect(() =>
      alloc.recordArtisanHandover({ request: acceptedReq, actorId: '20', actorWorkshopId: '301', expectedVersion: 1, now: NOW }),
    ).toThrow(InvalidStateTransitionError);

    const started = alloc.startProduction({ request: acceptedReq, actorId: '20', actorWorkshopId: '301', expectedVersion: 1, now: NOW }).allocation;
    expect(started.status).toBe('in_production');
    const handedOver = started.recordArtisanHandover({
      request: makeRequest({ status: 'in_production', version: 5 }),
      actorId: '20',
      actorWorkshopId: '301',
      expectedVersion: 2,
      deliveryNote: 'Đã giao đủ 5000 bát',
      now: NOW,
    }).allocation;
    expect(handedOver.status).toBe('handed_over');
    expect(handedOver.version).toBe(3);

    // RequestRecipient decline rejects stale version
    expect(() =>
      RequestRecipient.reconstitute({ ...makeRecipient({ response_status: 'pending', version: 2 }) }).decline({
        actorId: '20',
        expectedVersion: 1,
        reason: 'Stale',
        requestBiddingOpen: true,
        requestAcceptedOrCancelled: false,
        now: NOW,
      }),
    ).toThrow(ConcurrencyConflictError);
  });
});
