import { assertTradingActor } from '../../helpers/trading-actor.helper';
import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
  TrustedActor,
} from '../../../../../common/application/types/contract-types';
import type { IWorkshopContract } from '../../../../workshops/public/contracts/workshop.contract';
import {
  AllocationNotFoundError,
  ConcurrencyConflictError,
  EntityId,
  InvalidTradingInputError,
  MAX_ADMIN_HANDOVER_TEXT_LENGTH,
  QuoteRequestNotFoundError,
  TRADING_INVARIANTS,
  TradingDomainError,
  TradingPermissionDeniedError,
  Version,
} from '../../../domain';
import type {
  AllocationDto,
  TradingCurrentStateDto,
  WorkshopRefDto,
} from '../../dtos/trading-persistence.dtos';
import type {
  IAllocationRepository,
  IQuoteRequestRepository,
} from '../../ports/repositories/trading-repositories.port';

const ISO_DATETIME_WITH_OFFSET_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface HandoverAllocationByAdminInput {
  readonly actor: AuthenticatedActor | TrustedActor;
  readonly allocationId?: Id;
  readonly id?: Id;
  readonly expectedAllocationVersion?: number;
  readonly expected_allocation_version?: number;
  readonly reason?: string | null;
  readonly evidence?: string | null;
  readonly actualHandoverAt?: Date | string | null;
  readonly actual_handover_at?: Date | string | null;
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export type RecordAdminHandoverInput = HandoverAllocationByAdminInput;

export interface HandoverAllocationByAdminResult {
  readonly allocation: AllocationDto;
  readonly currentState: TradingCurrentStateDto;
}

export type RecordAdminHandoverResult = HandoverAllocationByAdminResult;

/**
 * Use Case UC-24 (`BR-05`, `BR-24`, `BR-26`, `BR-27`, `SEC-01`, `SEC-05`, `SEC-06`, `SEC-13`, `AT-14`):
 * Records Admin override handover on behalf of an Artisan workshop
 * (`POST /api/v1/admin/allocations/:id/handover-by-admin`):
 * - Verifies Admin role and `normal` session level (rejects `temp_password` and non-admin roles).
 * - Requires non-empty `reason` (mapped to `admin_handover_reason`), non-empty `evidence`
 *   (mapped to `admin_delivery_evidence`), and valid `actual_handover_at` (`<= now`, mapped to
 *   `admin_handover_actual_at`).
 * - Acquires row locks in strict deadlock-free order (`data-design.md` §4.2):
 *   `QuoteRequest` -> `Allocation`.
 * - Verifies `QuoteRequest` is `in_production` and not cancelled (`cancelled_at === null`),
 *   and `Allocation` matches `expected_allocation_version` and is strictly in `in_production`
 *   (never `not_started` or already `handed_over`; Admin cannot synthesize a production start step).
 * - Transitions Allocation `in_production` -> `handed_over`, recording `handed_over_at = now`
 *   (system timestamp), `handed_over_by = adminId` (actual Admin actor, never impersonating Artisan),
 *   `admin_handed_over = true`, `admin_handover_reason`, `admin_delivery_evidence`,
 *   `admin_handover_actual_at`, incrementing `Allocation.version`, and appending
 *   `AllocationLog('handover_by_admin')` with `is_admin_action = true` atomically in the same transaction.
 * - Preserves existing `AllocationBatch` links untouched and surfaces `traceability_warning`
 *   without blocking handover (`BR-24`).
 * - Keeps `QuoteRequest` in `in_production` until Buyer (`UC-25`) or Admin (`UC-26`) confirms delivery.
 */
export class HandoverAllocationByAdminUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly allocationRepo: IAllocationRepository,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly workshopContract?: IWorkshopContract,
  ) {}

  async execute(
    input: HandoverAllocationByAdminInput,
  ): Promise<HandoverAllocationByAdminResult> {
    assertTradingActor(input.actor, {
      expectedRole: 'admin',
      tempPasswordMessage: 'Temporary password session cannot record admin allocation handover.',
      roleDeniedMessage: 'Only admins can record handover on behalf of a workshop.',
    });

    const adminId = EntityId.of(input.actor.accountId, 'accountId').value;

    const rawAllocationId = input.allocationId ?? input.id;
    if (!rawAllocationId) {
      throw new InvalidTradingInputError('allocationId is required.', {
        field: 'id',
      });
    }
    const allocationId = EntityId.of(rawAllocationId, 'id').value;

    const rawExpectedVersion =
      input.expectedAllocationVersion ?? input.expected_allocation_version;
    if (rawExpectedVersion === undefined || rawExpectedVersion === null) {
      throw new InvalidTradingInputError(
        'expected_allocation_version is required to record admin allocation handover.',
        { field: 'expected_allocation_version' },
      );
    }
    const expectedVersion = Version.of(
      rawExpectedVersion,
      'expected_allocation_version',
    ).value;

    if (typeof input.reason !== 'string') {
      throw new InvalidTradingInputError(
        'Admin handover requires a non-empty reason.',
        {
          field: 'reason',
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
        },
      );
    }
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new InvalidTradingInputError(
        'Admin handover requires a non-empty reason.',
        {
          field: 'reason',
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
        },
      );
    }
    if (reason.length > MAX_ADMIN_HANDOVER_TEXT_LENGTH) {
      throw new InvalidTradingInputError(
        `reason cannot exceed ${MAX_ADMIN_HANDOVER_TEXT_LENGTH} characters.`,
        {
          field: 'reason',
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
        },
      );
    }

    if (typeof input.evidence !== 'string') {
      throw new InvalidTradingInputError(
        'Admin handover requires non-empty evidence.',
        {
          field: 'evidence',
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
        },
      );
    }
    const evidence = input.evidence.trim();
    if (evidence.length === 0) {
      throw new InvalidTradingInputError(
        'Admin handover requires non-empty evidence.',
        {
          field: 'evidence',
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
        },
      );
    }
    if (evidence.length > MAX_ADMIN_HANDOVER_TEXT_LENGTH) {
      throw new InvalidTradingInputError(
        `evidence cannot exceed ${MAX_ADMIN_HANDOVER_TEXT_LENGTH} characters.`,
        {
          field: 'evidence',
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
        },
      );
    }

    const rawActualHandoverAt =
      input.actualHandoverAt !== undefined
        ? input.actualHandoverAt
        : input.actual_handover_at;
    const parsedActualHandoverAt = this.parseActualHandoverAt(rawActualHandoverAt);

    const runWithTx = async (
      tx: TransactionContext,
    ): Promise<HandoverAllocationByAdminResult> => {
      // 1. Pre-read without lock to discover request_id for canonical lock ordering
      const preAllocation = await this.allocationRepo.findById(allocationId, tx);
      if (!preAllocation) {
        throw new AllocationNotFoundError('Allocation was not found.', {
          entity: 'Allocation',
          id: allocationId,
        });
      }

      // 2. Mandatory lock ordering (data-design.md §4.2, architecture-overview.md §4.2):
      //    QuoteRequest -> Allocation
      const lockedRequest = await this.quoteRequestRepo.lockById(
        preAllocation.request_id,
        tx,
      );
      if (!lockedRequest) {
        throw new QuoteRequestNotFoundError(
          `QuoteRequest ${preAllocation.request_id} was not found.`,
          { entity: 'QuoteRequest', id: preAllocation.request_id },
        );
      }

      const lockedAllocation = await this.allocationRepo.lockById(
        allocationId,
        tx,
      );
      if (!lockedAllocation) {
        throw new AllocationNotFoundError('Allocation was not found.', {
          entity: 'Allocation',
          id: allocationId,
        });
      }

      if (lockedAllocation.request_id !== lockedRequest.id) {
        throw new ConcurrencyConflictError(
          `Allocation ${allocationId} request reference changed concurrently.`,
          {
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
            entity: 'Allocation',
          },
        );
      }

      // 3. Re-evaluate server clock after acquiring locks (architecture-overview.md §4.2)
      //    and execute domain admin handover transition (BR-24, BR-26, BR-27)
      const now = input.now ?? new Date();
      const { allocation: updatedAllocation, log } =
        lockedAllocation.recordAdminHandover({
          request: lockedRequest,
          adminId,
          expectedVersion,
          reason,
          evidence,
          actualHandoverAt: parsedActualHandoverAt,
          now,
        });

      // 4. Persist updated Allocation and AllocationLog('handover_by_admin', is_admin_action=true)
      //    atomically in tx. Batch links are NOT modified (BR-24).
      const savedAllocation = await this.allocationRepo.update(
        {
          allocation: updatedAllocation,
          expectedVersion,
          logs: [log],
        },
        tx,
      );

      // 5. Hydrate AllocationDto (including traceability_warning and actor references)
      const hydratedDetail =
        typeof this.allocationRepo.findDetailById === 'function'
          ? await this.allocationRepo.findDetailById(savedAllocation.id, tx)
          : null;

      let allocationDto: AllocationDto;
      if (hydratedDetail) {
        allocationDto = hydratedDetail.allocation;
      } else {
        let workshopRef: WorkshopRefDto = Object.freeze({
          id: savedAllocation.workshop_id,
          name: '',
        });
        if (this.workshopContract) {
          const summary = await this.workshopContract.getWorkshopSummary(
            savedAllocation.workshop_id,
          );
          if (summary) {
            workshopRef = Object.freeze({
              id: summary.id,
              name: summary.name,
            });
          }
        }

        allocationDto = Object.freeze({
          id: savedAllocation.id,
          request_id: savedAllocation.request_id,
          workshop: workshopRef,
          quote_id: savedAllocation.quote_id,
          quantity: savedAllocation.quantity,
          unit_price: savedAllocation.unit_price,
          committed_delivery_at:
            savedAllocation.committed_delivery_at.toISOString(),
          status: savedAllocation.status,
          version: savedAllocation.version,
          started_at: savedAllocation.started_at
            ? savedAllocation.started_at.toISOString()
            : null,
          started_by: savedAllocation.started_by
            ? Object.freeze({
                id: savedAllocation.started_by,
                display_name: null,
              })
            : null,
          handed_over_at: savedAllocation.handed_over_at
            ? savedAllocation.handed_over_at.toISOString()
            : null,
          handed_over_by: savedAllocation.handed_over_by
            ? Object.freeze({
                id: savedAllocation.handed_over_by,
                display_name: null,
              })
            : null,
          delivery_note: savedAllocation.delivery_note,
          admin_handed_over: savedAllocation.admin_handed_over,
          admin_handover_reason: savedAllocation.admin_handover_reason,
          admin_delivery_evidence: savedAllocation.admin_delivery_evidence,
          admin_handover_actual_at: savedAllocation.admin_handover_actual_at
            ? savedAllocation.admin_handover_actual_at.toISOString()
            : null,
          traceability_warning: savedAllocation.deriveTraceabilityWarning(
            new Set<string>(),
          ),
        });
      }

      const currentState: TradingCurrentStateDto = Object.freeze({
        request: Object.freeze({
          id: lockedRequest.id,
          status: lockedRequest.status,
          version: lockedRequest.version,
          cancelled_at: lockedRequest.cancelled_at
            ? lockedRequest.cancelled_at.toISOString()
            : null,
        }),
        allocation: Object.freeze({
          id: savedAllocation.id,
          status: savedAllocation.status,
          version: savedAllocation.version,
        }),
      });

      return Object.freeze({
        allocation: allocationDto,
        currentState,
      });
    };

    if (input.tx) {
      return runWithTx(input.tx);
    }

    return this.txRunner.run((tx) => runWithTx(tx));
  }

  private parseActualHandoverAt(raw: Date | string | null | undefined): Date {
    if (raw instanceof Date) {
      if (Number.isNaN(raw.getTime())) {
        throw new InvalidTradingInputError(
          'actual_handover_at must be a valid ISO 8601 datetime.',
          {
            field: 'actual_handover_at',
            invariant:
              TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
          },
        );
      }
      return new Date(raw.getTime());
    }

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!ISO_DATETIME_WITH_OFFSET_REGEX.test(trimmed)) {
        throw new InvalidTradingInputError(
          'actual_handover_at must be a valid ISO 8601 datetime with timezone offset or Z.',
          {
            field: 'actual_handover_at',
            invariant:
              TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
          },
        );
      }
      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) {
        throw new InvalidTradingInputError(
          'actual_handover_at must be a valid ISO 8601 datetime.',
          {
            field: 'actual_handover_at',
            invariant:
              TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
          },
        );
      }
      return parsed;
    }

    throw new InvalidTradingInputError('actual_handover_at is required.', {
      field: 'actual_handover_at',
      invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
    });
  }
}

export { HandoverAllocationByAdminUseCase as RecordAdminHandoverUseCase };
