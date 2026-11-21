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
  type QuoteRequest,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
  Version,
} from '../../../domain';
import type {
  BuyerRequestDto,
  CategoryRefDto,
  DeliveryConfirmationDto,
  TradingCurrentStateDto,
} from '../../dtos/trading-persistence.dtos';
import type {
  IAllocationRepository,
  IQuoteRequestRepository,
} from '../../ports/repositories/trading-repositories.port';

export interface ConfirmDeliveryInput {
  readonly actor: AuthenticatedActor | TrustedActor;
  readonly requestId?: Id;
  readonly id?: Id;
  readonly expectedRequestVersion?: number;
  readonly expected_request_version?: number;
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export interface ConfirmDeliveryResult {
  readonly request: BuyerRequestDto;
  readonly data: BuyerRequestDto;
  readonly currentState: TradingCurrentStateDto;
}

/**
 * Use Case UC-25 (`BR-03`, `BR-25`, `BR-26`, `BR-27`, `SEC-05`, `SEC-06`, `SEC-13`):
 * Allows the owning Buyer to confirm full delivery for a QuoteRequest
 * (`POST /api/v1/buyer/quote-requests/:id/confirm-delivery`):
 * - Verifies Buyer role, normal session level, and QuoteRequest ownership (anti-IDOR 404).
 * - Acquires locks in canonical order (`QuoteRequest -> Allocation`, sorted by `id ASC`).
 * - Verifies `QuoteRequest` is in `in_production`, not cancelled, and matches `expected_request_version`.
 * - Verifies at least one `Allocation` exists and ALL `Allocation` records are in `handed_over` status.
 * - Transitions `QuoteRequest` from `in_production` to `delivered`, increments `version`,
 *   and records `StatusLog('received_by_buyer')` atomically in the same transaction.
 */
export class ConfirmDeliveryUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly allocationRepo: IAllocationRepository,
  ) {}

  async execute(input: ConfirmDeliveryInput): Promise<ConfirmDeliveryResult> {
    if (
      'sessionLevel' in input.actor &&
      input.actor.sessionLevel === 'temp_password'
    ) {
      throw new TradingDomainError(
        'TEMP_PASSWORD_RESTRICTED',
        'Temporary password session cannot confirm delivery.',
      );
    }

    if (input.actor.role !== 'buyer') {
      throw new TradingPermissionDeniedError(
        'Only buyers can confirm full delivery on quote requests.',
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
        'expected_request_version is required to confirm delivery.',
        { field: 'expected_request_version' },
      );
    }
    const expectedVersion = Version.of(
      rawExpectedVersion,
      'expected_request_version',
    ).value;

    const runWithTx = async (
      tx: TransactionContext,
    ): Promise<ConfirmDeliveryResult> => {
      // Mandatory lock ordering (data-design.md §4.2, TradingLockOrderingPolicy):
      // 1. QuoteRequest -> 2. Allocation (ordered by id ASC)
      const lockedRequest = await this.quoteRequestRepo.lockById(requestId, tx);
      if (!lockedRequest || lockedRequest.buyer_id !== actorId) {
        throw new QuoteRequestNotFoundError('QuoteRequest was not found.', {
          entity: 'QuoteRequest',
          id: requestId,
        });
      }

      const lockedAllocations = await this.allocationRepo.lockByRequestId(
        lockedRequest.id,
        tx,
      );

      const now = input.now ?? new Date();
      const { request: updatedRequest, statusLog } =
        lockedRequest.confirmDelivered({
          actorId,
          actorRole: 'buyer',
          expectedVersion,
          allocationStatuses: lockedAllocations.map((a) => a.status),
          now,
        });

      const savedRequest = await this.quoteRequestRepo.update(
        {
          request: updatedRequest,
          expectedVersion,
          statusLogs: [statusLog],
        },
        tx,
      );

      const fallbackConfirmation: DeliveryConfirmationDto = Object.freeze({
        performed_by: Object.freeze({
          id: actorId,
          display_name: null,
        }),
        performed_at: statusLog.created_at.toISOString(),
        is_admin_action: false,
        reason: null,
        evidence: null,
      });

      const detail =
        typeof this.quoteRequestRepo.findDetailById === 'function'
          ? await this.quoteRequestRepo.findDetailById(savedRequest.id, tx)
          : null;

      let buyerRequestDto: BuyerRequestDto;
      if (detail) {
        const deliveryLog = detail.statusLogs.find(
          (log) =>
            log.entity.event_type === 'received_by_buyer' ||
            log.entity.event_type === 'received_by_admin',
        );
        const deliveryConfirmation: DeliveryConfirmationDto = deliveryLog
          ? Object.freeze({
              performed_by: deliveryLog.performedBy ?? {
                id: deliveryLog.entity.performed_by ?? actorId,
                display_name: null,
              },
              performed_at: (deliveryLog.entity.created_at instanceof Date
                ? deliveryLog.entity.created_at
                : new Date(deliveryLog.entity.created_at)
              ).toISOString(),
              is_admin_action: deliveryLog.entity.is_admin_action,
              reason: deliveryLog.entity.note,
              evidence: deliveryLog.entity.evidence,
            })
          : fallbackConfirmation;

        buyerRequestDto = this.toBuyerRequestDto(detail.entity, {
          category: detail.category,
          now,
          deliveryConfirmation,
        });
      } else {
        buyerRequestDto = this.toBuyerRequestDto(savedRequest, {
          category: savedRequest.category_id
            ? { id: savedRequest.category_id, name: '' }
            : null,
          now,
          deliveryConfirmation: fallbackConfirmation,
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

  private toBuyerRequestDto(
    entity: QuoteRequest,
    context: {
      readonly category: CategoryRefDto | null;
      readonly now: Date;
      readonly deliveryConfirmation: DeliveryConfirmationDto | null;
    },
  ): BuyerRequestDto {
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
      delivery_confirmation: context.deliveryConfirmation,
    });
  }
}
