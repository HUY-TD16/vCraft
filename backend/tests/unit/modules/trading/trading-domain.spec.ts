import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BusinessRuleException } from '../../../../src/common/domain/errors/business-rule.exception';
import {
  Allocation,
  BiddingClosedError,
  ConcurrencyConflictError,
  DeadlineViolationError,
  EntityId,
  IdempotencyConflictError,
  InsufficientCapacityError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  Invariant01StateMachineError,
  Invariant02DeadlineBiddingError,
  Invariant03QuantitySplitError,
  Invariant04FulfillmentBatchError,
  Invariant05ConcurrencyIdempotencyError,
  Money,
  NoEligibleWorkshopError,
  ProposalExpectationVO,
  Quantity,
  Quote,
  QuoteDeadlines,
  QuoteExpiredError,
  QuoteRequest,
  RecipientContact,
  RequestDeadlines,
  RequestRecipient,
  SplitProposal,
  SplitProposalInvalidationPolicy,
  TRADING_INVARIANTS,
  TradingDomainError,
  TradingIdempotencyPolicy,
  TradingLockOrderingPolicy,
  TradingPermissionDeniedError,
  TradingResourceNotFoundError,
  TWENTY_FOUR_HOURS_MS,
  UnitPrice,
  Version,
  WorkshopSuspendedError,
} from '../../../../src/modules/trading/domain';

function collectTypeScriptFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...collectTypeScriptFiles(fullPath));
    } else if (entry.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Trading Module — Clean Architecture & Domain Core (Task 1)', () => {
  const baseNow = new Date('2026-11-11T08:00:00.000Z');
  const biddingDeadline = new Date('2026-11-13T08:00:00.000Z'); // +48h
  const deliveryDeadline = new Date('2026-11-16T08:00:00.000Z'); // +72h after bidding_deadline (> 24h)
  const bidAcceptDeadline = new Date('2026-11-14T10:00:00.000Z'); // >= bidding_deadline + 24h (26h)
  const committedDeliveryAt = new Date('2026-11-15T12:00:00.000Z'); // > bid_accept_deadline and <= delivery_deadline

  function createValidDraft(now: Date = baseNow): QuoteRequest {
    const { request } = QuoteRequest.createDraft({
      id: '100',
      buyer_id: '10',
      now,
      draft: {
        category_id: '1',
        spec: 'Bộ ấm chén men lam vẽ tay truyền thống',
        quantity: 100,
        unit: 'set',
        unit_set_description: '1 ấm + 6 chén + 7 đĩa kê',
        delivery_mode: 'at_buyer_address',
        delivery_region: 'Hà Nội',
        delivery_address: 'Số 10 Hàng Gai, Hoàn Kiếm, Hà Nội',
        recipient_name: 'Nguyễn Văn Mua',
        recipient_phone: '0912345678',
        bidding_deadline: biddingDeadline,
        delivery_deadline: deliveryDeadline,
      },
    });
    return request;
  }

  function createSentRequest(now: Date = baseNow): QuoteRequest {
    const draft = createValidDraft(now);
    const { request } = draft.sendToArtisans({
      buyerId: '10',
      expectedVersion: 1,
      eligibleWorkshopIds: ['202', '201'],
      now,
    });
    return request;
  }

  function createRecipient(
    id: string,
    requestId: string,
    workshopId: string,
  ): RequestRecipient {
    return RequestRecipient.reconstitute({
      id,
      request_id: requestId,
      workshop_id: workshopId,
      response_status: 'pending',
      decline_reason: null,
      responded_by: null,
      responded_at: null,
      sent_at: baseNow,
      version: 1,
    });
  }

  describe('Clean Architecture Boundary Verification', () => {
    it('ensures trading/domain and trading/application contain no framework, ORM, or adapter imports', () => {
      const tradingRoot = join(
        __dirname,
        '../../../../src/modules/trading',
      );
      const coreFiles = [
        ...collectTypeScriptFiles(join(tradingRoot, 'domain')),
        ...collectTypeScriptFiles(join(tradingRoot, 'application')),
      ];

      expect(coreFiles.length).toBeGreaterThan(0);

      for (const filePath of coreFiles) {
        const source = readFileSync(filePath, 'utf8');
        expect(source).not.toMatch(/@nestjs\//);
        expect(source).not.toMatch(/@prisma\/client/);
        expect(source).not.toMatch(/from\s+['"]zod['"]/);
        expect(source).not.toMatch(/adapters\//);
      }
    });
  });

  describe('Domain Errors (INV-01 to INV-05) & BusinessRuleException Inheritance', () => {
    it('inherits BusinessRuleException with canonical error codes and invariant tags', () => {
      const errors: TradingDomainError[] = [
        new InvalidStateTransitionError('state error'),
        new DeadlineViolationError('deadline error'),
        new BiddingClosedError('bidding closed'),
        new QuoteExpiredError('quote expired'),
        new WorkshopSuspendedError('workshop suspended'),
        new NoEligibleWorkshopError('no workshop'),
        new InsufficientCapacityError('insufficient capacity'),
        new ConcurrencyConflictError('concurrency conflict'),
        new IdempotencyConflictError('idempotency conflict'),
        new InvalidTradingInputError('invalid input'),
        new TradingPermissionDeniedError('permission denied'),
        new TradingResourceNotFoundError('not found'),
        new Invariant01StateMachineError('inv 01'),
        new Invariant02DeadlineBiddingError('inv 02'),
        new Invariant03QuantitySplitError('inv 03'),
        new Invariant04FulfillmentBatchError('inv 04'),
        new Invariant05ConcurrencyIdempotencyError('inv 05'),
      ];

      for (const err of errors) {
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(BusinessRuleException);
        expect(err).toBeInstanceOf(TradingDomainError);
      }

      expect(new Invariant01StateMachineError('x').invariant).toBe(
        TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
      );
      expect(new Invariant02DeadlineBiddingError('x').invariant).toBe(
        TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
      );
      expect(new Invariant03QuantitySplitError('x').invariant).toBe(
        TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
      );
      expect(new Invariant04FulfillmentBatchError('x').invariant).toBe(
        TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
      );
      expect(new Invariant05ConcurrencyIdempotencyError('x').invariant).toBe(
        TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
      );
    });
  });

  describe('Value Objects & Policies', () => {
    it('validates EntityId and sorts IDs numerically in ascending order for lock plans', () => {
      expect(() => EntityId.of('0')).toThrow(InvalidTradingInputError);
      expect(() => EntityId.of('-5')).toThrow(InvalidTradingInputError);
      expect(() => EntityId.of('abc')).toThrow(InvalidTradingInputError);
      expect(() => EntityId.of('9223372036854775808')).toThrow(
        InvalidTradingInputError,
      );

      const id = EntityId.of('42');
      expect(id.value).toBe('42');
      expect(id.toBigInt()).toBe(42n);
      expect(id.equals('42')).toBe(true);

      const lockPlan = TradingLockOrderingPolicy.buildLockPlan({
        requestIds: ['10', '2', '10'],
        quoteIds: ['100', '20', '3'],
      });
      expect(lockPlan.requestIds).toEqual(['2', '10']);
      expect(lockPlan.quoteIds).toEqual(['3', '20', '100']);
    });

    it('validates Version, ProposalExpectationVO, and Idempotency fingerprint (INV-05)', () => {
      const v1 = Version.initial();
      expect(v1.value).toBe(1);
      expect(v1.next().value).toBe(2);

      expect(() => v1.assertMatches(2, 'QuoteRequest')).toThrow(
        ConcurrencyConflictError,
      );

      const emptyExpectation = ProposalExpectationVO.of({
        expected_proposal_id: null,
        expected_proposal_version: null,
      });
      expect(() =>
        emptyExpectation.assertMatchesCurrent({ id: '50', version: 1 }),
      ).toThrow(ConcurrencyConflictError);

      const specificExpectation = ProposalExpectationVO.of({
        expected_proposal_id: '50',
        expected_proposal_version: 2,
      });
      expect(() =>
        specificExpectation.assertMatchesCurrent({ id: '51', version: 2 }),
      ).toThrow(ConcurrencyConflictError);
      expect(() =>
        specificExpectation.assertMatchesCurrent({ id: '50', version: 1 }),
      ).toThrow(ConcurrencyConflictError);
      expect(() =>
        specificExpectation.assertMatchesCurrent({ id: '50', version: 2 }),
      ).not.toThrow();

      expect(() =>
        TradingIdempotencyPolicy.assertFingerprintMatches('fp-a', 'fp-b'),
      ).toThrow(IdempotencyConflictError);
    });

    it('validates Quantity and Money/UnitPrice exact integer arithmetic (INV-03)', () => {
      expect(() => Quantity.of(0)).toThrow(InvalidTradingInputError);
      expect(() => UnitPrice.of(0)).toThrow(InvalidTradingInputError);
      expect(() => UnitPrice.of(1_000_000_000_000_000)).toThrow(
        InvalidTradingInputError,
      );

      const unitPrice = Money.of(250_000);
      const lineTotal = unitPrice.calculateLineTotal(40);
      expect(lineTotal).toBe('10000000');
      expect(Money.sumAmounts([lineTotal, '15000000'])).toBe('25000000');
    });

    it('validates 24-hour deadline rules for RequestDeadlines and QuoteDeadlines (INV-02)', () => {
      const exact24hAfterBidding = new Date(
        biddingDeadline.getTime() + TWENTY_FOUR_HOURS_MS,
      );
      // Request delivery_deadline must be strictly > bidding_deadline + 24h
      expect(() =>
        RequestDeadlines.validateForSend(
          biddingDeadline,
          exact24hAfterBidding,
          baseNow,
        ),
      ).toThrow(DeadlineViolationError);

      // Quote bid_accept_deadline must be >= request.bidding_deadline + 24h
      const lessThan24hAfterBidding = new Date(
        biddingDeadline.getTime() + TWENTY_FOUR_HOURS_MS - 1,
      );
      expect(() =>
        QuoteDeadlines.validateForSubmission({
          bidAcceptDeadline: lessThan24hAfterBidding,
          committedDeliveryAt,
          requestBiddingDeadline: biddingDeadline,
          requestDeliveryDeadline: deliveryDeadline,
          now: baseNow,
        }),
      ).toThrow(DeadlineViolationError);
    });
  });

  describe('QuoteRequest Entity — INV-01, INV-02, INV-05', () => {
    it('enforces the 6-step sequential state machine and commercial immutability after sending', () => {
      const draft = createValidDraft();
      expect(draft.status).toBe('draft_request');

      // Cannot jump directly from draft_request to buyer_accepted
      expect(() =>
        QuoteRequest.assertSequentialTransition('draft_request', 'buyer_accepted'),
      ).toThrow(InvalidStateTransitionError);

      // Cannot send if no eligible workshops exist (INV-02)
      expect(() =>
        draft.sendToArtisans({
          buyerId: '10',
          expectedVersion: 1,
          eligibleWorkshopIds: [],
          now: baseNow,
        }),
      ).toThrow(NoEligibleWorkshopError);

      const { request: sent, recipientWorkshopIds } = draft.sendToArtisans({
        buyerId: '10',
        expectedVersion: 1,
        eligibleWorkshopIds: ['202', '201'],
        now: baseNow,
      });
      expect(sent.status).toBe('sent_to_artisans');
      expect(sent.version).toBe(2);
      expect(recipientWorkshopIds).toEqual(['201', '202']);

      // Commercial fields cannot be modified once sent (INV-01)
      expect(() =>
        sent.updateDraft({
          buyerId: '10',
          expectedVersion: 2,
          draft: { quantity: 200 },
          now: baseNow,
        }),
      ).toThrow(InvalidStateTransitionError);

      // Sent request cannot be deleted (only draft can be deleted)
      expect(() => sent.assertCanBeDeletedBy('10', 2)).toThrow(
        InvalidStateTransitionError,
      );

      // Contact info can be updated after sending and records ContactEditHistory
      const { request: contactUpdated, contactEditHistory } =
        sent.updateRecipientContact({
          buyerId: '10',
          expectedVersion: 2,
          recipientName: 'Trần Thị Nhận',
          recipientPhone: '0988888888',
          now: baseNow,
        });
      expect(contactUpdated.version).toBe(3);
      expect(contactEditHistory.prev_recipient_name).toBe('Nguyễn Văn Mua');
      expect(contactEditHistory.new_recipient_name).toBe('Trần Thị Nhận');
    });

    it('enforces Buyer vs Admin cancellation rules and blocks post-cancel mutations (INV-01)', () => {
      const draft = createValidDraft();
      // Draft cannot be cancelled
      expect(() =>
        draft.cancel({
          actorId: '10',
          actorRole: 'buyer',
          expectedVersion: 1,
          now: baseNow,
        }),
      ).toThrow(InvalidStateTransitionError);

      const sent = createSentRequest();
      // Admin cannot cancel while in sent_to_artisans
      expect(() =>
        sent.cancel({
          actorId: '999',
          actorRole: 'admin',
          expectedVersion: 2,
          cancelReason: 'Admin test',
          now: baseNow,
        }),
      ).toThrow(InvalidStateTransitionError);

      // Buyer can cancel in sent_to_artisans
      const { request: buyerCancelled } = sent.cancel({
        actorId: '10',
        actorRole: 'buyer',
        expectedVersion: 2,
        cancelReason: 'Đổi kế hoạch sự kiện',
        now: baseNow,
      });
      expect(buyerCancelled.isCancelled()).toBe(true);
      expect(buyerCancelled.status).toBe('sent_to_artisans'); // Status is preserved, not replaced by 'cancelled'

      // Cancelled request blocks contact updates and further transitions
      expect(() =>
        buyerCancelled.updateRecipientContact({
          buyerId: '10',
          expectedVersion: 3,
          recipientName: 'Ai đó',
          now: baseNow,
        }),
      ).toThrow(InvalidStateTransitionError);

      // In buyer_accepted, Buyer cannot cancel; Admin can cancel with mandatory reason
      const { request: bidding } = sent.recordFirstQuoteReceived({
        actorId: '201',
        now: baseNow,
      });
      const { request: accepted } = bidding.markBuyerAccepted({
        buyerId: '10',
        expectedVersion: 3,
        now: baseNow,
      });

      expect(() =>
        accepted.cancel({
          actorId: '10',
          actorRole: 'buyer',
          expectedVersion: 4,
          now: baseNow,
        }),
      ).toThrow(InvalidStateTransitionError);

      expect(() =>
        accepted.cancel({
          actorId: '999',
          actorRole: 'admin',
          expectedVersion: 4,
          cancelReason: '   ',
          now: baseNow,
        }),
      ).toThrow(InvalidTradingInputError);

      const { request: adminCancelled } = accepted.cancel({
        actorId: '999',
        actorRole: 'admin',
        expectedVersion: 4,
        cancelReason: 'Hai bên thống nhất hủy đơn ngoài hệ thống',
        now: baseNow,
      });
      expect(adminCancelled.isCancelled()).toBe(true);
      expect(adminCancelled.cancelled_by).toBe('999');
    });
  });

  describe('Quote & SplitProposal Entities — INV-02, INV-03, INV-05', () => {
    it('validates Quote submission, withdrawal after bidding closed, and direct acceptance capacity', () => {
      const sent = createSentRequest();
      const recipient1 = createRecipient('301', sent.id, '201');

      // Suspended workshop cannot submit quote (INV-02)
      expect(() =>
        Quote.submitNew({
          id: '401',
          request: sent,
          recipient: recipient1,
          actorId: '21',
          workshopIsActive: false,
          unitPrice: 200_000,
          maxQuantity: 60,
          bidAcceptDeadline,
          committedDeliveryAt,
          now: baseNow,
        }),
      ).toThrow(WorkshopSuspendedError);

      // Submit valid partial quote (60/100)
      const { quote: partialQuote, recipient: quotedRecipient } = Quote.submitNew({
        id: '401',
        request: sent,
        recipient: recipient1,
        actorId: '21',
        workshopIsActive: true,
        unitPrice: 200_000,
        maxQuantity: 60,
        bidAcceptDeadline,
        committedDeliveryAt,
        now: baseNow,
      });
      expect(partialQuote.status).toBe('active');
      expect(quotedRecipient.response_status).toBe('quoted');

      const { request: bidding } = sent.recordFirstQuoteReceived({
        actorId: '21',
        now: baseNow,
      });

      // Direct accept of partial quote (< 100%) must fail with InsufficientCapacityError (INV-03)
      expect(() =>
        partialQuote.acceptDirect({
          request: bidding,
          recipientId: quotedRecipient.id,
          actorId: '10',
          expectedQuoteVersion: 1,
          workshopIsActive: true,
          now: baseNow,
        }),
      ).toThrow(InsufficientCapacityError);

      // Close bidding early, then verify artisan can STILL withdraw quote (BR-14, BR-15)
      const { request: closedBidding } = bidding.closeBiddingEarly({
        buyerId: '10',
        expectedVersion: 3,
        now: baseNow,
      });

      // Cannot update quote after bidding closed
      expect(() =>
        partialQuote.updateOrResubmit({
          request: closedBidding,
          recipient: quotedRecipient,
          actorId: '21',
          expectedQuoteVersion: 1,
          workshopIsActive: true,
          unitPrice: 190_000,
          maxQuantity: 100,
          bidAcceptDeadline,
          committedDeliveryAt,
          now: baseNow,
        }),
      ).toThrow(BiddingClosedError);

      // Can withdraw quote even after bidding is closed
      const { quote: withdrawnQuote, recipient: withdrawnRecipient } =
        partialQuote.withdraw({
          request: closedBidding,
          recipient: quotedRecipient,
          actorId: '21',
          expectedQuoteVersion: 1,
          withdrawReason: 'Lò nung bảo trì đột xuất',
          now: baseNow,
        });
      expect(withdrawnQuote.status).toBe('withdrawn');
      expect(withdrawnRecipient.response_status).toBe('withdrawn');
    });

    it('validates SplitProposal creation (>= 2 workshops, exact sum, ProposalExpectation) and invalidation', () => {
      const sent = createSentRequest();
      const { request: bidding } = sent.recordFirstQuoteReceived({
        actorId: '21',
        now: baseNow,
      });

      const r1 = createRecipient('301', bidding.id, '201');
      const r2 = createRecipient('302', bidding.id, '202');

      const { quote: q1 } = Quote.submitNew({
        id: '401',
        request: bidding,
        recipient: r1,
        actorId: '21',
        workshopIsActive: true,
        unitPrice: 200_000,
        maxQuantity: 60,
        bidAcceptDeadline,
        committedDeliveryAt,
        now: baseNow,
      });

      const { quote: q2 } = Quote.submitNew({
        id: '402',
        request: bidding,
        recipient: r2,
        actorId: '22',
        workshopIsActive: true,
        unitPrice: 220_000,
        maxQuantity: 50,
        bidAcceptDeadline: new Date('2026-11-14T12:00:00.000Z'),
        committedDeliveryAt,
        now: baseNow,
      });

      const { request: splitRequested } = bidding.requestSplit({
        buyerId: '10',
        expectedVersion: 3,
        hasEligibleQuotes: true,
        now: baseNow,
      });
      expect(splitRequested.isBiddingOpenAt(baseNow)).toBe(false);

      // Sum != 100 (60 + 30 = 90) must fail with InsufficientCapacityError (INV-03)
      expect(() =>
        SplitProposal.propose({
          id: '501',
          request: splitRequested,
          expectedRequestVersion: 4,
          adminId: '999',
          proposalExpectation: {
            expected_proposal_id: null,
            expected_proposal_version: null,
          },
          currentProposedProposal: null,
          candidates: [
            {
              itemId: '601',
              workshop_id: '201',
              quote_id: q1.id,
              expected_quote_version: 1,
              allocated_quantity: 60,
              quote: q1,
              workshopIsActive: true,
            },
            {
              itemId: '602',
              workshop_id: '202',
              quote_id: q2.id,
              expected_quote_version: 1,
              allocated_quantity: 30,
              quote: q2,
              workshopIsActive: true,
            },
          ],
          now: baseNow,
        }),
      ).toThrow(InsufficientCapacityError);

      // Valid split proposal (60 + 40 = 100)
      const { proposal } = SplitProposal.propose({
        id: '501',
        request: splitRequested,
        expectedRequestVersion: 4,
        adminId: '999',
        proposalExpectation: {
          expected_proposal_id: null,
          expected_proposal_version: null,
        },
        currentProposedProposal: null,
        candidates: [
          {
            itemId: '601',
            workshop_id: '201',
            quote_id: q1.id,
            expected_quote_version: 1,
            allocated_quantity: 60,
            quote: q1,
            workshopIsActive: true,
          },
          {
            itemId: '602',
            workshop_id: '202',
            quote_id: q2.id,
            expected_quote_version: 1,
            allocated_quantity: 40,
            quote: q2,
            workshopIsActive: true,
          },
        ],
        now: baseNow,
      });

      expect(proposal.status).toBe('proposed');
      expect(
        proposal.computeTotalAmount(
          new Map([
            [q1.id, q1.unit_price],
            [q2.id, q2.unit_price],
          ]),
        ),
      ).toBe('20800000'); // 60*200,000 + 40*220,000 = 12,000,000 + 8,800,000

      // Detect invalidation when a workshop is suspended
      const reason = SplitProposalInvalidationPolicy.detectExpiryReason({
        proposal,
        request: splitRequested,
        quotesById: new Map([
          [q1.id, { quote: q1, workshopIsActive: false }],
          [q2.id, { quote: q2, workshopIsActive: true }],
        ]),
        now: baseNow,
      });
      expect(reason).toBe('workshop_suspended');

      // Buyer rejection requires a non-empty rejectReason
      expect(() =>
        proposal.rejectByBuyer({
          request: splitRequested,
          buyerId: '10',
          expectedRequestVersion: splitRequested.version,
          expectedProposalVersion: 1,
          rejectReason: '   ',
          now: baseNow,
        }),
      ).toThrow(InvalidTradingInputError);

      const rejectedProposal = proposal.rejectByBuyer({
        request: splitRequested,
        buyerId: '10',
        expectedRequestVersion: splitRequested.version,
        expectedProposalVersion: 1,
        rejectReason: 'Thời gian giao chưa phù hợp',
        now: baseNow,
      });
      expect(rejectedProposal.status).toBe('expired');
      expect(rejectedProposal.expire_reason).toBe('buyer_rejected');
    });
  });

  describe('Allocation & Fulfillment — INV-04, INV-05', () => {
    it('enforces Allocation state machine, batch link constraints, admin handover rules, and delivery confirmation', () => {
      const sent = createSentRequest();
      const { request: bidding } = sent.recordFirstQuoteReceived({
        actorId: '21',
        now: baseNow,
      });
      const { request: acceptedRequest } = bidding.markBuyerAccepted({
        buyerId: '10',
        expectedVersion: 3,
        now: baseNow,
      });

      const { allocation: alloc1 } = Allocation.createFromAcceptedQuote({
        id: '701',
        request_id: acceptedRequest.id,
        workshop_id: '201',
        quote_id: '401',
        quantity: 60,
        unit_price: 200_000,
        committed_delivery_at: committedDeliveryAt,
        actorId: '10',
        now: baseNow,
      });

      const { allocation: alloc2 } = Allocation.createFromAcceptedQuote({
        id: '702',
        request_id: acceptedRequest.id,
        workshop_id: '202',
        quote_id: '402',
        quantity: 40,
        unit_price: 220_000,
        committed_delivery_at: committedDeliveryAt,
        actorId: '10',
        now: baseNow,
      });

      // Cannot jump directly from not_started to handed_over (INV-04)
      expect(() =>
        alloc1.recordAdminHandover({
          request: acceptedRequest,
          adminId: '999',
          expectedVersion: 1,
          reason: 'Bàn giao thay',
          evidence: 'Biên bản bàn giao #01',
          actualHandoverAt: baseNow,
          now: baseNow,
        }),
      ).toThrow(InvalidStateTransitionError);

      // Start production on alloc1 -> transitions QuoteRequest to in_production
      const { allocation: alloc1InProd, updatedRequest: inProdRequest } =
        alloc1.startProduction({
          request: acceptedRequest,
          actorId: '21',
          actorWorkshopId: '201',
          expectedVersion: 1,
          batchLinks: [
            {
              batch_id: '801',
              batch_workshop_id: '201',
              linked_quantity: 40,
            },
          ],
          now: baseNow,
        });

      expect(alloc1InProd.status).toBe('in_production');
      expect(inProdRequest.status).toBe('in_production');
      expect(alloc1InProd.deriveTraceabilityWarning(new Set(['801']))).toBe(
        'INCOMPLETE_TRACEABILITY',
      );

      // Update batch links to full 60 on published batch -> warning becomes null
      const { allocation: alloc1FullBatch } = alloc1InProd.replaceBatchLinks({
        request: inProdRequest,
        actorId: '21',
        actorWorkshopId: '201',
        expectedVersion: 2,
        batchLinks: [
          {
            batch_id: '801',
            batch_workshop_id: '201',
            linked_quantity: 60,
          },
        ],
        now: baseNow,
      });
      expect(alloc1FullBatch.deriveTraceabilityWarning(new Set(['801']))).toBeNull();

      // Artisan records handover on alloc1
      const { allocation: alloc1HandedOver } = alloc1FullBatch.recordArtisanHandover({
        request: inProdRequest,
        actorId: '21',
        actorWorkshopId: '201',
        expectedVersion: 3,
        deliveryNote: 'Đã giao đủ 60 bộ',
        now: baseNow,
      });
      expect(alloc1HandedOver.status).toBe('handed_over');

      // Batch links are locked after handed_over (INV-04)
      expect(() =>
        alloc1HandedOver.replaceBatchLinks({
          request: inProdRequest,
          actorId: '21',
          actorWorkshopId: '201',
          expectedVersion: 4,
          batchLinks: [],
          now: baseNow,
        }),
      ).toThrow(InvalidStateTransitionError);

      // Buyer cannot confirm delivered while alloc2 is still not_started (INV-04)
      expect(() =>
        inProdRequest.confirmDelivered({
          actorId: '10',
          actorRole: 'buyer',
          expectedVersion: inProdRequest.version,
          allocationStatuses: [alloc1HandedOver.status, alloc2.status],
          now: baseNow,
        }),
      ).toThrow(InvalidStateTransitionError);

      // Start alloc2 and have Admin record handover on behalf of workshop 202
      const { allocation: alloc2InProd } = alloc2.startProduction({
        request: inProdRequest,
        actorId: '22',
        actorWorkshopId: '202',
        expectedVersion: 1,
        now: baseNow,
      });

      // Admin handover rejects future actual_handover_at (actual_handover_at > now)
      expect(() =>
        alloc2InProd.recordAdminHandover({
          request: inProdRequest,
          adminId: '999',
          expectedVersion: 2,
          reason: 'Chủ xưởng nhờ cập nhật',
          evidence: 'Phiếu xuất kho #02',
          actualHandoverAt: new Date(baseNow.getTime() + 60_000),
          now: baseNow,
        }),
      ).toThrow(DeadlineViolationError);

      const { allocation: alloc2HandedOver } = alloc2InProd.recordAdminHandover({
        request: inProdRequest,
        adminId: '999',
        expectedVersion: 2,
        reason: 'Chủ xưởng nhờ cập nhật',
        evidence: 'Phiếu xuất kho #02',
        actualHandoverAt: baseNow,
        now: baseNow,
      });
      expect(alloc2HandedOver.status).toBe('handed_over');
      expect(alloc2HandedOver.admin_handed_over).toBe(true);

      // Now all allocations are handed_over -> Buyer confirms delivered
      const { request: deliveredRequest } = inProdRequest.confirmDelivered({
        actorId: '10',
        actorRole: 'buyer',
        expectedVersion: inProdRequest.version,
        allocationStatuses: [alloc1HandedOver.status, alloc2HandedOver.status],
        now: baseNow,
      });
      expect(deliveredRequest.status).toBe('delivered');

      // Delivered request can be copied into a fresh draft without deadlines/history
      const { request: copiedDraft } = deliveredRequest.copyAsDraft({
        newId: '101',
        buyerId: '10',
        now: baseNow,
      });
      expect(copiedDraft.status).toBe('draft_request');
      expect(copiedDraft.version).toBe(1);
      expect(copiedDraft.bidding_deadline).toBeNull();
      expect(copiedDraft.delivery_deadline).toBeNull();
      expect(copiedDraft.spec).toBe(deliveredRequest.spec);
    });
  });
});
