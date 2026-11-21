import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
  TrustedActor,
} from '../../../../../common/application/types/contract-types';
import { QuoteRequestMapper } from '../../mappers/quote-request.mapper';
import {
  EntityId,
  InvalidTradingInputError,
  QuoteRequestNotFoundError,
  Version,
} from '../../../domain';
import type {
  BuyerRequestDto,
  TradingCurrentStateDto,
} from '../../dtos/trading-persistence.dtos';
import { assertTradingActor } from '../../helpers/trading-actor.helper';
import type { IQuoteRequestRepository } from '../../ports/repositories/trading-repositories.port';

export interface CancelQuoteRequestByBuyerInput {
  readonly actor: AuthenticatedActor | TrustedActor;
  readonly requestId?: Id;
  readonly id?: Id;
  readonly expectedRequestVersion?: number;
  readonly expected_request_version?: number;
  readonly cancelReason?: string | null;
  readonly cancel_reason?: string | null;
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export interface CancelQuoteRequestByBuyerResult {
  readonly request: BuyerRequestDto;
  readonly data: BuyerRequestDto;
  readonly currentState: TradingCurrentStateDto;
}

/**
 * Use Case UC-27 (`BR-03`, `BR-21`, `BR-22`, `BR-23`, `BR-26`, `BR-27`, `SEC-05`, `SEC-06`, `SEC-13`):
 * Allows the owning Buyer to cancel a QuoteRequest before acceptance
 * (`POST /api/v1/buyer/quote-requests/:id/cancel`):
 * - Verifies Buyer role, normal session level, and QuoteRequest ownership (anti-IDOR 404).
 * - Locks the QuoteRequest row (`SELECT ... FOR UPDATE`) to serialize against accept/close/quote mutations.
 * - Allows cancellation ONLY when status is `sent_to_artisans` or `artisans_bidding` and not already cancelled.
 *   Draft requests must be deleted via DELETE; post-acceptance requests (`buyer_accepted`, `in_production`)
 *   can only be cancelled by Admin; `delivered` requests can never be cancelled.
 * - Preserves primary `status` (no 7th `cancelled` enum value), records `cancelled_at`, `cancelled_by`,
 *   optional `cancel_reason`, closes bidding (`bidding_closed_at`), increments `version`, and persists
 *   `StatusLog('cancelled')` with `prev_status = new_status` atomically in the same transaction.
 * - Preserves all existing quotes, recipients, and historical records for auditability (BR-22).
 */
export class CancelQuoteRequestByBuyerUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
  ) {}

  async execute(
    input: CancelQuoteRequestByBuyerInput,
  ): Promise<CancelQuoteRequestByBuyerResult> {
    assertTradingActor(input.actor, {
      expectedRole: 'buyer',
      tempPasswordMessage:
        'Temporary password session cannot cancel quote requests.',
      roleDeniedMessage:
        'Only buyers can cancel quote requests via the buyer cancel endpoint.',
    });

    const actorId = EntityId.of(input.actor.accountId, 'accountId').value;

    const rawRequestId = input.requestId ?? input.id;
    if (!rawRequestId) {
      throw new InvalidTradingInputError('requestId is required.', {
        field: 'id',
      });
    }
    const requestId = EntityId.of(rawRequestId, 'id').value;

    const rawExpectedVersion =
      input.expectedRequestVersion ?? input.expected_request_version;
    if (rawExpectedVersion === undefined || rawExpectedVersion === null) {
      throw new InvalidTradingInputError(
        'expected_request_version is required to cancel a quote request.',
        { field: 'expected_request_version' },
      );
    }
    const expectedVersion = Version.of(
      rawExpectedVersion,
      'expected_request_version',
    ).value;

    const cancelReason =
      input.cancelReason !== undefined
        ? input.cancelReason
        : input.cancel_reason;

    const runWithTx = async (
      tx: TransactionContext,
    ): Promise<CancelQuoteRequestByBuyerResult> => {
      const lockedRequest = await this.quoteRequestRepo.lockById(requestId, tx);
      if (!lockedRequest || lockedRequest.buyer_id !== actorId) {
        throw new QuoteRequestNotFoundError('QuoteRequest was not found.', {
          entity: 'QuoteRequest',
          id: requestId,
        });
      }

      const now = input.now ?? new Date();
      const { request: cancelledRequest, statusLogs } = lockedRequest.cancel({
        actorId,
        actorRole: 'buyer',
        expectedVersion,
        cancelReason,
        now,
      });

      const savedRequest = await this.quoteRequestRepo.update(
        {
          request: cancelledRequest,
          expectedVersion,
          statusLogs,
        },
        tx,
      );

      const detail =
        typeof this.quoteRequestRepo.findDetailById === 'function'
          ? await this.quoteRequestRepo.findDetailById(savedRequest.id, tx)
          : null;

      const buyerRequestDto =
        QuoteRequestMapper.fromDetailOrEntityToBuyerOrAdminDto({
          detail,
          fallbackEntity: savedRequest,
          now,
        });

      const currentState: TradingCurrentStateDto = Object.freeze({
        request: Object.freeze({
          id: savedRequest.id,
          status: savedRequest.status,
          version: savedRequest.version,
          cancelled_at: savedRequest.cancelled_at
            ? savedRequest.cancelled_at.toISOString()
            : null,
        }),
      });

      return Object.freeze({
        request: buyerRequestDto,
        data: buyerRequestDto,
        currentState,
      });
    };

    if (input.tx) {
      return runWithTx(input.tx);
    }

    return this.txRunner.run((tx) => runWithTx(tx));
  }
}
