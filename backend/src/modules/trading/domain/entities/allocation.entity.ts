import {
  DeadlineViolationError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  TradingPermissionDeniedError,
  TRADING_INVARIANTS,
} from '../errors/trading-domain.errors';
import {
  type AllocationLogEventType,
  type AllocationStatus,
  EntityId,
  Quantity,
  type TraceabilityWarning,
  UnitPrice,
  Version,
} from '../value-objects';
import { type QuoteRequest } from './quote-request.entity';

export interface AllocationBatchLinkProps {
  readonly id?: string;
  readonly workshop_id: string;
  readonly allocation_id: string;
  readonly batch_id: string;
  readonly linked_quantity: number;
  readonly linked_at: Date;
  readonly linked_by: string;
}

export class AllocationBatchLink {
  readonly id?: string;
  readonly workshop_id: string;
  readonly allocation_id: string;
  readonly batch_id: string;
  readonly linked_quantity: number;
  readonly linked_at: Date;
  readonly linked_by: string;

  private constructor(props: AllocationBatchLinkProps) {
    this.id =
      props.id !== undefined ? EntityId.of(props.id, 'allocationBatch.id').value : undefined;
    this.workshop_id = EntityId.of(
      props.workshop_id,
      'allocationBatch.workshop_id',
    ).value;
    this.allocation_id = EntityId.of(
      props.allocation_id,
      'allocationBatch.allocation_id',
    ).value;
    this.batch_id = EntityId.of(props.batch_id, 'allocationBatch.batch_id').value;
    this.linked_quantity = Quantity.of(
      props.linked_quantity,
      'allocationBatch.linked_quantity',
    ).value;
    this.linked_at = new Date(props.linked_at.getTime());
    this.linked_by = EntityId.of(props.linked_by, 'allocationBatch.linked_by').value;
    Object.freeze(this);
  }

  static reconstitute(props: AllocationBatchLinkProps): AllocationBatchLink {
    return new AllocationBatchLink(props);
  }
}

export interface AllocationLogRecord {
  readonly allocation_id: string;
  readonly event_type: AllocationLogEventType;
  readonly prev_status: AllocationStatus | null;
  readonly new_status: AllocationStatus;
  readonly performed_by: string;
  readonly is_admin_action: boolean;
  readonly note: string | null;
  readonly evidence: string | null;
  readonly created_at: Date;
}

export interface BatchLinkCandidateInput {
  readonly batch_id: string;
  readonly batch_workshop_id: string;
  readonly linked_quantity: number;
}

export interface AllocationProps {
  readonly id: string;
  readonly request_id: string;
  readonly workshop_id: string;
  readonly quote_id: string;
  readonly quantity: number;
  readonly unit_price: number;
  readonly committed_delivery_at: Date;
  readonly status: AllocationStatus;
  readonly version: number;
  readonly started_at: Date | null;
  readonly started_by: string | null;
  readonly handed_over_at: Date | null;
  readonly handed_over_by: string | null;
  readonly delivery_note: string | null;
  readonly admin_handed_over: boolean;
  readonly admin_delivery_evidence: string | null;
  readonly admin_handover_reason: string | null;
  readonly admin_handover_actual_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly batch_links?: readonly AllocationBatchLink[];
}

const ORDERED_ALLOCATION_STEPS: readonly AllocationStatus[] = [
  'not_started',
  'in_production',
  'handed_over',
];

export class Allocation {
  readonly id: string;
  readonly request_id: string;
  readonly workshop_id: string;
  readonly quote_id: string;
  readonly quantity: number;
  readonly unit_price: number;
  readonly committed_delivery_at: Date;
  readonly status: AllocationStatus;
  readonly version: number;
  readonly started_at: Date | null;
  readonly started_by: string | null;
  readonly handed_over_at: Date | null;
  readonly handed_over_by: string | null;
  readonly delivery_note: string | null;
  readonly admin_handed_over: boolean;
  readonly admin_delivery_evidence: string | null;
  readonly admin_handover_reason: string | null;
  readonly admin_handover_actual_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly batch_links: readonly AllocationBatchLink[];

