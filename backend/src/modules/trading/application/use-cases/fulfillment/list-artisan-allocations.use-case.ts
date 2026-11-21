import { resolveTradingPagination } from '../../helpers/trading-pagination.helper';
import { assertTradingActor } from '../../helpers/trading-actor.helper';
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
  ALLOCATION_STATUSES,
  type AllocationStatus,
  EntityId,
  InvalidTradingInputError,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../domain';
import type {
  FindArtisanAllocationsInput,
  IAllocationRepository,
} from '../../ports/repositories/trading-repositories.port';
import type { AllocationDto } from '../../dtos/trading-persistence.dtos';

export interface ListArtisanAllocationsQueryInput {
  readonly status?: string;
  readonly delivery_deadline?: string;
  readonly committed_delivery_at?: string;
  readonly request_id?: string;
  readonly page?: number;
  readonly limit?: number;
}

export interface ListArtisanAllocationsCommand {
  readonly actor: AuthenticatedActor;
  readonly query?: ListArtisanAllocationsQueryInput;
  readonly page?: number;
  readonly limit?: number;
}

/**
 * Use Case UC-23 (`BR-04`, `BR-05`, `BR-20`, `BR-24`, `SEC-05`, `SEC-06`):
 * Lists allocations belonging to the authenticated artisan's workshop.
 * - Zero-IDOR: queries are strictly filtered by workshop_id = actor.workshopId.
 * - Temporary password sessions are rejected with TEMP_PASSWORD_RESTRICTED (SEC-05).
 * - Filterable by status ('not_started', 'in_production', 'handed_over') and delivery deadline.
 */
export class ListArtisanAllocationsUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly allocationRepo: IAllocationRepository,
  ) {}

  async execute(
    command: ListArtisanAllocationsCommand,
  ): Promise<HttpResult<readonly AllocationDto[]>> {
    // 1. Enforce normal session level (SEC-05)
    assertTradingActor(command.actor, {
      expectedRole: 'artisan',
      tempPasswordMessage: 'Temporary password session cannot access artisan allocations.',
      roleDeniedMessage: 'Only artisans can view workshop allocations.',
      requireWorkshop: true,
      workshopDeniedMessage: 'Artisan actor must belong to an active workshop.',
    });

    const workshopId = EntityId.of(
      command.actor.workshopId,
      'workshopId',
    ).value;

    // 3. Validate pagination bounds
    const { page, limit } = resolveTradingPagination(command);

    // 4. Validate query filters
    let statusFilter: AllocationStatus | undefined;
    if (command.query?.status !== undefined && command.query.status !== null && command.query.status !== '') {
      if (!ALLOCATION_STATUSES.includes(command.query.status as AllocationStatus)) {
        throw new InvalidTradingInputError(
          `Invalid allocation status "${command.query.status}". Allowed values: ${ALLOCATION_STATUSES.join(', ')}.`,
          { field: 'status' },
        );
      }
      statusFilter = command.query.status as AllocationStatus;
    }

    let deliveryDeadline: Date | undefined;
    const rawDeadline =
      command.query?.delivery_deadline ?? command.query?.committed_delivery_at;
    if (rawDeadline !== undefined && rawDeadline !== null && rawDeadline !== '') {
      const parsedDate = new Date(rawDeadline);
      if (Number.isNaN(parsedDate.getTime())) {
        throw new InvalidTradingInputError(
          'delivery_deadline must be a valid ISO date or date-time string.',
          { field: 'delivery_deadline' },
        );
      }
      deliveryDeadline = parsedDate;
    }

    let requestIdFilter: Id | undefined;
    if (
      command.query?.request_id !== undefined &&
      command.query.request_id !== null &&
      command.query.request_id !== ''
    ) {
      requestIdFilter = EntityId.of(command.query.request_id, 'request_id').value;
    }

    // 5. Execute DB-scoped query inside transaction runner
    const repoInput: FindArtisanAllocationsInput = {
      workshopId,
      status: statusFilter,
      deliveryDeadline,
      requestId: requestIdFilter,
      page,
      limit,
    };

    const allocationsResult = await this.txRunner.run(
      async (tx: TransactionContext) => {
        return this.allocationRepo.findArtisanAllocations(repoInput, tx);
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
