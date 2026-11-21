import type {
  TransactionContext,
  TransactionRunner,
} from '../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
  TrustedActor,
} from '../../common/application/types/contract-types';
import type { ITraceabilityContract } from '../../modules/traceability/public/contracts/traceability.contract';
import type { IWorkshopContract } from '../../modules/workshops/public/contracts/workshop.contract';
import type {
  AllocationDto,
  TradingCurrentStateDto,
  WorkshopRefDto,
} from '../../modules/trading/application/dtos/trading-persistence.dtos';
import type {
  IAllocationBatchRepository,
  IAllocationRepository,
  IQuoteRequestRepository,
} from '../../modules/trading/application/ports/repositories/trading-repositories.port';
import {
  AllocationNotFoundError,
  type BatchLinkCandidateInput,
  ConcurrencyConflictError,
  EntityId,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  Quantity,
  QuoteRequestNotFoundError,
  TRADING_INVARIANTS,
  TradingDomainError,
  TradingPermissionDeniedError,
  TradingResourceNotFoundError,
  Version,
} from '../../modules/trading/domain';

export interface LinkBatchItemInput {
  readonly batch_id?: Id;
  readonly batchId?: Id;
  readonly linked_quantity?: number;
  readonly linkedQuantity?: number;
}

export interface LinkBatchesWorkflowInput {
  readonly actor: AuthenticatedActor | TrustedActor;
  readonly allocationId?: Id;
  readonly id?: Id;
  readonly expectedAllocationVersion?: number;
  readonly expected_allocation_version?: number;
  readonly links: readonly LinkBatchItemInput[];
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export interface LinkBatchesWorkflowResult {
  readonly allocation: AllocationDto;
  readonly currentState: TradingCurrentStateDto;
}

interface NormalizedBatchLinkItem {
  readonly batch_id: Id;
  readonly linked_quantity: number;
}

const MAX_BATCH_LINKS_PER_REQUEST = 100;

/**
 * Cross-module workflow coordinating `Trading` and `Traceability` (`ITraceabilityContract`)
 * to replace production batch links on an Artisan's Allocation (`UC-23`, `BR-05`, `BR-09`,
 * `BR-20`, `BR-24`, `BR-26`, `BR-27`, `SEC-06`, `docs/contracts/backend.md`).
 *
 * Enforces deterministic locking order (`data-design.md` §4.2, `architecture-overview.md` §4.2):
 * 1. `QuoteRequest` -> 2. `Allocation` -> 3. `Traceability.assertOwnedBatches` in the same `tx`.
 *
 * Draft batches (`status === 'draft'`) are permitted and surface `traceability_warning: 'INCOMPLETE_TRACEABILITY'`
 * without blocking persistence (`BR-24`, `UC-23`).
 * Suspended workshops remain permitted to link batches on already-awarded Allocations (`BR-05`).
 */
export class LinkBatchesWorkflow {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly allocationRepo: IAllocationRepository,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly traceabilityContract?: ITraceabilityContract,
    private readonly allocationBatchRepo?: IAllocationBatchRepository,
    private readonly workshopContract?: IWorkshopContract,
  ) {}