  private constructor(props: AllocationProps) {
    this.id = EntityId.of(props.id, 'allocation.id').value;
    this.request_id = EntityId.of(props.request_id, 'allocation.request_id').value;
    this.workshop_id = EntityId.of(props.workshop_id, 'allocation.workshop_id').value;
    this.quote_id = EntityId.of(props.quote_id, 'allocation.quote_id').value;
    this.quantity = Quantity.of(props.quantity, 'allocation.quantity').value;
    this.unit_price = UnitPrice.of(props.unit_price, 'allocation.unit_price').value;
    this.committed_delivery_at = new Date(props.committed_delivery_at.getTime());
    this.status = props.status;
    this.version = Version.of(props.version, 'allocation.version').value;
    this.started_at = props.started_at ? new Date(props.started_at.getTime()) : null;
    this.started_by =
      props.started_by !== null
        ? EntityId.of(props.started_by, 'allocation.started_by').value
        : null;
    this.handed_over_at = props.handed_over_at
      ? new Date(props.handed_over_at.getTime())
      : null;
    this.handed_over_by =
      props.handed_over_by !== null
        ? EntityId.of(props.handed_over_by, 'allocation.handed_over_by').value
        : null;
    this.delivery_note = props.delivery_note;
    this.admin_handed_over = props.admin_handed_over;
    this.admin_delivery_evidence = props.admin_delivery_evidence;
    this.admin_handover_reason = props.admin_handover_reason;
    this.admin_handover_actual_at = props.admin_handover_actual_at
      ? new Date(props.admin_handover_actual_at.getTime())
      : null;
    this.created_at = new Date(props.created_at.getTime());
    this.updated_at = new Date(props.updated_at.getTime());
    this.batch_links = Object.freeze([...(props.batch_links ?? [])]);

    this.validateInternalInvariants();
    Object.freeze(this);
  }

  private validateInternalInvariants(): void {
    // INV-04: Admin handover invariant check
    if (this.admin_handed_over) {
      const hasReason =
        typeof this.admin_handover_reason === 'string' &&
        this.admin_handover_reason.trim().length > 0;
      const hasEvidence =
        typeof this.admin_delivery_evidence === 'string' &&
        this.admin_delivery_evidence.trim().length > 0;

      if (
        this.status !== 'handed_over' ||
        this.handed_over_by === null ||
        this.handed_over_at === null ||
        this.admin_handover_actual_at === null ||
        !hasReason ||
        !hasEvidence
      ) {
        throw new InvalidStateTransitionError(
          'Admin handover requires status="handed_over", handed_over_by, handed_over_at, admin_handover_actual_at, non-empty reason, and non-empty evidence.',
          {
            invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
            entity: 'Allocation',
          },
        );
      }
    }

    // INV-04: Validate batch link invariants
    const seenBatches = new Set<string>();
    let linkedSum = 0n;
    for (const link of this.batch_links) {
      if (link.allocation_id !== this.id || link.workshop_id !== this.workshop_id) {
        throw new InvalidTradingInputError(
          'AllocationBatchLink must belong to the same allocation_id and workshop_id.',
          {
            invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
            entity: 'AllocationBatchLink',
          },
        );
      }
      if (seenBatches.has(link.batch_id)) {
        throw new InvalidTradingInputError(
          `Duplicate batch_id (${link.batch_id}) in Allocation batch links.`,
          {
            invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
            field: 'batch_id',
          },
        );
      }
      seenBatches.add(link.batch_id);
      linkedSum += BigInt(link.linked_quantity);
    }

    if (linkedSum > BigInt(this.quantity)) {
      throw new InvalidTradingInputError(
        `Total linked_quantity (${linkedSum.toString()}) cannot exceed Allocation quantity (${this.quantity}).`,
        {
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
          field: 'linked_quantity',
        },
      );
    }
  }

  static reconstitute(props: AllocationProps): Allocation {
    return new Allocation(props);
  }

  static createFromAcceptedQuote(input: {
    readonly id: string;
    readonly request_id: string;
    readonly workshop_id: string;
    readonly quote_id: string;
    readonly quantity: number;
    readonly unit_price: number;
    readonly committed_delivery_at: Date;
    readonly actorId: string;
    readonly now: Date;
  }): { readonly allocation: Allocation; readonly log: AllocationLogRecord } {
    const allocation = new Allocation({
      id: input.id,
      request_id: input.request_id,
      workshop_id: input.workshop_id,
      quote_id: input.quote_id,
      quantity: input.quantity,
      unit_price: input.unit_price,
      committed_delivery_at: input.committed_delivery_at,
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
      created_at: input.now,
      updated_at: input.now,
      batch_links: [],
    });

    const log: AllocationLogRecord = Object.freeze({
      allocation_id: allocation.id,
      event_type: 'created',
      prev_status: null,
      new_status: 'not_started',
      performed_by: EntityId.of(input.actorId, 'actorId').value,
      is_admin_action: false,
      note: null,
      evidence: null,
      created_at: new Date(input.now.getTime()),
    });

    return { allocation, log };
  }

