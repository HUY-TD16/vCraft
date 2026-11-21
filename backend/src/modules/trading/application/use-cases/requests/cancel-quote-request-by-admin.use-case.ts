import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
  TrustedActor,
} from '../../../../../common/application/types/contract-types';
import {
  EntityId,
  InvalidTradingInputError,
  MAX_CANCEL_REASON_LENGTH,
  type QuoteRequest,
  QuoteRequestNotFoundError,
  TRADING_INVARIANTS,
  TradingDomainError,
  TradingPermissionDeniedError,
  Version,
} from '../../../domain';
import type {
  AdminRequestDto,
  CategoryRefDto,
  TradingCurrentStateDto,
} from '../../dtos/trading-persistence.dtos';
import type { IQuoteRequestRepository } from '../../ports/repositories/trading-repositories.port';

export interface CancelQuoteRequestByAdminInput {
  readonly actor: AuthenticatedActor | TrustedActor;
  readonly requestId?: Id;
  readonly id?: Id;
  readonly expectedRequestVersion?: number;
  readonly expected_request_version?: number;
  readonly cancelReason?: string | null;
  readonly cancel_reason?: string | null;
  readonly goodsHandlingNote?: string | null;
  readonly goods_handling_note?: string | null;
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export interface CancelQuoteRequestByAdminResult {
  readonly request: AdminRequestDto;
  readonly data: AdminRequestDto;
  readonly currentState: TradingCurrentStateDto;
}

/**
 * Use Case UC-27 (`BR-21`, `BR-22`, `BR-26`, `BR-27`, `SEC-05`, `SEC-06`, `SEC-13`):
 * Allows an Admin to cancel a post-acceptance QuoteRequest due to force majeure
 * (`POST /api/v1/admin/quote-requests/:id/cancel-by-admin`):
 * - Verifies Admin role and normal session level (rejects `temp_password` and non-admin roles).
 * - Requires non-empty `cancel_reason` and `goods_handling_note` (max 10,000 chars each)
 *   recording the reason for stopping and offline handling of any handed-over goods.
 * - Locks the QuoteRequest row (`SELECT ... FOR UPDATE`) to serialize atomically against
 *   allocation production/handover, buyer delivery confirmation, contact edits, and concurrent cancellations.
 * - Allows cancellation ONLY when status is `buyer_accepted` or `in_production` and not already cancelled
 *   (including when all Allocations are `handed_over` but delivery has not been confirmed yet).
 *   Rejects `draft_request`, `sent_to_artisans`, `artisans_bidding`, `delivered`, and already-cancelled requests.
 * - Preserves primary `status` (no 7th `cancelled` enum value), records `cancelled_at`, `cancelled_by`,
 *   `cancel_reason`, increments `version`, and persists `StatusLog('cancelled')` with
 *   `prev_status = new_status`, `is_admin_action = true`, `note = cancel_reason`, and
 *   `evidence = goods_handling_note` atomically in the same transaction.
 * - Preserves all existing quotes, recipients, allocations, batch links, and logs without resetting progress (`BR-22`);
 *   once cancelled, `QuoteRequest.assertNotCancelled()` blocks all subsequent business mutations.
 */
export class CancelQuoteRequestByAdminUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
  ) {}

  async execute(
    input: CancelQuoteRequestByAdminInput,
  ): Promise<CancelQuoteRequestByAdminResult> {
    if (
      'sessionLevel' in input.actor &&
      input.actor.sessionLevel === 'temp_password'
    ) {
      throw new TradingDomainError(
        'TEMP_PASSWORD_RESTRICTED',
        'Temporary password session cannot cancel quote requests.',
      );
    }

    if (input.actor.role !== 'admin') {
      throw new TradingPermissionDeniedError(
        'Only admins can cancel post-acceptance quote requests via the admin cancel endpoint.',
      );
    }

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

    const rawCancelReason =
      input.cancelReason !== undefined
        ? input.cancelReason
        : input.cancel_reason;
    const cancelReason =
      typeof rawCancelReason === 'string' ? rawCancelReason.trim() : '';
    if (cancelReason.length === 0) {
      throw new InvalidTradingInputError(
        'Admin cancellation requires a non-empty cancel_reason.',
        {
          field: 'cancel_reason',
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
        },
      );
    }
    if (cancelReason.length > MAX_CANCEL_REASON_LENGTH) {
      throw new InvalidTradingInputError(
        `cancel_reason cannot exceed ${MAX_CANCEL_REASON_LENGTH} characters.`,
        {
          field: 'cancel_reason',
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
        },
      );
    }

    const rawGoodsHandlingNote =
      input.goodsHandlingNote !== undefined
        ? input.goodsHandlingNote
        : input.goods_handling_note;
    const goodsHandlingNote =
      typeof rawGoodsHandlingNote === 'string'
        ? rawGoodsHandlingNote.trim()
        : '';
    if (goodsHandlingNote.length === 0) {
      throw new InvalidTradingInputError(
        'Admin cancellation requires a non-empty goods_handling_note.',
        {
          field: 'goods_handling_note',
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
        },
      );
    }
    if (goodsHandlingNote.length > MAX_CANCEL_REASON_LENGTH) {
      throw new InvalidTradingInputError(
        `goods_handling_note cannot exceed ${MAX_CANCEL_REASON_LENGTH} characters.`,
        {
          field: 'goods_handling_note',
          invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
        },
      );
    }

    const runWithTx = async (
      tx: TransactionContext,
    ): Promise<CancelQuoteRequestByAdminResult> => {
      const lockedRequest = await this.quoteRequestRepo.lockById(requestId, tx);
      if (!lockedRequest) {
        throw new QuoteRequestNotFoundError('QuoteRequest was not found.', {
          entity: 'QuoteRequest',
          id: requestId,
        });
      }

      const now = input.now ?? new Date();
      const { request: cancelledRequest, statusLogs } = lockedRequest.cancel({
        actorId,
        actorRole: 'admin',
        expectedVersion,
        cancelReason,
        goodsHandlingNote,
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

      const adminRequestDto = detail
        ? this.toAdminRequestDto(detail.entity, {
            category: detail.category,
            now,
          })
        : this.toAdminRequestDto(savedRequest, {
            category: savedRequest.category_id
              ? { id: savedRequest.category_id, name: '' }
              : null,
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
        request: adminRequestDto,
        data: adminRequestDto,
        currentState,
      });
    };

    if (input.tx) {
      return runWithTx(input.tx);
    }

    return this.txRunner.run((tx) => runWithTx(tx));
  }

  private toAdminRequestDto(
    entity: QuoteRequest,
    context: {
      readonly category: CategoryRefDto | null;
      readonly now: Date;
    },
  ): AdminRequestDto {
    return Object.freeze({
      id: entity.id,
      status: entity.status,
      version: entity.version,
      category: context.category,
      spec: entity.spec,
      quantity: entity.quantity,
      unit: entity.unit,
      unit_set_description: entity.unit_set_description,
      delivery_mode: entity.delivery_mode,
      delivery_region: entity.delivery_region,
      bidding_deadline: entity.bidding_deadline
        ? entity.bidding_deadline.toISOString()
        : null,
      delivery_deadline: entity.delivery_deadline
        ? entity.delivery_deadline.toISOString()
        : null,
      bidding_closed_at: entity.bidding_closed_at
        ? entity.bidding_closed_at.toISOString()
        : null,
      is_bidding_open: entity.isBiddingOpenAt(context.now),
      cancelled_at: entity.cancelled_at
        ? entity.cancelled_at.toISOString()
        : null,
      created_at: entity.created_at.toISOString(),
      updated_at: entity.updated_at.toISOString(),
      buyer_id: entity.buyer_id,
      recipient_name: entity.recipient_name,
      recipient_phone: entity.recipient_phone,
      delivery_address: entity.delivery_address,
      cancel_reason: entity.cancel_reason,
      split_requested_at: null,
      coordination_state: null,
      no_valid_quotes: false,
      nearest_accept_deadline: null,
      delivery_confirmation: null,
    });
  }
}
