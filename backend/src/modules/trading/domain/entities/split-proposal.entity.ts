import {
  ConcurrencyConflictError,
  InsufficientCapacityError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  TRADING_INVARIANTS,
} from '../errors/trading-domain.errors';
import {
  EntityId,
  type ProposalExpectation,
  ProposalExpectationVO,
  Quantity,
  type SplitProposalExpireReason,
  type SplitProposalStatus,
  UnitPrice,
  Version,
} from '../value-objects';
import { type QuoteRequest } from './quote-request.entity';
import { type Quote } from './quote.entity';

export interface SplitProposalItemProps {
  readonly id: string;
  readonly proposal_id: string;
  readonly request_id: string;
  readonly workshop_id: string;
  readonly quote_id: string;
  readonly quote_version: number;
  readonly allocated_quantity: number;
}

export class SplitProposalItem {
  readonly id: string;
  readonly proposal_id: string;
  readonly request_id: string;
  readonly workshop_id: string;
  readonly quote_id: string;
  readonly quote_version: number;
  readonly allocated_quantity: number;

  private constructor(props: SplitProposalItemProps) {
    this.id = EntityId.of(props.id, 'proposalItem.id').value;
    this.proposal_id = EntityId.of(props.proposal_id, 'proposalItem.proposal_id').value;
    this.request_id = EntityId.of(props.request_id, 'proposalItem.request_id').value;
    this.workshop_id = EntityId.of(props.workshop_id, 'proposalItem.workshop_id').value;
    this.quote_id = EntityId.of(props.quote_id, 'proposalItem.quote_id').value;
    this.quote_version = Version.of(
      props.quote_version,
      'proposalItem.quote_version',
    ).value;
    this.allocated_quantity = Quantity.of(
      props.allocated_quantity,
      'proposalItem.allocated_quantity',
    ).value;
    Object.freeze(this);
  }

  static reconstitute(props: SplitProposalItemProps): SplitProposalItem {
    return new SplitProposalItem(props);
  }

  calculateLineTotal(unitPrice: number): string {
    return UnitPrice.of(unitPrice, 'unit_price').calculateLineTotal(this.allocated_quantity);
  }
}

export interface SplitProposalProps {
  readonly id: string;
  readonly request_id: string;
  readonly created_by: string;
  readonly status: SplitProposalStatus;
  readonly version: number;
  readonly expired_at: Date | null;
  readonly expire_reason: SplitProposalExpireReason | null;
  readonly reject_reason: string | null;
  readonly rejected_by: string | null;
  readonly rejected_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly items: readonly SplitProposalItem[];
}

export interface ProposedAllocationCandidate {
  readonly itemId: string;
  readonly workshop_id: string;
  readonly quote_id: string;
  readonly expected_quote_version: number;
  readonly allocated_quantity: number;
  readonly quote: Quote;
  readonly workshopIsActive: boolean;
}

export class SplitProposal {
  readonly id: string;
  readonly request_id: string;
  readonly created_by: string;
  readonly status: SplitProposalStatus;
  readonly version: number;
  readonly expired_at: Date | null;
  readonly expire_reason: SplitProposalExpireReason | null;
  readonly reject_reason: string | null;
  readonly rejected_by: string | null;
  readonly rejected_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly items: readonly SplitProposalItem[];

  private constructor(props: SplitProposalProps) {
    this.id = EntityId.of(props.id, 'proposal.id').value;
    this.request_id = EntityId.of(props.request_id, 'proposal.request_id').value;
    this.created_by = EntityId.of(props.created_by, 'proposal.created_by').value;
    this.status = props.status;
    this.version = Version.of(props.version, 'proposal.version').value;
    this.expired_at = props.expired_at ? new Date(props.expired_at.getTime()) : null;
    this.expire_reason = props.expire_reason;
    this.reject_reason = props.reject_reason;
    this.rejected_by =
      props.rejected_by !== null
        ? EntityId.of(props.rejected_by, 'proposal.rejected_by').value
        : null;
    this.rejected_at = props.rejected_at ? new Date(props.rejected_at.getTime()) : null;
    this.created_at = new Date(props.created_at.getTime());
    this.updated_at = new Date(props.updated_at.getTime());
    this.items = Object.freeze([...props.items]);

    this.validateInternalInvariants();
    Object.freeze(this);
  }