  assertVersionMatches(expectedVersion: number): void {
    Version.of(this.version).assertMatches(expectedVersion, 'Allocation');
  }

  assertWorkshopOwner(actorWorkshopId: string): void {
    const normalized = EntityId.of(actorWorkshopId, 'actorWorkshopId').value;
    if (this.workshop_id !== normalized) {
      throw new TradingPermissionDeniedError(
        'Artisan does not own the workshop assigned to this Allocation.',
        { entity: 'Allocation' },
      );
    }
  }

  static assertSequentialTransition(from: AllocationStatus, to: AllocationStatus): void {
    const fromIdx = ORDERED_ALLOCATION_STEPS.indexOf(from);
    const toIdx = ORDERED_ALLOCATION_STEPS.indexOf(to);
    if (fromIdx === -1 || toIdx === -1 || toIdx !== fromIdx + 1) {
      throw new InvalidStateTransitionError(
        `Invalid Allocation state transition from "${from}" to "${to}". Transitions must follow not_started -> in_production -> handed_over.`,
        {
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
          entity: 'Allocation',
        },
      );
    }
  }

  private buildValidatedBatchLinks(
    candidates: readonly BatchLinkCandidateInput[],
    actorId: string,
    now: Date,
  ): AllocationBatchLink[] {
    const seenBatches = new Set<string>();
    let totalLinked = 0n;
    const links: AllocationBatchLink[] = [];

    for (const candidate of candidates) {
      const batchId = EntityId.of(candidate.batch_id, 'batch_id').value;
      const batchWorkshopId = EntityId.of(
        candidate.batch_workshop_id,
        'batch_workshop_id',
      ).value;

      if (batchWorkshopId !== this.workshop_id) {
        throw new TradingPermissionDeniedError(
          `Batch ${batchId} does not belong to workshop ${this.workshop_id}.`,
          {
            invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
            entity: 'AllocationBatchLink',
          },
        );
      }

      if (seenBatches.has(batchId)) {
        throw new InvalidTradingInputError(
          `Duplicate batch_id (${batchId}) in batch_links payload.`,
          {
            invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
            field: 'batch_id',
          },
        );
      }
      seenBatches.add(batchId);

      const qty = Quantity.of(candidate.linked_quantity, 'linked_quantity');
      totalLinked += BigInt(qty.value);

      links.push(
        AllocationBatchLink.reconstitute({
          workshop_id: this.workshop_id,
          allocation_id: this.id,
          batch_id: batchId,
          linked_quantity: qty.value,
          linked_at: now,
          linked_by: actorId,
        }),
      );
    }

    if (totalLinked > BigInt(this.quantity)) {
      throw new InvalidTradingInputError(
        `Total linked_quantity (${totalLinked.toString()}) cannot exceed Allocation quantity (${this.quantity}).`,
        {
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
          field: 'linked_quantity',
        },
      );
    }

    return links;
  }

