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

export interface StartAllocationProductionInput {
  readonly actor: AuthenticatedActor | TrustedActor;
  readonly allocationId?: Id;
  readonly id?: Id;
  readonly expectedAllocationVersion?: number;
  readonly expected_allocation_version?: number;
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export interface StartAllocationProductionResult {
  readonly allocation: AllocationDto;
  readonly currentState: TradingCurrentStateDto;
}

/**
 * Use Case UC-23 (`BR-05`, `BR-20`, `BR-24`, `BR-26`, `BR-27`, `SEC-06`):
 * Transitions an Artisan's owned Allocation from `not_started` to `in_production`,
 * recording `started_at`, `started_by`, and `AllocationLog('production_started')`.
 * If this is the first Allocation of the parent QuoteRequest to start, atomically
 * transitions QuoteRequest from `buyer_accepted` to `in_production` and appends
 * `StatusLog('production_started')`.
 *
 * Suspended workshops remain permitted to execute previously awarded Allocations (`BR-05`).
 */
export class StartAllocationProductionUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly allocationRepo: IAllocationRepository,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly workshopContract?: IWorkshopContract,
  ) {}

  async execute(
    input: StartAllocationProductionInput,
  ): Promise<StartAllocationProductionResult> {
    if (
      'sessionLevel' in input.actor &&
      input.actor.sessionLevel === 'temp_password'
    ) {
      throw new TradingDomainError(
        'TEMP_PASSWORD_RESTRICTED',
        'Temporary password session cannot start allocation production.',
      );
    }

    if (input.actor.role !== 'artisan') {
      throw new TradingPermissionDeniedError(
        'Only artisans can start production on allocations.',
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
        'expected_allocation_version is required to start allocation production.',
        { field: 'expected_allocation_version' },
      );
    }
    const expectedVersion = Version.of(
      rawExpectedVersion,
      'expected_allocation_version',
    ).value;

    const runWithTx = async (
      tx: TransactionContext,
    ): Promise<StartAllocationProductionResult> => {
      // Pre-read without lock to discover request_id and enforce anti-IDOR before locking
      const preAllocation = await this.allocationRepo.findById(allocationId, tx);
      if (!preAllocation || preAllocation.workshop_id !== workshopId) {
        throw new AllocationNotFoundError('Allocation was not found.', {
          entity: 'Allocation',
          id: allocationId,
        });
      }

      // Mandatory lock ordering (data-design.md §4.2, TradingLockOrderingPolicy):
      // 1. QuoteRequest -> 2. Allocation
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

      const now = input.now ?? new Date();
      const {
        allocation: updatedAllocation,
        updatedRequest,
        allocationLogs,
        requestStatusLog,
      } = lockedAllocation.startProduction({
        request: lockedRequest,
        actorId,
        actorWorkshopId: workshopId,
        expectedVersion,
        now,
      });

      const savedAllocation = await this.allocationRepo.update(
        {
          allocation: updatedAllocation,
          expectedVersion,
          logs: allocationLogs,
        },
        tx,
      );

      let savedRequest = lockedRequest;
      if (requestStatusLog !== null) {
        savedRequest = await this.quoteRequestRepo.update(
          {
            request: updatedRequest,
            expectedVersion: lockedRequest.version,
            statusLogs: [requestStatusLog],
          },
          tx,
        );
      }

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
          id: savedRequest.id,
          status: savedRequest.status,
          version: savedRequest.version,
          cancelled_at: savedRequest.cancelled_at
            ? savedRequest.cancelled_at.toISOString()
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