  async execute(
    input: LinkBatchesWorkflowInput,
  ): Promise<LinkBatchesWorkflowResult> {
    if (
      'sessionLevel' in input.actor &&
      input.actor.sessionLevel === 'temp_password'
    ) {
      throw new TradingDomainError(
        'TEMP_PASSWORD_RESTRICTED',
        'Temporary password session cannot link batches to allocations.',
      );
    }

    if (input.actor.role !== 'artisan') {
      throw new TradingPermissionDeniedError(
        'Only artisans can link production batches to allocations.',
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
        'expected_allocation_version is required to link batches to an allocation.',
        { field: 'expected_allocation_version' },
      );
    }
    const expectedVersion = Version.of(
      rawExpectedVersion,
      'expected_allocation_version',
    ).value;

    if (!Array.isArray(input.links)) {
      throw new InvalidTradingInputError('links must be an array.', {
        field: 'links',
      });
    }

    if (input.links.length > MAX_BATCH_LINKS_PER_REQUEST) {
      throw new InvalidTradingInputError(
        `links cannot contain more than ${MAX_BATCH_LINKS_PER_REQUEST} items.`,
        { field: 'links' },
      );
    }

    const normalizedLinks: NormalizedBatchLinkItem[] = [];
    for (let i = 0; i < input.links.length; i++) {
      const item = input.links[i];
      if (!item || typeof item !== 'object') {
        throw new InvalidTradingInputError(
          `links[${i}] must be a valid batch link object.`,
          { field: 'links' },
        );
      }

      const rawBatchId = item.batch_id ?? item.batchId;
      if (rawBatchId === undefined || rawBatchId === null || rawBatchId === '') {
        throw new InvalidTradingInputError(
          `links[${i}].batch_id is required.`,
          { field: 'batch_id' },
        );
      }
      const batchId = EntityId.of(rawBatchId, 'batch_id').value;

      const rawLinkedQty = item.linked_quantity ?? item.linkedQuantity;
      if (rawLinkedQty === undefined || rawLinkedQty === null) {
        throw new InvalidTradingInputError(
          `links[${i}].linked_quantity is required.`,
          { field: 'linked_quantity' },
        );
      }
      const linkedQuantity = Quantity.of(
        rawLinkedQty,
        'linked_quantity',
      ).value;

      normalizedLinks.push(
        Object.freeze({
          batch_id: batchId,
          linked_quantity: linkedQuantity,
        }),
      );
    }

    const runWithTx = async (
      tx: TransactionContext,
    ): Promise<LinkBatchesWorkflowResult> => {
      // 1. Pre-read without lock to discover request_id and enforce anti-IDOR (SEC-06)
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

      // 3. Verify request & allocation state and version under lock before external calls (BR-24, BR-27)
      lockedRequest.assertNotCancelled();
      if (
        lockedRequest.status !== 'in_production' &&
        lockedRequest.status !== 'buyer_accepted'
      ) {
        throw new InvalidStateTransitionError(
          `Cannot modify batch links on Allocation when QuoteRequest status is "${lockedRequest.status}".`,
          {
            invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
            entity: 'QuoteRequest',
          },
        );
      }

      lockedAllocation.assertWorkshopOwner(workshopId);
      lockedAllocation.assertVersionMatches(expectedVersion);

      if (lockedAllocation.status !== 'in_production') {
        throw new InvalidStateTransitionError(
          `Batch links can only be modified while Allocation is in "in_production" status (current: "${lockedAllocation.status}").`,
          {
            invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
            entity: 'Allocation',
          },
        );
      }

      // 4. Validate unique batch_ids and total linked_quantity <= allocation.quantity (BR-24, UC-23)
      const seenBatchIds = new Set<string>();
      let totalLinkedQuantity = 0n;
      for (const link of normalizedLinks) {
        if (seenBatchIds.has(link.batch_id)) {
          throw new InvalidTradingInputError(
            `Duplicate batch_id (${link.batch_id}) in links payload.`,
            {
              invariant:
                TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
              field: 'batch_id',
            },
          );
        }
        seenBatchIds.add(link.batch_id);
        totalLinkedQuantity += BigInt(link.linked_quantity);
      }

      if (totalLinkedQuantity > BigInt(lockedAllocation.quantity)) {
        throw new InvalidTradingInputError(
          `Total linked_quantity (${totalLinkedQuantity.toString()}) cannot exceed Allocation quantity (${lockedAllocation.quantity}).`,
          {
            invariant:
              TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
            field: 'linked_quantity',
          },
        );
      }

      // 5. Verify batch ownership via Traceability.assertOwnedBatches in the same tx (docs/contracts/backend.md)
      const publishedBatchIds = new Set<string>();
      const candidateInputs: BatchLinkCandidateInput[] = [];

      if (normalizedLinks.length > 0) {
        if (!this.traceabilityContract) {
          throw new Error(
            'Traceability contract is required for link-batches workflow.',
          );
        }

        const requestedBatchIds = normalizedLinks.map((item) => item.batch_id);
        const verifiedBatches =
          await this.traceabilityContract.assertOwnedBatches(
            {
              batchIds: requestedBatchIds,
              workshopId,
            },
            tx,
          );

        const verifiedById = new Map<
          string,
          {
            readonly id: Id;
            readonly name: string;
            readonly status: 'draft' | 'published';
            readonly traceUrl: string | null;
            readonly workshopId?: Id;
            readonly workshop_id?: Id;
          }
        >();

        if (Array.isArray(verifiedBatches)) {
          for (const batch of verifiedBatches) {
            if (batch && typeof batch.id === 'string') {
              const normalizedBatchId = EntityId.of(
                batch.id,
                'batch.id',
              ).value;
              verifiedById.set(normalizedBatchId, batch);
            }
          }
        }

        for (const link of normalizedLinks) {
          const verified = verifiedById.get(link.batch_id);
          if (!verified) {
            throw new TradingResourceNotFoundError(
              `Batch ${link.batch_id} was not found or does not belong to workshop ${workshopId}.`,
              {
                invariant:
                  TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
                entity: 'Batch',
                id: link.batch_id,
              },
            );
          }

          const returnedWorkshopId =
            verified.workshopId ?? verified.workshop_id ?? workshopId;
          if (returnedWorkshopId !== workshopId) {
            throw new TradingResourceNotFoundError(
              `Batch ${link.batch_id} does not belong to workshop ${workshopId}.`,
              {
                invariant:
                  TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
                entity: 'Batch',
                id: link.batch_id,
              },
            );
          }

          if (verified.status === 'published') {
            publishedBatchIds.add(link.batch_id);
          }

          candidateInputs.push({
            batch_id: link.batch_id,
            batch_workshop_id: returnedWorkshopId,
            linked_quantity: link.linked_quantity,
          });
        }
      }

      // 6. Execute domain transition on Allocation (bumps version, creates AllocationLog('batch_links_changed'))
      const now = input.now ?? new Date();
      const { allocation: updatedAllocation, log } =
        lockedAllocation.replaceBatchLinks({
          request: lockedRequest,
          actorId,
          actorWorkshopId: workshopId,
          expectedVersion,
          batchLinks: candidateInputs,
          now,
        });

      // 7. Persist AllocationBatch links, updated Allocation version, and AllocationLog atomically in tx
      const hasDedicatedBatchRepo =
        this.allocationBatchRepo !== undefined &&
        typeof this.allocationBatchRepo.replaceForAllocation === 'function';

      if (hasDedicatedBatchRepo) {
        await this.allocationBatchRepo!.replaceForAllocation(
          {
            allocationId: updatedAllocation.id,
            workshopId,
            links: updatedAllocation.batch_links,
          },
          tx,
        );
      }

      const savedAllocation = await this.allocationRepo.update(
        {
          allocation: updatedAllocation,
          expectedVersion,
          logs: [log],
          syncBatchLinks: !hasDedicatedBatchRepo,
        },
        tx,
      );

      // 8. Derive traceability_warning ('NO_BATCH_LINK' | 'INCOMPLETE_TRACEABILITY' | null)
      //    Draft batches trigger 'INCOMPLETE_TRACEABILITY' warning without blocking save (BR-24, UC-23).
      const traceabilityWarning =
        updatedAllocation.deriveTraceabilityWarning(publishedBatchIds);

      const hydratedDetail =
        typeof this.allocationRepo.findDetailById === 'function'
          ? await this.allocationRepo.findDetailById(savedAllocation.id, tx)
          : null;

      let allocationDto: AllocationDto;
      if (hydratedDetail) {
        allocationDto = Object.freeze({
          ...hydratedDetail.allocation,
          version: savedAllocation.version,
          status: savedAllocation.status,
          traceability_warning: traceabilityWarning,
        });
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
          traceability_warning: traceabilityWarning,
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
