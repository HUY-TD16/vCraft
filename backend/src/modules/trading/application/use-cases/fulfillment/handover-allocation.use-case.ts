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
  MAX_DELIVERY_NOTE_LENGTH,
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

export interface HandoverAllocationInput {
  readonly actor: AuthenticatedActor | TrustedActor;
  readonly allocationId?: Id;
  readonly id?: Id;
  readonly expectedAllocationVersion?: number;
  readonly expected_allocation_version?: number;
  readonly deliveryNote?: string | null;
  readonly delivery_note?: string | null;
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export type RecordArtisanHandoverInput = HandoverAllocationInput;

export interface HandoverAllocationResult {
  readonly allocation: AllocationDto;
  readonly currentState: TradingCurrentStateDto;
}

export type RecordArtisanHandoverResult = HandoverAllocationResult;

/**
 * Use Case UC-24 (`BR-05`, `BR-20`, `BR-24`, `BR-26`, `BR-27`, `SEC-05`, `SEC-06`):
 * Records Artisan handover for an owned Allocation (`POST /api/v1/artisan/allocations/:id/handover`):
 * - Verifies QuoteRequest is in `in_production` and not cancelled (`cancelled_at === null`).
 * - Verifies Allocation is owned by the Artisan's workshop, matches `expected_allocation_version`,
 *   and is currently in `in_production` status.
 * - Transitions Allocation from `in_production` to `handed_over`, recording `handed_over_at`,
 *   `handed_over_by`, optional `delivery_note`, incrementing `Allocation.version`, and
 *   appending `AllocationLog('handover_recorded')`.
 * - Missing or draft batch links surface `traceability_warning` without blocking handover (`BR-24`).
 * - Suspended workshops remain permitted to complete and hand over awarded Allocations (`BR-05`).
 * - QuoteRequest remains in `in_production` until Buyer (`UC-25`) or Admin (`UC-26`) confirms full delivery.
 */
export class HandoverAllocationUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly allocationRepo: IAllocationRepository,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly workshopContract?: IWorkshopContract,
  ) {}

  async execute(
    input: HandoverAllocationInput,
  ): Promise<HandoverAllocationResult> {
    if (
      'sessionLevel' in input.actor &&
      input.actor.sessionLevel === 'temp_password'
    ) {
      throw new TradingDomainError(
        'TEMP_PASSWORD_RESTRICTED',
        'Temporary password session cannot record allocation handover.',
      );
    }

    if (input.actor.role !== 'artisan') {
      throw new TradingPermissionDeniedError(
        'Only artisans can record handover on allocations.',
      );
    }

    if (!input.actor.workshopId) {
      throw new TradingPermissionDeniedError(
        'Artisan actor is not associated with any workshop.',
      );
    }

    const actorId = EntityId.of(input.actor.accountId, 'accountId').value;
    const workshopId = EntityId.of(input.actor.workshopId, 'workshopId').value;

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
        'expected_allocation_version is required to record allocation handover.',
        { field: 'expected_allocation_version' },
      );
    }
    const expectedVersion = Version.of(
      rawExpectedVersion,
      'expected_allocation_version',
    ).value;

    const rawDeliveryNote =
      input.deliveryNote !== undefined
        ? input.deliveryNote
        : input.delivery_note;

    if (rawDeliveryNote !== undefined && rawDeliveryNote !== null) {
      if (typeof rawDeliveryNote !== 'string') {
        throw new InvalidTradingInputError(
          'delivery_note must be a string or null.',
          {
            field: 'delivery_note',
            invariant:
              TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
          },
        );
      }

      if (rawDeliveryNote.trim().length > MAX_DELIVERY_NOTE_LENGTH) {
        throw new InvalidTradingInputError(
          `delivery_note cannot exceed ${MAX_DELIVERY_NOTE_LENGTH} characters.`,
          {
            field: 'delivery_note',
            invariant:
              TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
          },
        );
      }
    }

    const runWithTx = async (
      tx: TransactionContext,
    ): Promise<HandoverAllocationResult> => {
      // 1. Pre-read without lock to discover request_id and enforce anti-IDOR before locking (SEC-06)
      const preAllocation = await this.allocationRepo.findById(allocationId, tx);
      if (!preAllocation || preAllocation.workshop_id !== workshopId) {
        throw new AllocationNotFoundError('Allocation was not found.', {
          entity: 'Allocation',
          id: allocationId,
        });
      }

      // 2. Mandatory lock ordering (data-design.md §4.2, TradingLockOrderingPolicy):
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
      if (!lockedAllocation || lockedAllocation.workshop_id !== workshopId) {
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

      // 3. Execute domain handover transition (BR-24, BR-26, BR-27)
      const now = input.now ?? new Date();
      const { allocation: updatedAllocation, log } =
        lockedAllocation.recordArtisanHandover({
          request: lockedRequest,
          actorId,
          actorWorkshopId: workshopId,
          expectedVersion,
          deliveryNote: rawDeliveryNote,
          now,
        });

      // 4. Persist updated Allocation and AllocationLog('handover_recorded') atomically in tx
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
}

export { HandoverAllocationUseCase as RecordArtisanHandoverUseCase };
