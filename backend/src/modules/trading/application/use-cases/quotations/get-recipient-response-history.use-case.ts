import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import { PAGINATION } from '../../../../../common/application/types/pagination';
import type { AuthenticatedActor } from '../../../../../common/application/types/contract-types';
import { HttpResult } from '../../../../../common/http/interceptors/response-envelope.interceptor';
import {
  EntityId,
  InvalidTradingInputError,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
  TradingResourceNotFoundError,
} from '../../../domain';
import type {
  IQuoteRequestRepository,
  IRecipientResponseHistoryRepository,
  IRequestRecipientRepository,
} from '../../ports/repositories/trading-repositories.port';
import type { RecipientEventDto } from '../../dtos/trading-persistence.dtos';

export interface GetRecipientResponseHistoryQueryInput {
  readonly page?: number;
  readonly limit?: number;
}

export interface GetRecipientResponseHistoryCommand {
  readonly actor: AuthenticatedActor;
  readonly requestId: string;
  readonly recipientId: string;
  readonly query?: GetRecipientResponseHistoryQueryInput;
  readonly page?: number;
  readonly limit?: number;
}

/**
 * Use Case UC-16 / UC-18 (`BR-04`, `BR-05`, `BR-13`, `BR-15`, `BR-21`, `BR-22`, `SEC-05`, `SEC-06`):
 * Retrieves paginated `RecipientResponseHistory` events for a specific `(QuoteRequest, RequestRecipient)` pair.
 * - Normal session required (`temp_password` -> `403 TEMP_PASSWORD_RESTRICTED`).
 * - Allowed callers: Admin, owning Buyer of `:id`, or Artisan whose `workshopId` owns `:recipientId`.
 * - Full chain integrity (`recipient.request_id === request.id`) and anti-IDOR ownership checks
 *   return `404 RESOURCE_NOT_FOUND` on missing/mismatched/unauthorized resources.
 */
export class GetRecipientResponseHistoryUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly recipientRepo: IRequestRecipientRepository,
    private readonly recipientResponseHistoryRepo: IRecipientResponseHistoryRepository,
  ) {}

  async execute(
    command: GetRecipientResponseHistoryCommand,
  ): Promise<HttpResult<readonly RecipientEventDto[]>> {
    // 1. Enforce normal session level (SEC-05)
    if (command.actor.sessionLevel === 'temp_password') {
      throw new TradingDomainError(
        'TEMP_PASSWORD_RESTRICTED',
        'Temporary password session cannot access recipient response history.',
      );
    }

    // 2. Validate path parameters and pagination bounds (400 INVALID_INPUT)
    const requestId = EntityId.of(command.requestId, 'id').value;
    const recipientId = EntityId.of(command.recipientId, 'recipientId').value;

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

    // 3. Execute chain verification, ownership checks, and paginated query in transaction
    const result = await this.txRunner.run(async (tx: TransactionContext) => {
      const request = await this.quoteRequestRepo.findById(requestId, tx);
      if (!request) {
        throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
      }

      let artisanWorkshopId: string | undefined;

      if (command.actor.role === 'admin') {
        // Admin may inspect any valid matching (:id, :recipientId) pair
      } else if (command.actor.role === 'buyer') {
        // SEC-06 anti-IDOR: non-owning Buyer receives 404 RESOURCE_NOT_FOUND
        if (request.buyer_id !== command.actor.accountId) {
          throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
        }
      } else if (command.actor.role === 'artisan') {
        if (!command.actor.workshopId) {
          throw new TradingPermissionDeniedError(
            'Artisan actor must belong to an active workshop.',
          );
        }
        artisanWorkshopId = EntityId.of(
          command.actor.workshopId,
          'workshopId',
        ).value;
      } else {
        throw new TradingPermissionDeniedError('Unauthorized trading role.');
      }

      const recipient = await this.recipientRepo.findById(recipientId, tx);
      // SEC-06 chain check: recipient must exist AND belong to :id
      if (!recipient || recipient.request_id !== requestId) {
        throw new TradingResourceNotFoundError(
          'Recipient was not found for this quote request.',
          { entity: 'RequestRecipient', id: recipientId },
        );
      }

      // BR-04 / SEC-06 anti-IDOR: Artisan may only view their own workshop's recipient history
      if (
        command.actor.role === 'artisan' &&
        recipient.workshop_id !== artisanWorkshopId
      ) {
        throw new TradingResourceNotFoundError(
          'Recipient was not found for this quote request.',
          { entity: 'RequestRecipient', id: recipientId },
        );
      }

      return this.recipientResponseHistoryRepo.findEventsWithPagination(
        {
          recipientId,
          page,
          limit,
        },
        tx,
      );
    });

    return HttpResult.paginated(result.rows, result.totalRecords, {
      page,
      limit,
    });
  }
}
