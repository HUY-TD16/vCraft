import {
  BiddingClosedError,
  InsufficientCapacityError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  NoEligibleWorkshopError,
  TradingPermissionDeniedError,
  TRADING_INVARIANTS,
} from '../errors/trading-domain.errors';
import {
  type AllocationStatus,
  type DeliveryMode,
  EntityId,
  Quantity,
  RecipientContact,
  type RecipientEventType,
  type RecipientResponseStatus,
  RequestDeadlines,
  type RequestStatus,
  type RequestUnit,
  type StatusLogEventType,
  Version,
} from '../value-objects';

export interface ContactEditRecord {
  readonly request_id: string;
  readonly edited_by: string;
  readonly prev_recipient_name: string;
  readonly prev_recipient_phone: string;
  readonly new_recipient_name: string;
  readonly new_recipient_phone: string;
  readonly edited_at: Date;
  readonly version: number;
}

export interface StatusLogRecord {
  readonly request_id: string;
  readonly event_type: StatusLogEventType;
  readonly prev_status: RequestStatus | null;
  readonly new_status: RequestStatus;
  readonly performed_by: string | null;
  readonly is_admin_action: boolean;
  readonly note: string | null;
  readonly evidence: string | null;
  readonly created_at: Date;
}

export interface QuoteSnapshotData {
  readonly unit_price: number;
  readonly max_quantity: number;
  readonly bid_accept_deadline: Date;
  readonly committed_delivery_at: Date;
  readonly status: 'active' | 'withdrawn' | 'accepted';
  readonly version: number;
}

export interface RecipientResponseRecord {
  readonly recipient_id: string;
  readonly quote_id: string | null;
  readonly event_type: RecipientEventType;
  readonly prev_status: RecipientResponseStatus;
  readonly new_status: RecipientResponseStatus;
  readonly reason: string | null;
  readonly quote_snapshot: QuoteSnapshotData | null;
  readonly performed_by: string;
  readonly created_at: Date;
}

export interface RequestRecipientProps {
  readonly id: string;
  readonly request_id: string;
  readonly workshop_id: string;
  readonly response_status: RecipientResponseStatus;
  readonly decline_reason: string | null;
  readonly responded_by: string | null;
  readonly responded_at: Date | null;
  readonly sent_at: Date;
  readonly version: number;
}

export class RequestRecipient {
  readonly id: string;
  readonly request_id: string;
  readonly workshop_id: string;
  readonly response_status: RecipientResponseStatus;
  readonly decline_reason: string | null;
  readonly responded_by: string | null;
  readonly responded_at: Date | null;
  readonly sent_at: Date;
  readonly version: number;

  private constructor(props: RequestRecipientProps) {
    this.id = EntityId.of(props.id, 'recipient.id').value;
    this.request_id = EntityId.of(props.request_id, 'recipient.request_id').value;
    this.workshop_id = EntityId.of(props.workshop_id, 'recipient.workshop_id').value;
    this.response_status = props.response_status;
    this.decline_reason = props.decline_reason;
    this.responded_by =
      props.responded_by !== null
        ? EntityId.of(props.responded_by, 'recipient.responded_by').value
        : null;
    this.responded_at = props.responded_at ? new Date(props.responded_at.getTime()) : null;
    this.sent_at = new Date(props.sent_at.getTime());
    this.version = Version.of(props.version, 'recipient.version').value;
    Object.freeze(this);
  }

  static reconstitute(props: RequestRecipientProps): RequestRecipient {
    return new RequestRecipient(props);
  }

  assertVersionMatches(expectedVersion: number): void {
    Version.of(this.version).assertMatches(expectedVersion, 'RequestRecipient');
  }

  decline(input: {
    readonly actorId: string;
    readonly expectedVersion: number;
    readonly reason?: string | null;
    readonly requestBiddingOpen: boolean;
    readonly requestAcceptedOrCancelled: boolean;
    readonly now: Date;
  }): { readonly recipient: RequestRecipient; readonly history: RecipientResponseRecord } {
    this.assertVersionMatches(input.expectedVersion);

    if (input.requestAcceptedOrCancelled) {
      throw new InvalidStateTransitionError(
        'Cannot decline invitation after request is accepted or cancelled.',
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'RequestRecipient',
        },
      );
    }

    if (!input.requestBiddingOpen) {
      throw new BiddingClosedError('Cannot decline invitation after bidding is closed.', {
        invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
        entity: 'RequestRecipient',
      });
    }

