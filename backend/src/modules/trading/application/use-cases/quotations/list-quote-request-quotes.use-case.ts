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
  IQuoteRepository,
  IQuoteRequestRepository,
  IRequestRecipientRepository,
} from '../../ports/repositories/trading-repositories.port';
import type { QuoteDto } from '../../dtos/trading-persistence.dtos';

export interface ListQuoteRequestQuotesQueryInput {
  readonly page?: number;
  readonly limit?: number;
}

export interface ListQuoteRequestQuotesCommand {
  readonly actor: AuthenticatedActor;
  readonly requestId: string;
  readonly query?: ListQuoteRequestQuotesQueryInput;
  readonly page?: number;
  readonly limit?: number;
}

/**
 * Use Case UC-18 (`BR-04`, `BR-05`, `BR-14`, `BR-15`, `BR-21`, `BR-22`, `SEC-05`, `SEC-06`):
 * Lists quotes for a QuoteRequest with role-scoped visibility and live server-time eligibility evaluation.
 * - Owner Buyer and Admin see all quotes for the request.
 * - Invited Artisan (present in RequestRecipient) sees ONLY their own workshop's quote,
 *   and pagination.total_records counts ONLY their own quote (0 or 1) via DB-level scoping.
 * - Non-owner Buyer and uninvited Artisan receive 404 RESOURCE_NOT_FOUND (anti-IDOR).
 */
export class ListQuoteRequestQuotesUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly recipientRepo: IRequestRecipientRepository,
    private readonly quoteRepo: IQuoteRepository,
  ) {}

  async execute(
    command: ListQuoteRequestQuotesCommand,
  ): Promise<HttpResult<readonly QuoteDto[]>> {
    // 1. Enforce normal session level (SEC-05)
    assertTradingNormalSession(
      command.actor,
      'Temporary password session cannot access quote request quotes.',
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
    const { quoteRequest, quotesResult } = await this.txRunner.run(
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
          const recipient = await this.recipientRepo.findByRequestAndWorkshop(
            requestId,
            workshopId,
            tx,
          );

          // SEC-06 anti-IDOR: uninvited Artisan receives 404 RESOURCE_NOT_FOUND
          if (!recipient) {
            throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
          }

          // BR-04 / SEC-06: scope query and COUNT(*) strictly to caller's workshop
          scopedWorkshopId = workshopId;
        } else {
          throw new TradingPermissionDeniedError('Unauthorized trading role.');
        }

        const queryResult = await this.quoteRepo.findQuotesWithDetails(
          {
            requestId,
            workshopId: scopedWorkshopId,
            page,
            limit,
          },
          tx,
        );

        return {
          quoteRequest: request,
          quotesResult: queryResult,
        };
      },
    );

    // 4. Evaluate real-time eligibility and map to strict frozen QuoteDto allowlist
    const now = new Date();
    const dtos: readonly QuoteDto[] = quotesResult.rows.map((item) => {
      const evaluation = item.entity.evaluateEligibility({
        request: quoteRequest,
        workshopIsActive: item.workshop.status === 'active',
        now,
      });

      return Object.freeze({
        id: item.entity.id,
        request_id: item.entity.request_id,
        workshop: Object.freeze({
          id: item.workshop.id,
          name: item.workshop.name,
        }),
        unit_price: item.entity.unit_price,
        max_quantity: item.entity.max_quantity,
        bid_accept_deadline: item.entity.bid_accept_deadline.toISOString(),
        committed_delivery_at: item.entity.committed_delivery_at.toISOString(),
        status: item.entity.status,
        version: item.entity.version,
        withdraw_reason: item.entity.withdraw_reason,
        withdrawn_at: item.entity.withdrawn_at
          ? item.entity.withdrawn_at.toISOString()
          : null,
        is_eligible: evaluation.is_eligible,
        ineligible_reasons: Object.freeze([...evaluation.ineligible_reasons]),
        created_at: item.entity.created_at.toISOString(),
        updated_at: item.entity.updated_at.toISOString(),
      });
    });

    return HttpResult.paginated(dtos, quotesResult.totalRecords, {
      page,
      limit,
    });
  }
}
