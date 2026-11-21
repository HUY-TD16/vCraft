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
  EntityId,
  InvalidTradingInputError,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../domain';
import type {
  IAllocationRepository,
  IQuoteRequestRepository,
} from '../../ports/repositories/trading-repositories.port';
import type { AllocationDto } from '../../dtos/trading-persistence.dtos';

export interface ListQuoteRequestAllocationsQueryInput {
  readonly status?: string;
  readonly page?: number;
  readonly limit?: number;
}

export interface ListQuoteRequestAllocationsCommand {
  readonly actor: AuthenticatedActor;
  readonly requestId: string;
  readonly query?: ListQuoteRequestAllocationsQueryInput;
  readonly page?: number;
  readonly limit?: number;
}

/**
 * Use Case UC-23 (`BR-04`, `BR-20`, `BR-24`, `SEC-05`, `SEC-06`):
 * Lists allocations for a QuoteRequest with role-scoped visibility.
 * - Owner Buyer and Admin see all allocations for the request.
 * - Assigned Artisan sees ONLY their own workshop's allocation,
 *   and pagination.total_records counts ONLY their own allocation (1) via DB-level scoping.
 * - Non-owner Buyer and Artisan without an allocation on this request receive 404 RESOURCE_NOT_FOUND (anti-IDOR).
 */
export class ListQuoteRequestAllocationsUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly allocationRepo: IAllocationRepository,
  ) {}

  async execute(
    command: ListQuoteRequestAllocationsCommand,
  ): Promise<HttpResult<readonly AllocationDto[]>> {
    // 1. Enforce normal session level (SEC-05)
    assertTradingNormalSession(
      command.actor,
      'Temporary password session cannot access quote request allocations.',
    );

    // 2. Validate path :id and pagination bounds
    const requestId = EntityId.of(command.requestId, 'id').value;
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

    // 3. Authorize actor and execute DB-scoped query inside transaction runner
    const allocationsResult = await this.txRunner.run(
      async (tx: TransactionContext) => {
        const request = await this.quoteRequestRepo.findById(requestId, tx);

        if (!request) {
          throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
        }

        let scopedWorkshopId: Id | undefined;

        if (command.actor.role === 'admin') {
          scopedWorkshopId = undefined;
        } else if (command.actor.role === 'buyer') {
          // SEC-06 anti-IDOR: non-owner Buyer receives 404 RESOURCE_NOT_FOUND
          if (request.buyer_id !== command.actor.accountId) {
            throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
          }
          scopedWorkshopId = undefined;
        } else if (command.actor.role === 'artisan') {
          if (!command.actor.workshopId) {
            throw new TradingPermissionDeniedError(
              'Artisan actor must belong to an active workshop.',
            );
          }

          const workshopId = EntityId.of(
            command.actor.workshopId,
            'workshopId',
          ).value;
          const ownAllocation =
            await this.allocationRepo.findByRequestAndWorkshop(
              requestId,
              workshopId,
              tx,
            );

          // SEC-06 anti-IDOR: Artisan without allocation receives 404 RESOURCE_NOT_FOUND
          if (!ownAllocation) {
            throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
          }

          // BR-04 / SEC-06: scope query and COUNT(*) strictly to caller's workshop
          scopedWorkshopId = workshopId;
        } else {
          throw new TradingPermissionDeniedError('Unauthorized trading role.');
        }

        return this.allocationRepo.findAllocationsWithDetails(
          {
            requestId,
            workshopId: scopedWorkshopId,
            status: command.query?.status,
            page,
            limit,
          },
          tx,
        );
      },
    );

    return HttpResult.paginated(
      allocationsResult.rows,
      allocationsResult.totalRecords,
      {
        page,
        limit,
      },
    );
  }
}
