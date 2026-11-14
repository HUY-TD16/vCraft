import {
  BiddingClosedError,
  DeadlineViolationError,
  InsufficientCapacityError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  QuoteExpiredError,
  TRADING_INVARIANTS,
  WorkshopSuspendedError,
} from '../errors/trading-domain.errors';
import {
  EntityId,
  type IneligibleQuoteReason,
  Quantity,
  QuoteDeadlines,
  type QuoteStatus,
  UnitPrice,
  Version,
} from '../value-objects';
import {
  type QuoteRequest,
  type QuoteSnapshotData,
  type RecipientResponseRecord,
  type RequestRecipient,
} from './quote-request.entity';

export interface QuoteProps {
  readonly id: string;
  readonly request_id: string;
  readonly workshop_id: string;
  readonly unit_price: number;
  readonly max_quantity: number;
  readonly bid_accept_deadline: Date;
  readonly committed_delivery_at: Date;
  readonly status: QuoteStatus;
  readonly version: number;
  readonly withdraw_reason: string | null;
  readonly withdrawn_by: string | null;
  readonly withdrawn_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface QuoteEligibilityEvaluation {
  readonly is_eligible: boolean;
  readonly ineligible_reasons: readonly IneligibleQuoteReason[];
}

export class Quote {
  readonly id: string;
  readonly request_id: string;
  readonly workshop_id: string;
  readonly unit_price: number;
  readonly max_quantity: number;
  readonly bid_accept_deadline: Date;
  readonly committed_delivery_at: Date;
  readonly status: QuoteStatus;
  readonly version: number;
  readonly withdraw_reason: string | null;
  readonly withdrawn_by: string | null;
  readonly withdrawn_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;

  private constructor(props: QuoteProps) {
    this.id = EntityId.of(props.id, 'quote.id').value;
    this.request_id = EntityId.of(props.request_id, 'quote.request_id').value;
    this.workshop_id = EntityId.of(props.workshop_id, 'quote.workshop_id').value;
    this.unit_price = UnitPrice.of(props.unit_price, 'quote.unit_price').value;
    this.max_quantity = Quantity.of(props.max_quantity, 'quote.max_quantity').value;

    const deadlines = QuoteDeadlines.fromPersisted(
      props.bid_accept_deadline,
      props.committed_delivery_at,
    );
    this.bid_accept_deadline = deadlines.bidAcceptDeadline;
    this.committed_delivery_at = deadlines.committedDeliveryAt;
    this.status = props.status;
    this.version = Version.of(props.version, 'quote.version').value;
    this.withdraw_reason = props.withdraw_reason;
    this.withdrawn_by =
      props.withdrawn_by !== null
        ? EntityId.of(props.withdrawn_by, 'quote.withdrawn_by').value
        : null;
    this.withdrawn_at = props.withdrawn_at ? new Date(props.withdrawn_at.getTime()) : null;
    this.created_at = new Date(props.created_at.getTime());
    this.updated_at = new Date(props.updated_at.getTime());

    this.validateInternalInvariants();
    Object.freeze(this);
  }

  private validateInternalInvariants(): void {
    if (this.status === 'withdrawn') {
      const reasonValid =
        typeof this.withdraw_reason === 'string' &&
        this.withdraw_reason.trim().length > 0;
      if (!reasonValid || this.withdrawn_by === null || this.withdrawn_at === null) {
        throw new InvalidTradingInputError(
          'Withdrawn Quote must have non-empty withdraw_reason, withdrawn_by, and withdrawn_at.',
          {
            invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
            entity: 'Quote',
          },
        );
      }
    }
  }

  static reconstitute(props: QuoteProps): Quote {
    return new Quote(props);
  }

  toSnapshot(): QuoteSnapshotData {
    return Object.freeze({
      unit_price: this.unit_price,
      max_quantity: this.max_quantity,
      bid_accept_deadline: new Date(this.bid_accept_deadline.getTime()),
      committed_delivery_at: new Date(this.committed_delivery_at.getTime()),
      status: this.status,
      version: this.version,
    });
  }