  startProduction(input: {
    readonly request: QuoteRequest;
    readonly actorId: string;
    readonly actorWorkshopId: string;
    readonly expectedVersion: number;
    readonly batchLinks?: readonly BatchLinkCandidateInput[];
    readonly now: Date;
  }): {
    readonly allocation: Allocation;
    readonly updatedRequest: QuoteRequest;
    readonly allocationLogs: readonly AllocationLogRecord[];
    readonly requestStatusLog: ReturnType<QuoteRequest['markInProduction']>['statusLog'];
  } {
    input.request.assertNotCancelled();
    if (
      input.request.status !== 'buyer_accepted' &&
      input.request.status !== 'in_production'
    ) {
      throw new InvalidStateTransitionError(
        `Cannot start production on Allocation when QuoteRequest status is "${input.request.status}".`,
        {
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
          entity: 'QuoteRequest',
        },
      );
    }

    this.assertWorkshopOwner(input.actorWorkshopId);
    this.assertVersionMatches(input.expectedVersion);
    Allocation.assertSequentialTransition(this.status, 'in_production');

    const actor = EntityId.of(input.actorId, 'actorId').value;
    const nextBatchLinks =
      input.batchLinks !== undefined
        ? this.buildValidatedBatchLinks(input.batchLinks, actor, input.now)
        : [...this.batch_links];

    const updatedAllocation = new Allocation({
      ...this,
      status: 'in_production',
      started_at: new Date(input.now.getTime()),
      started_by: actor,
      version: Version.of(this.version).next().value,
      updated_at: input.now,
      batch_links: nextBatchLinks,
    });

    const logs: AllocationLogRecord[] = [
      Object.freeze({
        allocation_id: updatedAllocation.id,
        event_type: 'production_started',
        prev_status: 'not_started',
        new_status: 'in_production',
        performed_by: actor,
        is_admin_action: false,
        note: null,
        evidence: null,
        created_at: new Date(input.now.getTime()),
      }),
    ];

    if (input.batchLinks !== undefined && input.batchLinks.length > 0) {
      logs.push(
        Object.freeze({
          allocation_id: updatedAllocation.id,
          event_type: 'batch_links_changed',
          prev_status: 'in_production',
          new_status: 'in_production',
          performed_by: actor,
          is_admin_action: false,
          note: null,
          evidence: null,
          created_at: new Date(input.now.getTime()),
        }),
      );
    }

    const { request: updatedRequest, statusLog: requestStatusLog } =
      input.request.markInProduction({
        actorId: actor,
        now: input.now,
      });

    return {
      allocation: updatedAllocation,
      updatedRequest,
      allocationLogs: Object.freeze(logs),
      requestStatusLog,
    };
  }

  replaceBatchLinks(input: {
    readonly request: QuoteRequest;
    readonly actorId: string;
    readonly actorWorkshopId: string;
    readonly expectedVersion: number;
    readonly batchLinks: readonly BatchLinkCandidateInput[];
    readonly now: Date;
  }): { readonly allocation: Allocation; readonly log: AllocationLogRecord } {
    input.request.assertNotCancelled();
    this.assertWorkshopOwner(input.actorWorkshopId);
    this.assertVersionMatches(input.expectedVersion);

    if (this.status !== 'in_production') {
      throw new InvalidStateTransitionError(
        `Batch links can only be modified while Allocation is in "in_production" status (current: "${this.status}").`,
        {
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
          entity: 'Allocation',
        },
      );
    }

    const actor = EntityId.of(input.actorId, 'actorId').value;
    const nextBatchLinks = this.buildValidatedBatchLinks(
      input.batchLinks,
      actor,
      input.now,
    );

    const updatedAllocation = new Allocation({
      ...this,
      batch_links: nextBatchLinks,
      version: Version.of(this.version).next().value,
      updated_at: input.now,
    });

    const log: AllocationLogRecord = Object.freeze({
      allocation_id: updatedAllocation.id,
      event_type: 'batch_links_changed',
      prev_status: 'in_production',
      new_status: 'in_production',
      performed_by: actor,
      is_admin_action: false,
      note: null,
      evidence: null,
      created_at: new Date(input.now.getTime()),
    });

    return { allocation: updatedAllocation, log };
  }

  recordArtisanHandover(input: {
    readonly request: QuoteRequest;
    readonly actorId: string;
    readonly actorWorkshopId: string;
    readonly expectedVersion: number;
    readonly deliveryNote?: string | null;
    readonly now: Date;
  }): { readonly allocation: Allocation; readonly log: AllocationLogRecord } {
    input.request.assertNotCancelled();
    if (input.request.status !== 'in_production') {
      throw new InvalidStateTransitionError(
        `Cannot record handover when QuoteRequest status is "${input.request.status}".`,
        {
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
          entity: 'QuoteRequest',
        },
      );
    }

    this.assertWorkshopOwner(input.actorWorkshopId);
    this.assertVersionMatches(input.expectedVersion);
    Allocation.assertSequentialTransition(this.status, 'handed_over');

    const actor = EntityId.of(input.actorId, 'actorId').value;
    const trimmedNote = input.deliveryNote?.trim() ?? '';
    const normalizedNote = trimmedNote.length > 0 ? trimmedNote : null;

    const updatedAllocation = new Allocation({
      ...this,
      status: 'handed_over',
      handed_over_at: new Date(input.now.getTime()),
      handed_over_by: actor,
      delivery_note: normalizedNote,
      admin_handed_over: false,
      admin_delivery_evidence: null,
      admin_handover_reason: null,
      admin_handover_actual_at: null,
      version: Version.of(this.version).next().value,
      updated_at: input.now,
    });

    const log: AllocationLogRecord = Object.freeze({
      allocation_id: updatedAllocation.id,
      event_type: 'handover_recorded',
      prev_status: 'in_production',
      new_status: 'handed_over',
      performed_by: actor,
      is_admin_action: false,
      note: normalizedNote,
      evidence: null,
      created_at: new Date(input.now.getTime()),
    });

    return { allocation: updatedAllocation, log };
  }

