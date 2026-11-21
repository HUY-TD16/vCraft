import {
  DeadlineViolationError,
  InvalidTradingInputError,
  TRADING_INVARIANTS,
} from '../errors/trading-domain.errors';

export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function ensureValidDate(date: Date, fieldName: string): Date {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new InvalidTradingInputError(`${fieldName} must be a valid Date.`, {
      field: fieldName,
    });
  }
  return new Date(date.getTime());
}

export class RequestDeadlines {
  readonly biddingDeadline: Date;
  readonly deliveryDeadline: Date;

  private constructor(biddingDeadline: Date, deliveryDeadline: Date) {
    this.biddingDeadline = biddingDeadline;
    this.deliveryDeadline = deliveryDeadline;
    Object.freeze(this);
  }

  /**
   * Reconstructs stored deadlines without checking `now`, while enforcing the 24-hour gap.
   */
  static fromPersisted(biddingDeadline: Date, deliveryDeadline: Date): RequestDeadlines {
    const bidding = ensureValidDate(biddingDeadline, 'bidding_deadline');
    const delivery = ensureValidDate(deliveryDeadline, 'delivery_deadline');

    if (delivery.getTime() <= bidding.getTime() + TWENTY_FOUR_HOURS_MS) {
      throw new DeadlineViolationError(
        'delivery_deadline must be strictly greater than bidding_deadline + 24 hours.',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          field: 'delivery_deadline',
        },
      );
    }

    return new RequestDeadlines(bidding, delivery);
  }

  /**
   * Validates INV-02 when sending a QuoteRequest (`now < bidding_deadline < delivery_deadline`
   * and `delivery_deadline > bidding_deadline + 24h`).
   */
  static validateForSend(
    biddingDeadline: Date,
    deliveryDeadline: Date,
    now: Date,
  ): RequestDeadlines {
    const current = ensureValidDate(now, 'now');
    const bidding = ensureValidDate(biddingDeadline, 'bidding_deadline');
    const delivery = ensureValidDate(deliveryDeadline, 'delivery_deadline');

    if (bidding.getTime() <= current.getTime()) {
      throw new DeadlineViolationError(
        'bidding_deadline must be strictly in the future (now < bidding_deadline).',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          field: 'bidding_deadline',
        },
      );
    }

    if (delivery.getTime() <= bidding.getTime() + TWENTY_FOUR_HOURS_MS) {
      throw new DeadlineViolationError(
        'delivery_deadline must be strictly greater than bidding_deadline + 24 hours.',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          field: 'delivery_deadline',
        },
      );
    }

    return new RequestDeadlines(bidding, delivery);
  }
}

export interface QuoteDeadlineInput {
  readonly bidAcceptDeadline: Date;
  readonly committedDeliveryAt: Date;
  readonly requestBiddingDeadline: Date;
  readonly requestDeliveryDeadline: Date;
  readonly now: Date;
}

export class QuoteDeadlines {
  readonly bidAcceptDeadline: Date;
  readonly committedDeliveryAt: Date;

  private constructor(bidAcceptDeadline: Date, committedDeliveryAt: Date) {
    this.bidAcceptDeadline = bidAcceptDeadline;
    this.committedDeliveryAt = committedDeliveryAt;
    Object.freeze(this);
  }

  static fromPersisted(bidAcceptDeadline: Date, committedDeliveryAt: Date): QuoteDeadlines {
    const accept = ensureValidDate(bidAcceptDeadline, 'bid_accept_deadline');
    const committed = ensureValidDate(committedDeliveryAt, 'committed_delivery_at');

    if (accept.getTime() >= committed.getTime()) {
      throw new DeadlineViolationError(
        'bid_accept_deadline must be strictly earlier than committed_delivery_at.',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          field: 'bid_accept_deadline',
        },
      );
    }

    return new QuoteDeadlines(accept, committed);
  }

  /**
   * Validates INV-02 when submitting, updating, or resubmitting a Quote:
   * - `now < bid_accept_deadline < committed_delivery_at <= request.delivery_deadline`
   * - `bid_accept_deadline >= request.bidding_deadline + 24h`
   */
  static validateForSubmission(input: QuoteDeadlineInput): QuoteDeadlines {
    const now = ensureValidDate(input.now, 'now');
    const accept = ensureValidDate(input.bidAcceptDeadline, 'bid_accept_deadline');
    const committed = ensureValidDate(input.committedDeliveryAt, 'committed_delivery_at');
    const reqBidding = ensureValidDate(input.requestBiddingDeadline, 'request.bidding_deadline');
    const reqDelivery = ensureValidDate(input.requestDeliveryDeadline, 'request.delivery_deadline');

    if (accept.getTime() <= now.getTime()) {
      throw new DeadlineViolationError(
        'bid_accept_deadline must be strictly in the future (now < bid_accept_deadline).',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          field: 'bid_accept_deadline',
        },
      );
    }

    if (accept.getTime() < reqBidding.getTime() + TWENTY_FOUR_HOURS_MS) {
      throw new DeadlineViolationError(
        'bid_accept_deadline must be at least 24 hours after request.bidding_deadline.',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          field: 'bid_accept_deadline',
        },
      );
    }

    if (committed.getTime() <= accept.getTime()) {
      throw new DeadlineViolationError(
        'committed_delivery_at must be strictly after bid_accept_deadline.',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          field: 'committed_delivery_at',
        },
      );
    }

    if (committed.getTime() > reqDelivery.getTime()) {
      throw new DeadlineViolationError(
        'committed_delivery_at cannot exceed request.delivery_deadline.',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          field: 'committed_delivery_at',
        },
      );
    }

    return new QuoteDeadlines(accept, committed);
  }
}