  assertVersionMatches(expectedVersion: number): void {
    Version.of(this.version).assertMatches(expectedVersion, 'Quote');
  }

  static submitNew(input: {
    readonly id: string;
    readonly request: QuoteRequest;
    readonly recipient: RequestRecipient;
    readonly actorId: string;
    readonly workshopIsActive: boolean;
    readonly unitPrice: number;
    readonly maxQuantity: number;
    readonly bidAcceptDeadline: Date;
    readonly committedDeliveryAt: Date;
    readonly now: Date;
  }): {
    readonly quote: Quote;
    readonly recipient: RequestRecipient;
    readonly recipientHistory: RecipientResponseRecord;
  } {
    if (!input.workshopIsActive) {
      throw new WorkshopSuspendedError('Suspended workshop cannot submit a quote.', {
        invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
        entity: 'Quote',
      });
    }

    input.request.assertNotCancelled();
    if (input.request.isAcceptedOrBeyond()) {
      throw new InvalidStateTransitionError(
        'Cannot submit a quote after QuoteRequest has already been accepted.',
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'Quote',
        },
      );
    }

    if (!input.request.isBiddingOpenAt(input.now)) {
      throw new BiddingClosedError('Cannot submit a quote because bidding is closed.', {
        invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
        entity: 'Quote',
      });
    }

    if (
      input.request.quantity === null ||
      input.request.bidding_deadline === null ||
      input.request.delivery_deadline === null
    ) {
      throw new InvalidStateTransitionError(
        'QuoteRequest is missing required sent fields for quoting.',
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }

    // INV-03: max_quantity <= request.quantity
    Quantity.of(input.maxQuantity, 'max_quantity').assertNotExceedingRequestQuantity(
      input.request.quantity,
    );

    // INV-02: Validate 24h buffer and chronological ordering
    const deadlines = QuoteDeadlines.validateForSubmission({
      bidAcceptDeadline: input.bidAcceptDeadline,
      committedDeliveryAt: input.committedDeliveryAt,
      requestBiddingDeadline: input.request.bidding_deadline,
      requestDeliveryDeadline: input.request.delivery_deadline,
      now: input.now,
    });

    const quote = new Quote({
      id: input.id,
      request_id: input.request.id,
      workshop_id: input.recipient.workshop_id,
      unit_price: input.unitPrice,
      max_quantity: input.maxQuantity,
      bid_accept_deadline: deadlines.bidAcceptDeadline,
      committed_delivery_at: deadlines.committedDeliveryAt,
      status: 'active',
      version: 1,
      withdraw_reason: null,
      withdrawn_by: null,
      withdrawn_at: null,
      created_at: input.now,
      updated_at: input.now,
    });

    const { recipient: updatedRecipient, history } = input.recipient.markQuoted({
      actorId: input.actorId,
      quoteId: quote.id,
      quoteSnapshot: quote.toSnapshot(),
      now: input.now,
    });

    return {
      quote,
      recipient: updatedRecipient,
      recipientHistory: history,
    };
  }

  updateOrResubmit(input: {
    readonly request: QuoteRequest;
    readonly recipient: RequestRecipient;
    readonly actorId: string;
    readonly expectedQuoteVersion: number;
    readonly workshopIsActive: boolean;
    readonly unitPrice: number;
    readonly maxQuantity: number;
    readonly bidAcceptDeadline: Date;
    readonly committedDeliveryAt: Date;
    readonly now: Date;
  }): {
    readonly quote: Quote;
    readonly recipient: RequestRecipient;
    readonly recipientHistory: RecipientResponseRecord;
  } {
    this.assertVersionMatches(input.expectedQuoteVersion);

    if (!input.workshopIsActive) {
      throw new WorkshopSuspendedError(
        'Suspended workshop cannot update or resubmit a quote.',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          entity: 'Quote',
        },
      );
    }