  private validateInternalInvariants(): void {
    if (this.items.length < 2) {
      throw new InsufficientCapacityError(
        'SplitProposal must allocate work across at least 2 distinct workshops.',
        {
          invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
          entity: 'SplitProposal',
        },
      );
    }

    const workshopIds = new Set<string>();
    const quoteIds = new Set<string>();
    for (const item of this.items) {
      if (item.request_id !== this.request_id || item.proposal_id !== this.id) {
        throw new InvalidTradingInputError(
          'SplitProposalItem request_id and proposal_id must match parent SplitProposal.',
          {
            invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
            entity: 'SplitProposalItem',
          },
        );
      }
      if (workshopIds.has(item.workshop_id)) {
        throw new InvalidTradingInputError(
          `Duplicate workshop_id (${item.workshop_id}) in SplitProposal items.`,
          {
            invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
            field: 'workshop_id',
          },
        );
      }
      if (quoteIds.has(item.quote_id)) {
        throw new InvalidTradingInputError(
          `Duplicate quote_id (${item.quote_id}) in SplitProposal items.`,
          {
            invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
            field: 'quote_id',
          },
        );
      }
      workshopIds.add(item.workshop_id);
      quoteIds.add(item.quote_id);
    }

    if (this.status === 'expired') {
      if (this.expired_at === null || this.expire_reason === null) {
        throw new InvalidStateTransitionError(
          'Expired SplitProposal must specify both expired_at and expire_reason.',
          {
            invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
            entity: 'SplitProposal',
          },
        );
      }
    } else if (this.expired_at !== null || this.expire_reason !== null) {
      throw new InvalidStateTransitionError(
        'Non-expired SplitProposal cannot have expired_at or expire_reason.',
        {
          invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
          entity: 'SplitProposal',
        },
      );
    }
  }

  static reconstitute(props: SplitProposalProps): SplitProposal {
    return new SplitProposal(props);
  }

  assertVersionMatches(expectedVersion: number): void {
    Version.of(this.version).assertMatches(expectedVersion, 'SplitProposal');
  }

