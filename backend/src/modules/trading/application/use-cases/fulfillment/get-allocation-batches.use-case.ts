import { assertTradingNormalSession } from '../../helpers/trading-actor.helper';
import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
} from '../../../../../common/application/types/contract-types';
import { PAGINATION } from '../../../../../common/application/types/pagination';
import { HttpResult } from '../../../../../common/http/interceptors/response-envelope.interceptor';
import {
  AllocationNotFoundError,
  EntityId,
  InvalidTradingInputError,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../domain';
import type { AllocationBatchDto } from '../../dtos/trading-persistence.dtos';
import type {
  IAllocationBatchRepository,
  IAllocationRepository,
  IQuoteRequestRepository,
} from '../../ports/repositories/trading-repositories.port';

export interface GetAllocationBatchesQueryInput {
  readonly page?: number;
  readonly limit?: number;
}

export interface GetAllocationBatchesCommand {
  readonly actor: AuthenticatedActor;
  readonly id?: string;
  readonly allocationId?: string;
  readonly query?: GetAllocationBatchesQueryInput;
  readonly page?: number;
  readonly limit?: number;
  readonly tx?: TransactionContext;
}

/**
 * Use Case UC-23 (`BR-04`, `BR-05`, `BR-09`, `BR-20`, `BR-24`, `SEC-05`, `SEC-06`, `SEC-14`):
 * Retrieves the paginated list of production batches (`AllocationBatchDto`) linked to a specific
 * Allocation (`GET /api/v1/allocations/:id/batches`).
 * - Authorized principals: owning Buyer (`requestBuyerId === actor.accountId`),
 *   owning Artisan (`allocation.workshop.id === actor.workshopId`), and Admin.
 * - Retains read access across suspended workshops (`BR-05`) and completed/cancelled requests (`BR-04`).
 * - Traceability visibility (`BR-09`, `UC-23`, `api-design.md` §10.4, `api-dtos.md` §2.3):
 *   Published batches return `is_trace_public: true` and `trace_url: "/api/v1/trace/<qr_token>"`.
 *   Draft batches remain linked with their `linked_quantity` and `batch_name`, but return
 *   `is_trace_public: false` and `trace_url: null` (never exposing draft QR tokens or draft journal entries).
 * - Anti-IDOR (`SEC-06`): non-owner Buyer, other/unassigned Artisan, and missing IDs all fail
 *   with `AllocationNotFoundError` (HTTP 404 `RESOURCE_NOT_FOUND`).
 */
export class GetAllocationBatchesUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly allocationRepo: IAllocationRepository,
    private readonly allocationBatchRepo: IAllocationBatchRepository,
    private readonly quoteRequestRepo?: IQuoteRequestRepository,
  ) {}

  async execute(
    command: GetAllocationBatchesCommand,
  ): Promise<HttpResult<readonly AllocationBatchDto[]>> {
    // 1. Enforce normal session level (SEC-05)
    assertTradingNormalSession(
      command.actor,
      'Temporary password session cannot access allocation batches.',
    );

    // 2. Validate path :id (positive 64-bit decimal integer)
    const rawId = command.id ?? command.allocationId ?? '';
    const allocationId = EntityId.of(rawId, 'id').value;

    // 3. Validate pagination bounds (SEC-14)
    const page = command.query?.page ?? command.page ?? PAGINATION.defaultPage;
    const limit =
      command.query?.limit ?? command.limit ?? PAGINATION.defaultLimit;

    if (!Number.isSafeInteger(page) || page < 1) {
      throw new InvalidTradingInputError(
        'page must be a positive integer greater than or equal to 1.',
        { field: 'page' },
      );
    }
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > PAGINATION.maxLimit
    ) {
      throw new InvalidTradingInputError(
        `limit must be an integer between 1 and ${PAGINATION.maxLimit}.`,
        { field: 'limit' },
      );
    }

    // 4. Pre-query actor role and workshop check (SEC-06)
    let artisanWorkshopId: Id | undefined;
    if (command.actor.role === 'artisan') {
      if (!command.actor.workshopId) {
        throw new TradingPermissionDeniedError(
          'Artisan actor must belong to a workshop.',
        );
      }
      artisanWorkshopId = EntityId.of(
        command.actor.workshopId,
        'workshopId',
      ).value;
    } else if (
      command.actor.role !== 'admin' &&
      command.actor.role !== 'buyer'
    ) {
      throw new TradingPermissionDeniedError('Unauthorized trading role.');
    }

    // 5. Authorize Allocation ownership & fetch paginated AllocationBatchDto rows
    const executeInTx = async (tx: TransactionContext) => {
      const detail =
        typeof this.allocationRepo.findDetailById === 'function'
          ? await this.allocationRepo.findDetailById(allocationId, tx)
          : undefined;

      if (detail !== undefined) {
        if (!detail) {
          throw new AllocationNotFoundError('Allocation was not found.');
        }

        if (command.actor.role === 'buyer') {
          if (detail.requestBuyerId !== command.actor.accountId) {
            throw new AllocationNotFoundError('Allocation was not found.');
          }
        } else if (command.actor.role === 'artisan') {
          if (detail.allocation.workshop.id !== artisanWorkshopId) {
            throw new AllocationNotFoundError('Allocation was not found.');
          }
        }
      } else {
        const allocation = await this.allocationRepo.findById(allocationId, tx);
        if (!allocation) {
          throw new AllocationNotFoundError('Allocation was not found.');
        }

        if (command.actor.role === 'artisan') {
          if (allocation.workshop_id !== artisanWorkshopId) {
            throw new AllocationNotFoundError('Allocation was not found.');
          }
        } else if (command.actor.role === 'buyer') {
          if (!this.quoteRequestRepo) {
            throw new AllocationNotFoundError('Allocation was not found.');
          }
          const request = await this.quoteRequestRepo.findById(
            allocation.request_id,
            tx,
          );
          if (!request || request.buyer_id !== command.actor.accountId) {
            throw new AllocationNotFoundError('Allocation was not found.');
          }
        }
      }

      return this.allocationBatchRepo.findBatchesWithPagination(
        {
          allocationId,
          page,
          limit,
        },
        tx,
      );
    };

    const result = command.tx
      ? await executeInTx(command.tx)
      : await this.txRunner.run(executeInTx);

    return HttpResult.paginated(result.rows, result.totalRecords, {
      page,
      limit,
    });
  }
}