    input.request.assertNotCancelled();
    if (input.request.isAcceptedOrBeyond() || this.status === 'accepted') {
      throw new InvalidStateTransitionError(
        'Accepted quote or accepted request cannot be modified.',
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'Quote',
        },
      );
    }

    if (!input.request.isBiddingOpenAt(input.now)) {
      throw new BiddingClosedError(
        'Cannot update or resubmit a quote after bidding is closed.',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          entity: 'Quote',
        },
      );
    }

    if (
      input.request.quantity === null ||
      input.request.bidding_deadline === null ||
      input.request.delivery_deadline === null
    ) {
      throw new InvalidStateTransitionError(
        'QuoteRequest is missing required sent fields.',
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }

    Quantity.of(input.maxQuantity, 'max_quantity').assertNotExceedingRequestQuantity(
      input.request.quantity,
    );

    const deadlines = QuoteDeadlines.validateForSubmission({
      bidAcceptDeadline: input.bidAcceptDeadline,
      committedDeliveryAt: input.committedDeliveryAt,
      requestBiddingDeadline: input.request.bidding_deadline,
      requestDeliveryDeadline: input.request.delivery_deadline,
      now: input.now,
    });

    const updatedQuote = new Quote({
      ...this,
      unit_price: input.unitPrice,
      max_quantity: input.maxQuantity,
      bid_accept_deadline: deadlines.bidAcceptDeadline,
      committed_delivery_at: deadlines.committedDeliveryAt,
      status: 'active',
      version: Version.of(this.version).next().value,
      withdraw_reason: null,
      withdrawn_by: null,
      withdrawn_at: null,
      updated_at: input.now,
    });

    const { recipient: updatedRecipient, history } = input.recipient.markQuoted({
      actorId: input.actorId,
      quoteId: updatedQuote.id,
      quoteSnapshot: updatedQuote.toSnapshot(),
      now: input.now,
    });

    return {
      quote: updatedQuote,
      recipient: updatedRecipient,
      recipientHistory: history,
    };
  }

  withdraw(input: {
    readonly request: QuoteRequest;
    readonly recipient: RequestRecipient;
    readonly actorId: string;
    readonly expectedQuoteVersion: number;
    readonly withdrawReason: string;
    readonly now: Date;
  }): {
    readonly quote: Quote;
    readonly recipient: RequestRecipient;
    readonly recipientHistory: RecipientResponseRecord;
  } {
    this.assertVersionMatches(input.expectedQuoteVersion);
    input.request.assertNotCancelled();

    if (input.request.isAcceptedOrBeyond() || this.status !== 'active') {
      throw new InvalidStateTransitionError(
        `Only active quotes on an unaccepted QuoteRequest can be withdrawn (current status: "${this.status}").`,
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'Quote',
        },
      );
    }

    const trimmedReason = input.withdrawReason.trim();
    if (trimmedReason.length === 0) {
      throw new InvalidTradingInputError('withdraw_reason is required when withdrawing a quote.', {
        field: 'withdraw_reason',
      });
    }

    const actor = EntityId.of(input.actorId, 'actorId').value;
    const updatedQuote = new Quote({
      ...this,
      status: 'withdrawn',
      withdraw_reason: trimmedReason,
      withdrawn_by: actor,
      withdrawn_at: new Date(input.now.getTime()),
      version: Version.of(this.version).next().value,
      updated_at: input.now,
    });

    const { recipient: updatedRecipient, history } = input.recipient.markWithdrawn({
      actorId: actor,
      quoteId: updatedQuote.id,
      reason: trimmedReason,
      quoteSnapshot: updatedQuote.toSnapshot(),
      now: input.now,
    });

    return {
      quote: updatedQuote,
      recipient: updatedRecipient,
      recipientHistory: history,
    };
  }

  assertEligibleForAcceptance(input: {
    readonly request: QuoteRequest;
    readonly workshopIsActive: boolean;
    readonly now: Date;
  }): void {
    input.request.assertNotCancelled();
    if (input.request.status !== 'artisans_bidding') {
      throw new InvalidStateTransitionError(
        `Quotes can only be accepted when QuoteRequest status is "artisans_bidding" (current: "${input.request.status}").`,
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }

    if (this.status !== 'active') {
      throw new InvalidStateTransitionError(
        `Cannot accept Quote in "${this.status}" status.`,
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'Quote',
        },
      );
    }

    if (!input.workshopIsActive) {
      throw new WorkshopSuspendedError(
        'Cannot accept Quote because the workshop is currently suspended.',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          entity: 'Quote',
        },
      );
    }

    if (input.now.getTime() >= this.bid_accept_deadline.getTime()) {
      throw new QuoteExpiredError(
        'Cannot accept Quote because bid_accept_deadline has expired.',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          entity: 'Quote',
        },
      );
    }

    if (
      input.request.delivery_deadline !== null &&
      this.committed_delivery_at.getTime() > input.request.delivery_deadline.getTime()
    ) {
      throw new DeadlineViolationError(
        'Quote committed_delivery_at exceeds request.delivery_deadline.',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          entity: 'Quote',
        },
      );
    }
  }

  acceptDirect(input: {
    readonly request: QuoteRequest;
    readonly recipientId: string;
    readonly actorId: string;
    readonly expectedQuoteVersion: number;
    readonly workshopIsActive: boolean;
    readonly now: Date;
  }): { readonly quote: Quote; readonly recipientHistory: RecipientResponseRecord } {
    this.assertVersionMatches(input.expectedQuoteVersion);
    this.assertEligibleForAcceptance({
      request: input.request,
      workshopIsActive: input.workshopIsActive,
      now: input.now,
    });

    if (input.request.quantity === null) {
      throw new InvalidStateTransitionError('QuoteRequest quantity is missing.', {
        invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
        entity: 'QuoteRequest',
      });
    }

    // INV-03: Direct accept requires 100% capacity
    Quantity.of(this.max_quantity, 'max_quantity').assertCanSatisfyDirectAccept(
      input.request.quantity,
    );

    const updatedQuote = new Quote({
      ...this,
      status: 'accepted',
      version: Version.of(this.version).next().value,
      updated_at: input.now,
    });

    const recipientHistory: RecipientResponseRecord = Object.freeze({
      recipient_id: EntityId.of(input.recipientId, 'recipientId').value,
      quote_id: updatedQuote.id,
      event_type: 'quote_accepted',
      prev_status: 'quoted',
      new_status: 'quoted',
      reason: null,
      quote_snapshot: updatedQuote.toSnapshot(),
      performed_by: EntityId.of(input.actorId, 'actorId').value,
      created_at: new Date(input.now.getTime()),
    });

    return { quote: updatedQuote, recipientHistory };
  }

  evaluateEligibility(context: {
    readonly request: QuoteRequest;
    readonly workshopIsActive: boolean;
    readonly now: Date;
  }): QuoteEligibilityEvaluation {
    const reasons: IneligibleQuoteReason[] = [];

    if (context.request.isCancelled()) {
      reasons.push('REQUEST_CANCELLED');
    } else if (context.request.isAcceptedOrBeyond()) {
      reasons.push('REQUEST_ACCEPTED');
    }

    if (this.status === 'withdrawn') {
      reasons.push('QUOTE_WITHDRAWN');
    }

    if (!context.workshopIsActive) {
      reasons.push('WORKSHOP_SUSPENDED');
    }

    if (
      this.status !== 'accepted' &&
      context.now.getTime() >= this.bid_accept_deadline.getTime()
    ) {
      reasons.push('QUOTE_EXPIRED');
    }

    const hasValidDeliveryDeadline =
      context.request.delivery_deadline !== null &&
      this.committed_delivery_at.getTime() <=
        context.request.delivery_deadline.getTime();

    const isEligible =
      reasons.length === 0 &&
      this.status === 'active' &&
      hasValidDeliveryDeadline;

    return Object.freeze({
      is_eligible: isEligible,
      ineligible_reasons: Object.freeze(reasons),
    });
  }
}