  static propose(input: {
    readonly id: string;
    readonly request: QuoteRequest;
    readonly expectedRequestVersion: number;
    readonly adminId: string;
    readonly proposalExpectation: ProposalExpectation;
    readonly currentProposedProposal: SplitProposal | null;
    readonly candidates: readonly ProposedAllocationCandidate[];
    readonly now: Date;
  }): {
    readonly proposal: SplitProposal;
    readonly replacedProposal: SplitProposal | null;
  } {
    input.request.assertNotCancelled();
    input.request.assertVersionMatches(input.expectedRequestVersion);

    if (input.request.status !== 'artisans_bidding') {
      throw new InvalidStateTransitionError(
        `SplitProposal can only be created when QuoteRequest is in "artisans_bidding" status (current: "${input.request.status}").`,
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }

    if (input.request.split_requested_at === null) {
      throw new InvalidStateTransitionError(
        'SplitProposal cannot be created before Buyer has requested split support.',
        {
          invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
          entity: 'QuoteRequest',
        },
      );
    }

    if (input.request.isBiddingOpenAt(input.now)) {
      throw new InvalidStateTransitionError(
        'SplitProposal can only be created after bidding is closed.',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          entity: 'QuoteRequest',
        },
      );
    }

    // INV-05: Validate ProposalExpectation pair (id, version)
    ProposalExpectationVO.of(input.proposalExpectation).assertMatchesCurrent(
      input.currentProposedProposal
        ? {
            id: input.currentProposedProposal.id,
            version: input.currentProposedProposal.version,
          }
        : null,
    );

    if (input.candidates.length < 2) {
      throw new InsufficientCapacityError(
        'SplitProposal requires at least 2 distinct workshops.',
        {
          invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
          entity: 'SplitProposal',
        },
      );
    }

    const proposalId = EntityId.of(input.id, 'proposal.id').value;
    const seenWorkshops = new Set<string>();
    const seenQuotes = new Set<string>();
    const items: SplitProposalItem[] = [];
    const allocatedQuantities: Quantity[] = [];

    for (const candidate of input.candidates) {
      const workshopId = EntityId.of(candidate.workshop_id, 'workshop_id').value;
      const quoteId = EntityId.of(candidate.quote_id, 'quote_id').value;

      if (seenWorkshops.has(workshopId)) {
        throw new InvalidTradingInputError(
          `Duplicate workshop_id (${workshopId}) in SplitProposal items.`,
          {
            invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
            field: 'workshop_id',
          },
        );
      }
      if (seenQuotes.has(quoteId)) {
        throw new InvalidTradingInputError(
          `Duplicate quote_id (${quoteId}) in SplitProposal items.`,
          {
            invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
            field: 'quote_id',
          },
        );
      }
      seenWorkshops.add(workshopId);
      seenQuotes.add(quoteId);

      if (
        candidate.quote.id !== quoteId ||
        candidate.quote.workshop_id !== workshopId ||
        candidate.quote.request_id !== input.request.id
      ) {
        throw new InvalidTradingInputError(
          'Candidate Quote does not belong to the specified request_id and workshop_id.',
          {
            invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
            entity: 'SplitProposalItem',
          },
        );
      }

      // INV-05: Quote version must match expected_quote_version
      candidate.quote.assertVersionMatches(candidate.expected_quote_version);

      // INV-02: Quote must be active, workshop active, not expired
      candidate.quote.assertEligibleForAcceptance({
        request: input.request,
        workshopIsActive: candidate.workshopIsActive,
        now: input.now,
      });

      const allocated = Quantity.of(candidate.allocated_quantity, 'allocated_quantity');
      if (allocated.value > candidate.quote.max_quantity) {
        throw new InsufficientCapacityError(
          `Allocated quantity (${allocated.value}) for workshop ${workshopId} exceeds quote max_quantity (${candidate.quote.max_quantity}).`,
          {
            invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
            field: 'allocated_quantity',
          },
        );
      }

      allocatedQuantities.push(allocated);
      items.push(
        SplitProposalItem.reconstitute({
          id: candidate.itemId,
          proposal_id: proposalId,
          request_id: input.request.id,
          workshop_id: workshopId,
          quote_id: quoteId,
          quote_version: candidate.quote.version,
          allocated_quantity: allocated.value,
        }),
      );
    }

    if (input.request.quantity === null) {
      throw new InvalidStateTransitionError('QuoteRequest quantity is missing.', {
        invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
        entity: 'QuoteRequest',
      });
    }

    // INV-03: SUM(allocated_quantity) must equal request.quantity
    const totalAllocated = Quantity.sumAsBigInt(allocatedQuantities);
    const requiredTotal = BigInt(input.request.quantity);
    if (totalAllocated !== requiredTotal) {
      throw new InsufficientCapacityError(
        `Sum of allocated_quantity (${totalAllocated.toString()}) must equal request.quantity (${requiredTotal.toString()}).`,
        {
          invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
          entity: 'SplitProposal',
        },
      );
    }

    const replacedProposal = input.currentProposedProposal
      ? input.currentProposedProposal.expire('replaced', input.now)
      : null;

    const proposal = new SplitProposal({
      id: proposalId,
      request_id: input.request.id,
      created_by: input.adminId,
      status: 'proposed',
      version: 1,
      expired_at: null,
      expire_reason: null,
      reject_reason: null,
      rejected_by: null,
      rejected_at: null,
      created_at: input.now,
      updated_at: input.now,
      items,
    });

    return { proposal, replacedProposal };
  }

  accept(input: {
    readonly request: QuoteRequest;
    readonly expectedProposalVersion: number;
    readonly quotesById: ReadonlyMap<
      string,
      { readonly quote: Quote; readonly workshopIsActive: boolean }
    >;
    readonly now: Date;
  }): SplitProposal {
    this.assertVersionMatches(input.expectedProposalVersion);

    if (this.status !== 'proposed') {
      throw new InvalidStateTransitionError(
        `Only a "proposed" SplitProposal can be accepted (current: "${this.status}").`,
        {
          invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
          entity: 'SplitProposal',
        },
      );
    }

    for (const item of this.items) {
      const entry = input.quotesById.get(item.quote_id);
      if (!entry) {
        throw new InvalidStateTransitionError(
          `Quote ${item.quote_id} referenced by SplitProposal was not found.`,
          {
            invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
            entity: 'SplitProposalItem',
          },
        );
      }

      if (entry.quote.version !== item.quote_version) {
        throw new ConcurrencyConflictError(
          `Quote ${item.quote_id} version changed since SplitProposal creation (expected ${item.quote_version}, actual ${entry.quote.version}).`,
          {
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
            entity: 'Quote',
          },
        );
      }

      entry.quote.assertEligibleForAcceptance({
        request: input.request,
        workshopIsActive: entry.workshopIsActive,
        now: input.now,
      });

      if (item.allocated_quantity > entry.quote.max_quantity) {
        throw new InsufficientCapacityError(
          `Allocated quantity (${item.allocated_quantity}) exceeds Quote ${item.quote_id} max_quantity (${entry.quote.max_quantity}).`,
          {
            invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
            entity: 'SplitProposalItem',
          },
        );
      }
    }

    return new SplitProposal({
      ...this,
      status: 'accepted',
      version: Version.of(this.version).next().value,
      updated_at: input.now,
    });
  }