    if (this.response_status !== 'pending') {
      throw new InvalidStateTransitionError(
        `Only pending invitations can be declined (current: ${this.response_status}).`,
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'RequestRecipient',
        },
      );
    }

    const trimmedReason = input.reason?.trim() ?? null;
    const normalizedReason = trimmedReason && trimmedReason.length > 0 ? trimmedReason : null;
    const nextVersion = Version.of(this.version).next().value;

    const updated = new RequestRecipient({
      ...this,
      response_status: 'declined',
      decline_reason: normalizedReason,
      responded_by: EntityId.of(input.actorId, 'actorId').value,
      responded_at: new Date(input.now.getTime()),
      version: nextVersion,
    });

    const history: RecipientResponseRecord = Object.freeze({
      recipient_id: this.id,
      quote_id: null,
      event_type: 'declined',
      prev_status: this.response_status,
      new_status: 'declined',
      reason: normalizedReason,
      quote_snapshot: null,
      performed_by: updated.responded_by!,
      created_at: new Date(input.now.getTime()),
    });

    return { recipient: updated, history };
  }

  markQuoted(input: {
    readonly actorId: string;
    readonly quoteId: string;
    readonly quoteSnapshot: QuoteSnapshotData;
    readonly now: Date;
  }): { readonly recipient: RequestRecipient; readonly history: RecipientResponseRecord } {
    const eventType: RecipientEventType =
      this.response_status === 'withdrawn'
        ? 'quote_resubmitted'
        : this.response_status === 'quoted'
          ? 'quote_updated'
          : 'quote_submitted';

    const nextVersion = Version.of(this.version).next().value;
    const actor = EntityId.of(input.actorId, 'actorId').value;
    const updated = new RequestRecipient({
      ...this,
      response_status: 'quoted',
      decline_reason: null,
      responded_by: actor,
      responded_at: new Date(input.now.getTime()),
      version: nextVersion,
    });

    const history: RecipientResponseRecord = Object.freeze({
      recipient_id: this.id,
      quote_id: EntityId.of(input.quoteId, 'quoteId').value,
      event_type: eventType,
      prev_status: this.response_status,
      new_status: 'quoted',
      reason: null,
      quote_snapshot: Object.freeze({ ...input.quoteSnapshot }),
      performed_by: actor,
      created_at: new Date(input.now.getTime()),
    });

    return { recipient: updated, history };
  }

  markWithdrawn(input: {
    readonly actorId: string;
    readonly quoteId: string;
    readonly reason: string;
    readonly quoteSnapshot: QuoteSnapshotData;
    readonly now: Date;
  }): { readonly recipient: RequestRecipient; readonly history: RecipientResponseRecord } {
    if (this.response_status !== 'quoted') {
      throw new InvalidStateTransitionError(
        `Cannot mark recipient as withdrawn from status ${this.response_status}.`,
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'RequestRecipient',
        },
      );
    }

    const nextVersion = Version.of(this.version).next().value;
    const actor = EntityId.of(input.actorId, 'actorId').value;
    const updated = new RequestRecipient({
      ...this,
      response_status: 'withdrawn',
      responded_by: actor,
      responded_at: new Date(input.now.getTime()),
      version: nextVersion,
    });

    const history: RecipientResponseRecord = Object.freeze({
      recipient_id: this.id,
      quote_id: EntityId.of(input.quoteId, 'quoteId').value,
      event_type: 'quote_withdrawn',
      prev_status: this.response_status,
      new_status: 'withdrawn',
      reason: input.reason,
      quote_snapshot: Object.freeze({ ...input.quoteSnapshot }),
      performed_by: actor,
      created_at: new Date(input.now.getTime()),
    });

    return { recipient: updated, history };
  }
}