  recordAdminHandover(input: {
    readonly request: QuoteRequest;
    readonly adminId: string;
    readonly expectedVersion: number;
    readonly reason: string;
    readonly evidence: string;
    readonly actualHandoverAt: Date;
    readonly deliveryNote?: string | null;
    readonly now: Date;
  }): { readonly allocation: Allocation; readonly log: AllocationLogRecord } {
    input.request.assertNotCancelled();
    if (input.request.status !== 'in_production') {
      throw new InvalidStateTransitionError(
        `Admin cannot record handover when QuoteRequest status is "${input.request.status}".`,
        {
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
          entity: 'QuoteRequest',
        },
      );
    }

    this.assertVersionMatches(input.expectedVersion);
    // INV-04: Admin can only record handover when allocation is in_production (never from not_started)
    Allocation.assertSequentialTransition(this.status, 'handed_over');

    const trimmedReason = input.reason.trim();
    const trimmedEvidence = input.evidence.trim();
    if (trimmedReason.length === 0 || trimmedEvidence.length === 0) {
      throw new InvalidTradingInputError(
        'Admin handover requires both non-empty reason and evidence.',
        {
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
          field: 'reason',
        },
      );
    }

    if (
      !(input.actualHandoverAt instanceof Date) ||
      Number.isNaN(input.actualHandoverAt.getTime())
    ) {
      throw new InvalidTradingInputError('actual_handover_at must be a valid Date.', {
        field: 'actual_handover_at',
      });
    }

    if (input.actualHandoverAt.getTime() > input.now.getTime()) {
      throw new DeadlineViolationError(
        'actual_handover_at cannot be in the future (actual_handover_at <= now).',
        {
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
          field: 'actual_handover_at',
        },
      );
    }

    const adminActor = EntityId.of(input.adminId, 'adminId').value;
    const trimmedNote = input.deliveryNote?.trim() ?? '';
    const normalizedNote = trimmedNote.length > 0 ? trimmedNote : null;

    const updatedAllocation = new Allocation({
      ...this,
      status: 'handed_over',
      handed_over_at: new Date(input.now.getTime()),
      handed_over_by: adminActor,
      delivery_note: normalizedNote,
      admin_handed_over: true,
      admin_handover_reason: trimmedReason,
      admin_delivery_evidence: trimmedEvidence,
      admin_handover_actual_at: new Date(input.actualHandoverAt.getTime()),
      version: Version.of(this.version).next().value,
      updated_at: input.now,
    });

    const log: AllocationLogRecord = Object.freeze({
      allocation_id: updatedAllocation.id,
      event_type: 'handover_by_admin',
      prev_status: 'in_production',
      new_status: 'handed_over',
      performed_by: adminActor,
      is_admin_action: true,
      note: trimmedReason,
      evidence: trimmedEvidence,
      created_at: new Date(input.now.getTime()),
    });

    return { allocation: updatedAllocation, log };
  }

  deriveTraceabilityWarning(
    publishedBatchIds: ReadonlySet<string>,
  ): TraceabilityWarning | null {
    if (this.batch_links.length === 0) {
      return 'NO_BATCH_LINK';
    }

    let linkedSum = 0n;
    for (const link of this.batch_links) {
      if (!publishedBatchIds.has(link.batch_id)) {
        return 'INCOMPLETE_TRACEABILITY';
      }
      linkedSum += BigInt(link.linked_quantity);
    }

    if (linkedSum < BigInt(this.quantity)) {
      return 'INCOMPLETE_TRACEABILITY';
    }

    return null;
  }
}