  rejectByBuyer(input: {
    readonly request: QuoteRequest;
    readonly buyerId: string;
    readonly expectedRequestVersion?: number;
    readonly expectedProposalVersion: number;
    readonly rejectReason: string;
    readonly now: Date;
  }): SplitProposal {
    input.request.assertOwner(input.buyerId);
    input.request.assertNotCancelled();
    if (input.request.isAcceptedOrBeyond()) {
      throw new InvalidStateTransitionError(
        'Cannot reject SplitProposal after QuoteRequest has already been accepted.',
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }
    if (input.expectedRequestVersion !== undefined) {
      input.request.assertVersionMatches(input.expectedRequestVersion);
    }
    this.assertVersionMatches(input.expectedProposalVersion);

    if (this.status !== 'proposed') {
      throw new InvalidStateTransitionError(
        `Only a "proposed" SplitProposal can be rejected (current: "${this.status}").`,
        {
          invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
          entity: 'SplitProposal',
        },
      );
    }

    const trimmedReason = input.rejectReason.trim();
    if (trimmedReason.length === 0) {
      throw new InvalidTradingInputError(
        'reject_reason is required when Buyer rejects a SplitProposal.',
        {
          invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
          field: 'reason',
        },
      );
    }
    const actor = EntityId.of(input.buyerId, 'buyerId').value;

    return new SplitProposal({
      ...this,
      status: 'expired',
      expired_at: new Date(input.now.getTime()),
      expire_reason: 'buyer_rejected',
      rejected_by: actor,
      rejected_at: new Date(input.now.getTime()),
      reject_reason: trimmedReason,
      version: Version.of(this.version).next().value,
      updated_at: input.now,
    });
  }

  expire(reason: SplitProposalExpireReason, now: Date): SplitProposal {
    if (this.status === 'accepted') {
      throw new InvalidStateTransitionError(
        'An accepted SplitProposal is immutable and cannot be expired.',
        {
          invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
          entity: 'SplitProposal',
        },
      );
    }

    if (this.status === 'expired') {
      throw new InvalidStateTransitionError(
        'SplitProposal is already expired and cannot transition again.',
        {
          invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
          entity: 'SplitProposal',
        },
      );
    }

    return new SplitProposal({
      ...this,
      status: 'expired',
      expired_at: new Date(now.getTime()),
      expire_reason: reason,
      version: Version.of(this.version).next().value,
      updated_at: now,
    });
  }

  computeDecisionDeadline(quoteAcceptDeadlinesByQuoteId: ReadonlyMap<string, Date>): Date {
    let earliest: Date | null = null;
    for (const item of this.items) {
      const deadline = quoteAcceptDeadlinesByQuoteId.get(item.quote_id);
      if (!deadline) {
        throw new InvalidTradingInputError(
          `Missing bid_accept_deadline for quote_id ${item.quote_id}.`,
          { field: 'decision_deadline' },
        );
      }
      if (earliest === null || deadline.getTime() < earliest.getTime()) {
        earliest = new Date(deadline.getTime());
      }
    }
    if (earliest === null) {
      throw new InvalidTradingInputError('Cannot compute decision_deadline for empty items.', {
        field: 'decision_deadline',
      });
    }
    return earliest;
  }

  computeTotalAmount(unitPricesByQuoteId: ReadonlyMap<string, number>): string {
    const lineTotals: string[] = [];
    for (const item of this.items) {
      const unitPrice = unitPricesByQuoteId.get(item.quote_id);
      if (unitPrice === undefined) {
        throw new InvalidTradingInputError(
          `Missing unit_price for quote_id ${item.quote_id}.`,
          { field: 'total_amount' },
        );
      }
      lineTotals.push(item.calculateLineTotal(unitPrice));
    }
    return UnitPrice.sumAmounts(lineTotals);
  }
}