export interface QuoteRequestProps {
  readonly id: string;
  readonly buyer_id: string;
  readonly category_id: string | null;
  readonly spec: string | null;
  readonly quantity: number | null;
  readonly unit: RequestUnit | null;
  readonly unit_set_description: string | null;
  readonly status: RequestStatus;
  readonly delivery_mode: DeliveryMode | null;
  readonly delivery_region: string | null;
  readonly delivery_address: string | null;
  readonly recipient_name: string | null;
  readonly recipient_phone: string | null;
  readonly bidding_deadline: Date | null;
  readonly delivery_deadline: Date | null;
  readonly bidding_closed_at: Date | null;
  readonly version: number;
  readonly cancelled_at: Date | null;
  readonly cancelled_by: string | null;
  readonly cancel_reason: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface DraftQuoteRequestInput {
  readonly category_id?: string | null;
  readonly spec?: string | null;
  readonly quantity?: number | null;
  readonly unit?: RequestUnit | null;
  readonly unit_set_description?: string | null;
  readonly delivery_mode?: DeliveryMode | null;
  readonly delivery_region?: string | null;
  readonly delivery_address?: string | null;
  readonly recipient_name?: string | null;
  readonly recipient_phone?: string | null;
  readonly bidding_deadline?: Date | null;
  readonly delivery_deadline?: Date | null;
}

const ORDERED_REQUEST_STEPS: readonly RequestStatus[] = [
  'draft_request',
  'sent_to_artisans',
  'artisans_bidding',
  'buyer_accepted',
  'in_production',
  'delivered',
];

function isNonBlankText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class QuoteRequest {
  readonly id: string;
  readonly buyer_id: string;
  readonly category_id: string | null;
  readonly spec: string | null;
  readonly quantity: number | null;
  readonly unit: RequestUnit | null;
  readonly unit_set_description: string | null;
  readonly status: RequestStatus;
  readonly delivery_mode: DeliveryMode | null;
  readonly delivery_region: string | null;
  readonly delivery_address: string | null;
  readonly recipient_name: string | null;
  readonly recipient_phone: string | null;
  readonly bidding_deadline: Date | null;
  readonly delivery_deadline: Date | null;
  readonly bidding_closed_at: Date | null;
  readonly version: number;
  readonly cancelled_at: Date | null;
  readonly cancelled_by: string | null;
  readonly cancel_reason: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;

  private constructor(props: QuoteRequestProps) {
    this.id = EntityId.of(props.id, 'request.id').value;
    this.buyer_id = EntityId.of(props.buyer_id, 'request.buyer_id').value;
    this.category_id =
      props.category_id !== null
        ? EntityId.of(props.category_id, 'request.category_id').value
        : null;
    this.spec = props.spec;
    this.quantity =
      props.quantity !== null ? Quantity.of(props.quantity, 'request.quantity').value : null;
    this.unit = props.unit;
    this.unit_set_description = props.unit_set_description;
    this.status = props.status;
    this.delivery_mode = props.delivery_mode;
    this.delivery_region = props.delivery_region;
    this.delivery_address = props.delivery_address;
    this.recipient_name = props.recipient_name;
    this.recipient_phone = props.recipient_phone;
    this.bidding_deadline = props.bidding_deadline
      ? new Date(props.bidding_deadline.getTime())
      : null;
    this.delivery_deadline = props.delivery_deadline
      ? new Date(props.delivery_deadline.getTime())
      : null;
    this.bidding_closed_at = props.bidding_closed_at
      ? new Date(props.bidding_closed_at.getTime())
      : null;
    this.version = Version.of(props.version, 'request.version').value;
    this.cancelled_at = props.cancelled_at ? new Date(props.cancelled_at.getTime()) : null;
    this.cancelled_by =
      props.cancelled_by !== null
        ? EntityId.of(props.cancelled_by, 'request.cancelled_by').value
        : null;
    this.cancel_reason = props.cancel_reason;
    this.created_at = new Date(props.created_at.getTime());
    this.updated_at = new Date(props.updated_at.getTime());

    this.validateInternalInvariants();
    Object.freeze(this);
  }

  private validateInternalInvariants(): void {
    // INV-01: Cancellation consistency check
    if ((this.cancelled_at === null) !== (this.cancelled_by === null)) {
      throw new InvalidStateTransitionError(
        'cancelled_at and cancelled_by must both be null or both be present.',
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }

    if (
      this.cancelled_at !== null &&
      (this.status === 'draft_request' || this.status === 'delivered')
    ) {
      throw new InvalidStateTransitionError(
        `QuoteRequest in status ${this.status} cannot have a cancelled state.`,
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }

    if (this.status !== 'draft_request') {
      this.assertSentFieldsComplete();
    }
  }

  private assertSentFieldsComplete(): void {
    if (
      this.category_id === null ||
      !isNonBlankText(this.spec) ||
      this.quantity === null ||
      this.unit === null ||
      this.delivery_mode === null ||
      !isNonBlankText(this.recipient_name) ||
      !isNonBlankText(this.recipient_phone) ||
      this.bidding_deadline === null ||
      this.delivery_deadline === null
    ) {
      throw new InvalidTradingInputError(
        'Sent QuoteRequest is missing required commercial, recipient, or deadline fields.',
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }

    if (this.unit === 'set' && !isNonBlankText(this.unit_set_description)) {
      throw new InvalidTradingInputError(
        'unit_set_description is required when unit is "set".',
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          field: 'unit_set_description',
        },
      );
    }

    if (
      this.delivery_mode === 'at_buyer_address' &&
      (!isNonBlankText(this.delivery_region) || !isNonBlankText(this.delivery_address))
    ) {
      throw new InvalidTradingInputError(
        'delivery_region and delivery_address are required when delivery_mode is "at_buyer_address".',
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          field: 'delivery_address',
        },
      );
    }

    RequestDeadlines.fromPersisted(this.bidding_deadline, this.delivery_deadline);
  }

  static reconstitute(props: QuoteRequestProps): QuoteRequest {
    return new QuoteRequest(props);
  }

  static createDraft(input: {
    readonly id: string;
    readonly buyer_id: string;
    readonly draft: DraftQuoteRequestInput;
    readonly now: Date;
  }): { readonly request: QuoteRequest; readonly statusLog: StatusLogRecord } {
    const request = new QuoteRequest({
      id: input.id,
      buyer_id: input.buyer_id,
      category_id: input.draft.category_id ?? null,
      spec: input.draft.spec ?? null,
      quantity: input.draft.quantity ?? null,
      unit: input.draft.unit ?? null,
      unit_set_description:
        input.draft.unit === 'piece' ? null : (input.draft.unit_set_description ?? null),
      status: 'draft_request',
      delivery_mode: input.draft.delivery_mode ?? null,
      delivery_region:
        input.draft.delivery_mode === 'at_workshop'
          ? null
          : (input.draft.delivery_region ?? null),
      delivery_address:
        input.draft.delivery_mode === 'at_workshop'
          ? null
          : (input.draft.delivery_address ?? null),
      recipient_name: input.draft.recipient_name ?? null,
      recipient_phone: input.draft.recipient_phone ?? null,
      bidding_deadline: input.draft.bidding_deadline ?? null,
      delivery_deadline: input.draft.delivery_deadline ?? null,
      bidding_closed_at: null,
      version: 1,
      cancelled_at: null,
      cancelled_by: null,
      cancel_reason: null,
      created_at: input.now,
      updated_at: input.now,
    });

    const statusLog: StatusLogRecord = Object.freeze({
      request_id: request.id,
      event_type: 'created',
      prev_status: null,
      new_status: 'draft_request',
      performed_by: request.buyer_id,
      is_admin_action: false,
      note: null,
      evidence: null,
      created_at: new Date(input.now.getTime()),
    });

    return { request, statusLog };
  }

  copyAsDraft(input: {
    readonly newId: string;
    readonly buyerId: string;
    readonly now: Date;
  }): { readonly request: QuoteRequest; readonly statusLog: StatusLogRecord } {
    this.assertOwner(input.buyerId);
    return QuoteRequest.createDraft({
      id: input.newId,
      buyer_id: this.buyer_id,
      now: input.now,
      draft: {
        category_id: this.category_id,
        spec: this.spec,
        quantity: this.quantity,
        unit: this.unit,
        unit_set_description: this.unit_set_description,
        delivery_mode: this.delivery_mode,
        delivery_region: this.delivery_region,
        delivery_address: this.delivery_address,
        recipient_name: this.recipient_name,
        recipient_phone: this.recipient_phone,
        bidding_deadline: null,
        delivery_deadline: null,
      },
    });
  }

  isCancelled(): boolean {
    return this.cancelled_at !== null;
  }

  isAcceptedOrBeyond(): boolean {
    return (
      this.status === 'buyer_accepted' ||
      this.status === 'in_production' ||
      this.status === 'delivered'
    );
  }

  isBiddingOpenAt(now: Date): boolean {
    if (this.isCancelled()) {
      return false;
    }
    if (this.status !== 'sent_to_artisans' && this.status !== 'artisans_bidding') {
      return false;
    }
    if (this.bidding_closed_at !== null || this.bidding_deadline === null) {
      return false;
    }
    return now.getTime() < this.bidding_deadline.getTime();
  }

  assertVersionMatches(expectedVersion: number): void {
    Version.of(this.version).assertMatches(expectedVersion, 'QuoteRequest');
  }

  assertNotCancelled(): void {
    if (this.isCancelled()) {
      throw new InvalidStateTransitionError(
        'Operation is not allowed because the QuoteRequest has been cancelled.',
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }
  }

  assertOwner(buyerId: string): void {
    const normalized = EntityId.of(buyerId, 'buyerId').value;
    if (this.buyer_id !== normalized) {
      throw new TradingPermissionDeniedError(
        'Actor is not the Buyer owner of this QuoteRequest.',
        { entity: 'QuoteRequest' },
      );
    }
  }

  static assertSequentialTransition(from: RequestStatus, to: RequestStatus): void {
    const fromIdx = ORDERED_REQUEST_STEPS.indexOf(from);
    const toIdx = ORDERED_REQUEST_STEPS.indexOf(to);
    if (fromIdx === -1 || toIdx === -1 || toIdx !== fromIdx + 1) {
      throw new InvalidStateTransitionError(
        `Invalid QuoteRequest state transition from "${from}" to "${to}". Transitions must follow the 6-step state machine sequentially.`,
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }
  }

  updateDraft(input: {
    readonly buyerId: string;
    readonly expectedVersion: number;
    readonly draft: DraftQuoteRequestInput;
    readonly now: Date;
  }): QuoteRequest {
    this.assertOwner(input.buyerId);
    this.assertNotCancelled();
    if (this.status !== 'draft_request') {
      throw new InvalidStateTransitionError(
        'Commercial and specification fields are immutable once the QuoteRequest has been sent.',
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }
    this.assertVersionMatches(input.expectedVersion);

    const nextUnit =
      input.draft.unit !== undefined ? input.draft.unit : this.unit;
    const nextDeliveryMode =
      input.draft.delivery_mode !== undefined
        ? input.draft.delivery_mode
        : this.delivery_mode;

    const nextBiddingDeadline =
      input.draft.bidding_deadline !== undefined
        ? input.draft.bidding_deadline
        : this.bidding_deadline;
    const nextDeliveryDeadline =
      input.draft.delivery_deadline !== undefined
        ? input.draft.delivery_deadline
        : this.delivery_deadline;

    if (nextBiddingDeadline !== null && nextDeliveryDeadline !== null) {
      RequestDeadlines.fromPersisted(nextBiddingDeadline, nextDeliveryDeadline);
    }

    return new QuoteRequest({
      ...this,
      category_id:
        input.draft.category_id !== undefined ? input.draft.category_id : this.category_id,
      spec: input.draft.spec !== undefined ? input.draft.spec : this.spec,
      quantity: input.draft.quantity !== undefined ? input.draft.quantity : this.quantity,
      unit: nextUnit,
      unit_set_description:
        nextUnit === 'piece'
          ? null
          : input.draft.unit_set_description !== undefined
            ? input.draft.unit_set_description
            : this.unit_set_description,
      delivery_mode: nextDeliveryMode,
      delivery_region:
        nextDeliveryMode === 'at_workshop'
          ? null
          : input.draft.delivery_region !== undefined
            ? input.draft.delivery_region
            : this.delivery_region,
      delivery_address:
        nextDeliveryMode === 'at_workshop'
          ? null
          : input.draft.delivery_address !== undefined
            ? input.draft.delivery_address
            : this.delivery_address,
      recipient_name:
        input.draft.recipient_name !== undefined
          ? input.draft.recipient_name
          : this.recipient_name,
      recipient_phone:
        input.draft.recipient_phone !== undefined
          ? input.draft.recipient_phone
          : this.recipient_phone,
      bidding_deadline: nextBiddingDeadline,
      delivery_deadline: nextDeliveryDeadline,
      version: Version.of(this.version).next().value,
      updated_at: input.now,
    });
  }

  assertCanBeDeletedBy(buyerId: string, expectedVersion?: number): void {
    this.assertOwner(buyerId);
    if (this.status !== 'draft_request') {
      throw new InvalidStateTransitionError(
        'Only QuoteRequests in "draft_request" status can be deleted.',
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }
    if (expectedVersion !== undefined) {
      this.assertVersionMatches(expectedVersion);
    }
  }

  sendToArtisans(input: {
    readonly buyerId: string;
    readonly expectedVersion: number;
    readonly eligibleWorkshopIds: readonly string[];
    readonly now: Date;
  }): {
    readonly request: QuoteRequest;
    readonly statusLog: StatusLogRecord;
    readonly recipientWorkshopIds: readonly string[];
  } {
    this.assertOwner(input.buyerId);
    this.assertNotCancelled();
    QuoteRequest.assertSequentialTransition(this.status, 'sent_to_artisans');
    this.assertVersionMatches(input.expectedVersion);

    if (this.bidding_deadline === null || this.delivery_deadline === null) {
      throw new InvalidTradingInputError(
        'bidding_deadline and delivery_deadline are required before sending a QuoteRequest.',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          entity: 'QuoteRequest',
        },
      );
    }

    // INV-02: Validate future deadlines and 24-hour buffer
    RequestDeadlines.validateForSend(
      this.bidding_deadline,
      this.delivery_deadline,
      input.now,
    );

    const uniqueSortedWorkshopIds = EntityId.sortAscending(
      Array.from(new Set(input.eligibleWorkshopIds)),
    );
    if (uniqueSortedWorkshopIds.length === 0) {
      throw new NoEligibleWorkshopError(
        'Cannot send QuoteRequest because there are no active public workshops.',
        {
          invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
          entity: 'QuoteRequest',
        },
      );
    }

    const updated = new QuoteRequest({
      ...this,
      status: 'sent_to_artisans',
      unit_set_description: this.unit === 'piece' ? null : this.unit_set_description,
      delivery_region:
        this.delivery_mode === 'at_workshop' ? null : this.delivery_region,
      delivery_address:
        this.delivery_mode === 'at_workshop' ? null : this.delivery_address,
      version: Version.of(this.version).next().value,
      updated_at: input.now,
    });

    const statusLog: StatusLogRecord = Object.freeze({
      request_id: updated.id,
      event_type: 'sent',
      prev_status: 'draft_request',
      new_status: 'sent_to_artisans',
      performed_by: updated.buyer_id,
      is_admin_action: false,
      note: null,
      evidence: null,
      created_at: new Date(input.now.getTime()),
    });

    return {
      request: updated,
      statusLog,
      recipientWorkshopIds: Object.freeze(uniqueSortedWorkshopIds),
    };
  }

  recordFirstQuoteReceived(input: {
    readonly actorId: string;
    readonly now: Date;
  }): {
    readonly request: QuoteRequest;
    readonly statusLog: StatusLogRecord | null;
  } {
    this.assertNotCancelled();
    if (this.status === 'artisans_bidding') {
      return { request: this, statusLog: null };
    }
    QuoteRequest.assertSequentialTransition(this.status, 'artisans_bidding');

    const updated = new QuoteRequest({
      ...this,
      status: 'artisans_bidding',
      version: Version.of(this.version).next().value,
      updated_at: input.now,
    });

    const statusLog: StatusLogRecord = Object.freeze({
      request_id: updated.id,
      event_type: 'first_quote',
      prev_status: 'sent_to_artisans',
      new_status: 'artisans_bidding',
      performed_by: EntityId.of(input.actorId, 'actorId').value,
      is_admin_action: false,
      note: null,
      evidence: null,
      created_at: new Date(input.now.getTime()),
    });

    return { request: updated, statusLog };
  }

  closeBiddingEarly(input: {
    readonly buyerId: string;
    readonly expectedVersion: number;
    readonly now: Date;
  }): { readonly request: QuoteRequest; readonly statusLog: StatusLogRecord } {
    this.assertOwner(input.buyerId);
    this.assertNotCancelled();
    this.assertVersionMatches(input.expectedVersion);

    if (this.status !== 'sent_to_artisans' && this.status !== 'artisans_bidding') {
      throw new InvalidStateTransitionError(
        `Cannot close bidding when QuoteRequest status is "${this.status}".`,
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }

    if (!this.isBiddingOpenAt(input.now)) {
      throw new BiddingClosedError('Bidding is already closed for this QuoteRequest.', {
        invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
        entity: 'QuoteRequest',
      });
    }

    const updated = new QuoteRequest({
      ...this,
      bidding_closed_at: new Date(input.now.getTime()),
      version: Version.of(this.version).next().value,
      updated_at: input.now,
    });

    const statusLog: StatusLogRecord = Object.freeze({
      request_id: updated.id,
      event_type: 'bidding_closed',
      prev_status: this.status,
      new_status: updated.status,
      performed_by: updated.buyer_id,
      is_admin_action: false,
      note: null,
      evidence: null,
      created_at: new Date(input.now.getTime()),
    });

    return { request: updated, statusLog };
  }

  materializeDeadlineBiddingClosure(now: Date): {
    readonly request: QuoteRequest;
    readonly statusLog: StatusLogRecord | null;
  } {
    if (
      this.isCancelled() ||
      (this.status !== 'sent_to_artisans' && this.status !== 'artisans_bidding') ||
      this.bidding_closed_at !== null ||
      this.bidding_deadline === null ||
      now.getTime() < this.bidding_deadline.getTime()
    ) {
      return { request: this, statusLog: null };
    }

    const closedAt = new Date(this.bidding_deadline.getTime());
    const updated = new QuoteRequest({
      ...this,
      bidding_closed_at: closedAt,
      version: Version.of(this.version).next().value,
      updated_at: now,
    });

    const statusLog: StatusLogRecord = Object.freeze({
      request_id: updated.id,
      event_type: 'bidding_closed',
      prev_status: this.status,
      new_status: updated.status,
      performed_by: null,
      is_admin_action: false,
      note: null,
      evidence: null,
      created_at: closedAt,
    });

    return { request: updated, statusLog };
  }

  markBuyerAccepted(input: {
    readonly buyerId: string;
    readonly expectedVersion: number;
    readonly now: Date;
  }): { readonly request: QuoteRequest; readonly statusLogs: readonly StatusLogRecord[] } {
    this.assertOwner(input.buyerId);
    this.assertNotCancelled();
    this.assertVersionMatches(input.expectedVersion);
    QuoteRequest.assertSequentialTransition(this.status, 'buyer_accepted');

    const logs: StatusLogRecord[] = [];
    let closedAt = this.bidding_closed_at;
    if (closedAt === null && this.bidding_deadline !== null) {
      closedAt =
        input.now.getTime() >= this.bidding_deadline.getTime()
          ? new Date(this.bidding_deadline.getTime())
          : new Date(input.now.getTime());

      logs.push(
        Object.freeze({
          request_id: this.id,
          event_type: 'bidding_closed',
          prev_status: this.status,
          new_status: this.status,
          performed_by:
            input.now.getTime() >= this.bidding_deadline.getTime()
              ? null
              : this.buyer_id,
          is_admin_action: false,
          note: null,
          evidence: null,
          created_at: closedAt,
        }),
      );
    }

    const updated = new QuoteRequest({
      ...this,
      status: 'buyer_accepted',
      bidding_closed_at: closedAt,
      version: Version.of(this.version).next().value,
      updated_at: input.now,
    });

    logs.push(
      Object.freeze({
        request_id: updated.id,
        event_type: 'accepted',
        prev_status: 'artisans_bidding',
        new_status: 'buyer_accepted',
        performed_by: updated.buyer_id,
        is_admin_action: false,
        note: null,
        evidence: null,
        created_at: new Date(input.now.getTime()),
      }),
    );

    return { request: updated, statusLogs: Object.freeze(logs) };
  }

  markInProduction(input: {
    readonly actorId: string;
    readonly now: Date;
  }): { readonly request: QuoteRequest; readonly statusLog: StatusLogRecord | null } {
    this.assertNotCancelled();
    if (this.status === 'in_production') {
      return { request: this, statusLog: null };
    }
    QuoteRequest.assertSequentialTransition(this.status, 'in_production');

    const updated = new QuoteRequest({
      ...this,
      status: 'in_production',
      version: Version.of(this.version).next().value,
      updated_at: input.now,
    });

    const statusLog: StatusLogRecord = Object.freeze({
      request_id: updated.id,
      event_type: 'production_started',
      prev_status: 'buyer_accepted',
      new_status: 'in_production',
      performed_by: EntityId.of(input.actorId, 'actorId').value,
      is_admin_action: false,
      note: null,
      evidence: null,
      created_at: new Date(input.now.getTime()),
    });

    return { request: updated, statusLog };
  }

  confirmDelivered(input: {
    readonly actorId: string;
    readonly actorRole: 'buyer' | 'admin';
    readonly expectedVersion: number;
    readonly allocationStatuses: readonly AllocationStatus[];
    readonly reason?: string | null;
    readonly evidence?: string | null;
    readonly now: Date;
  }): { readonly request: QuoteRequest; readonly statusLog: StatusLogRecord } {
    this.assertNotCancelled();
    this.assertVersionMatches(input.expectedVersion);
    QuoteRequest.assertSequentialTransition(this.status, 'delivered');

    if (
      input.allocationStatuses.length === 0 ||
      input.allocationStatuses.some((status) => status !== 'handed_over')
    ) {
      throw new InvalidStateTransitionError(
        'Cannot confirm delivery until all Allocations have reached "handed_over" status.',
        {
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
          entity: 'QuoteRequest',
        },
      );
    }

    const actor = EntityId.of(input.actorId, 'actorId').value;
    let note: string | null = null;
    let evidence: string | null = null;
    let eventType: StatusLogEventType = 'received_by_buyer';
    let isAdminAction = false;

    if (input.actorRole === 'buyer') {
      this.assertOwner(actor);
    } else {
      const trimmedReason = input.reason?.trim() ?? '';
      const trimmedEvidence = input.evidence?.trim() ?? '';
      if (trimmedReason.length === 0 || trimmedEvidence.length === 0) {
        throw new InvalidTradingInputError(
          'Admin delivery confirmation requires both non-empty reason and evidence.',
          {
            invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
            field: 'reason',
          },
        );
      }
      note = trimmedReason;
      evidence = trimmedEvidence;
      eventType = 'received_by_admin';
      isAdminAction = true;
    }

    const updated = new QuoteRequest({
      ...this,
      status: 'delivered',
      version: Version.of(this.version).next().value,
      updated_at: input.now,
    });

    const statusLog: StatusLogRecord = Object.freeze({
      request_id: updated.id,
      event_type: eventType,
      prev_status: 'in_production',
      new_status: 'delivered',
      performed_by: actor,
      is_admin_action: isAdminAction,
      note,
      evidence,
      created_at: new Date(input.now.getTime()),
    });

    return { request: updated, statusLog };
  }

  cancel(input: {
    readonly actorId: string;
    readonly actorRole: 'buyer' | 'admin';
    readonly expectedVersion: number;
    readonly cancelReason?: string | null;
    readonly goodsHandlingNote?: string | null;
    readonly now: Date;
  }): { readonly request: QuoteRequest; readonly statusLogs: readonly StatusLogRecord[] } {
    this.assertNotCancelled();
    this.assertVersionMatches(input.expectedVersion);

    if (this.status === 'draft_request' || this.status === 'delivered') {
      throw new InvalidStateTransitionError(
        `QuoteRequest in "${this.status}" status cannot be cancelled.`,
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }

    const actor = EntityId.of(input.actorId, 'actorId').value;
    const trimmedReason = input.cancelReason?.trim() ?? '';
    const normalizedReason = trimmedReason.length > 0 ? trimmedReason : null;
    const trimmedHandling = input.goodsHandlingNote?.trim() ?? '';
    const normalizedHandling = trimmedHandling.length > 0 ? trimmedHandling : null;

    if (input.actorRole === 'buyer') {
      this.assertOwner(actor);
      if (this.status !== 'sent_to_artisans' && this.status !== 'artisans_bidding') {
        throw new InvalidStateTransitionError(
          `Buyer can only cancel QuoteRequest in "sent_to_artisans" or "artisans_bidding" status (current: "${this.status}").`,
          {
            invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
            entity: 'QuoteRequest',
          },
        );
      }
    } else {
      if (this.status !== 'buyer_accepted' && this.status !== 'in_production') {
        throw new InvalidStateTransitionError(
          `Admin can only cancel QuoteRequest in "buyer_accepted" or "in_production" status (current: "${this.status}").`,
          {
            invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
            entity: 'QuoteRequest',
          },
        );
      }
      if (normalizedReason === null) {
        throw new InvalidTradingInputError(
          'Admin cancellation requires a non-empty cancel_reason.',
          {
            invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
            field: 'cancel_reason',
          },
        );
      }
      if (
        this.status === 'in_production' &&
        input.goodsHandlingNote !== undefined &&
        normalizedHandling === null
      ) {
        throw new InvalidTradingInputError(
          'Admin cancellation during in_production requires a non-empty goods_handling_note.',
          {
            invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
            field: 'goods_handling_note',
          },
        );
      }
    }

    const logs: StatusLogRecord[] = [];
    let closedAt = this.bidding_closed_at;
    if (
      closedAt === null &&
      this.bidding_deadline !== null &&
      (this.status === 'sent_to_artisans' || this.status === 'artisans_bidding')
    ) {
      closedAt =
        input.now.getTime() >= this.bidding_deadline.getTime()
          ? new Date(this.bidding_deadline.getTime())
          : new Date(input.now.getTime());
    }

    const updated = new QuoteRequest({
      ...this,
      bidding_closed_at: closedAt,
      cancelled_at: new Date(input.now.getTime()),
      cancelled_by: actor,
      cancel_reason: normalizedReason,
      version: Version.of(this.version).next().value,
      updated_at: input.now,
    });

    logs.push(
      Object.freeze({
        request_id: updated.id,
        event_type: 'cancelled',
        prev_status: this.status,
        new_status: updated.status,
        performed_by: actor,
        is_admin_action: input.actorRole === 'admin',
        note: normalizedReason,
        evidence: normalizedHandling,
        created_at: new Date(input.now.getTime()),
      }),
    );

    return { request: updated, statusLogs: Object.freeze(logs) };
  }

  updateRecipientContact(input: {
    readonly buyerId: string;
    readonly expectedVersion: number;
    readonly recipientName?: string;
    readonly recipientPhone?: string;
    readonly now: Date;
  }): { readonly request: QuoteRequest; readonly contactEditHistory: ContactEditRecord } {
    this.assertOwner(input.buyerId);
    this.assertNotCancelled();

    if (this.status === 'draft_request' || this.status === 'delivered') {
      throw new InvalidStateTransitionError(
        `Recipient contact cannot be updated via contact-patch when status is "${this.status}".`,
        {
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
          entity: 'QuoteRequest',
        },
      );
    }

    this.assertVersionMatches(input.expectedVersion);

    const currentContact = RecipientContact.of(
      this.recipient_name ?? '',
      this.recipient_phone ?? '',
    );
    const nextContact = RecipientContact.of(
      input.recipientName !== undefined ? input.recipientName : currentContact.recipientName,
      input.recipientPhone !== undefined ? input.recipientPhone : currentContact.recipientPhone,
    );

    if (currentContact.equals(nextContact)) {
      throw new InvalidTradingInputError(
        'At least one of recipient_name or recipient_phone must change.',
        { field: 'recipient_name' },
      );
    }

    const nextVersion = Version.of(this.version).next().value;
    const updated = new QuoteRequest({
      ...this,
      recipient_name: nextContact.recipientName,
      recipient_phone: nextContact.recipientPhone,
      version: nextVersion,
      updated_at: input.now,
    });

    const contactEditHistory: ContactEditRecord = Object.freeze({
      request_id: updated.id,
      edited_by: updated.buyer_id,
      prev_recipient_name: currentContact.recipientName,
      prev_recipient_phone: currentContact.recipientPhone,
      new_recipient_name: nextContact.recipientName,
      new_recipient_phone: nextContact.recipientPhone,
      edited_at: new Date(input.now.getTime()),
      version: nextVersion,
    });

    return { request: updated, contactEditHistory };
  }

  deriveNoValidQuotes(eligibleQuoteCount: number): boolean {
    if (this.isCancelled() || this.status !== 'artisans_bidding') {
      return false;
    }
    return eligibleQuoteCount === 0;
  }
}
