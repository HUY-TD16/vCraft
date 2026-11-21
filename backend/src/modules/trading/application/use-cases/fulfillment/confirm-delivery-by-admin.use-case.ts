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
  MAX_ADMIN_CONFIRM_DELIVERY_TEXT_LENGTH,
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
  DeliveryConfirmationDto,
  TradingCurrentStateDto,
} from '../../dtos/trading-persistence.dtos';
import type {
  IAllocationRepository,
  IQuoteRequestRepository,
} from '../../ports/repositories/trading-repositories.port';

export interface ConfirmDeliveryByAdminInput {
  readonly actor: AuthenticatedActor | TrustedActor;
  readonly requestId?: Id;
  readonly id?: Id;
  readonly expectedRequestVersion?: number;
  readonly expected_request_version?: number;
  readonly reason?: string | null;
  readonly evidence?: string | null;
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export interface ConfirmDeliveryByAdminResult {
  readonly request: AdminRequestDto;
  readonly data: AdminRequestDto;
  readonly currentState: TradingCurrentStateDto;
}

/**
 * Use Case UC-26 (`BR-25`, `BR-26`, `BR-27`, `SEC-01`, `SEC-05`, `SEC-06`, `SEC-13`, `AT-14`):
 * Allows an Admin to confirm full delivery on behalf of a Buyer when verified evidence exists
 * (`POST /api/v1/admin/quote-requests/:id/confirm-delivery-by-admin`):
 * - Verifies Admin role and `normal` session level (rejects `temp_password` and non-admin roles).
 * - Requires non-empty `reason` and `evidence` (max 10,000 chars each; Buyer non-response alone is insufficient).
 * - Acquires row locks in canonical deadlock-free order (`data-design.md` §4.2, `TradingLockOrderingPolicy`):
 *   `QuoteRequest` -> `Allocation` (ordered by `id ASC`).
 * - Verifies `QuoteRequest` is strictly in `in_production`, not cancelled (`cancelled_at === null`),
 *   and matches `expected_request_version` (rejecting concurrent Buyer confirmation or Admin cancellation).
 * - Verifies at least one `Allocation` exists and ALL `Allocation` records are in `handed_over` status
 *   (whether recorded by Artisan or by Admin under `UC-24`; incomplete/missing batch traceability does NOT block).
 * - Transitions `QuoteRequest` from `in_production` to `delivered`, increments `version`,
 *   and records `StatusLog('received_by_admin')` with `is_admin_action = true`, `performed_by = adminId`
 *   (never impersonating Buyer), `note = reason`, and `evidence = evidence` atomically in the same transaction.
 * - Preserves any prior `AllocationLog('handover_by_admin')` events separately (`BR-25`).
 */
export class ConfirmDeliveryByAdminUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly allocationRepo: IAllocationRepository,
  ) {}

  async execute(
    input: ConfirmDeliveryByAdminInput,
  ): Promise<ConfirmDeliveryByAdminResult> {
    if (
      'sessionLevel' in input.actor &&
      input.actor.sessionLevel === 'temp_password'
    ) {
      throw new TradingDomainError(
        'TEMP_PASSWORD_RESTRICTED',
        'Temporary password session cannot confirm delivery on behalf of a buyer.',
      );
    }

    if (input.actor.role !== 'admin') {
      throw new TradingPermissionDeniedError(
        'Only admins can confirm full delivery on behalf of a buyer.',
      );
    }

    const adminId = EntityId.of(input.actor.accountId, 'accountId').value;

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
        'expected_request_version is required to confirm delivery by admin.',
        { field: 'expected_request_version' },
      );
    }
    const expectedVersion = Version.of(
      rawExpectedVersion,
      'expected_request_version',
    ).value;

    if (typeof input.reason !== 'string') {
      throw new InvalidTradingInputError(
        'Admin delivery confirmation requires a non-empty reason.',
        {
          field: 'reason',
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
        },
      );
    }
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new InvalidTradingInputError(
        'Admin delivery confirmation requires a non-empty reason.',
        {
          field: 'reason',
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
        },
      );
    }
    if (reason.length > MAX_ADMIN_CONFIRM_DELIVERY_TEXT_LENGTH) {
      throw new InvalidTradingInputError(
        `reason cannot exceed ${MAX_ADMIN_CONFIRM_DELIVERY_TEXT_LENGTH} characters.`,
        {
          field: 'reason',
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
        },
      );
    }

    if (typeof input.evidence !== 'string') {
      throw new InvalidTradingInputError(
        'Admin delivery confirmation requires non-empty evidence.',
        {
          field: 'evidence',
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
        },
      );
    }
    const evidence = input.evidence.trim();
    if (evidence.length === 0) {
      throw new InvalidTradingInputError(
        'Admin delivery confirmation requires non-empty evidence.',
        {
          field: 'evidence',
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
        },
      );
    }
    if (evidence.length > MAX_ADMIN_CONFIRM_DELIVERY_TEXT_LENGTH) {
      throw new InvalidTradingInputError(
        `evidence cannot exceed ${MAX_ADMIN_CONFIRM_DELIVERY_TEXT_LENGTH} characters.`,
        {
          field: 'evidence',
          invariant: TRADING_INVARIANTS.INV_04_ALLOCATION_AND_BATCH_TRACEABILITY,
        },
      );
    }

    const runWithTx = async (
      tx: TransactionContext,
    ): Promise<ConfirmDeliveryByAdminResult> => {
      // Mandatory lock ordering (data-design.md §4.2, TradingLockOrderingPolicy):
      // 1. QuoteRequest -> 2. Allocation (ordered by id ASC)
      const lockedRequest = await this.quoteRequestRepo.lockById(requestId, tx);
      if (!lockedRequest) {
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
          actorId: adminId,
          actorRole: 'admin',
          expectedVersion,
          allocationStatuses: lockedAllocations.map((a) => a.status),
          reason,
          evidence,
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
          id: adminId,
          display_name: null,
        }),
        performed_at: statusLog.created_at.toISOString(),
        is_admin_action: true,
        reason,
        evidence,
      });

      const detail =
        typeof this.quoteRequestRepo.findDetailById === 'function'
          ? await this.quoteRequestRepo.findDetailById(savedRequest.id, tx)
          : null;

      let adminRequestDto: AdminRequestDto;
      if (detail) {
        const deliveryLog = detail.statusLogs.find(
          (log) =>
            log.entity.event_type === 'received_by_admin' ||
            log.entity.event_type === 'received_by_buyer',
        );
        const deliveryConfirmation: DeliveryConfirmationDto = deliveryLog
          ? Object.freeze({
              performed_by: deliveryLog.performedBy ?? {
                id: deliveryLog.entity.performed_by ?? adminId,
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

        adminRequestDto = this.toAdminRequestDto(detail.entity, {
          category: detail.category,
          now,
          deliveryConfirmation,
        });
      } else {
        adminRequestDto = this.toAdminRequestDto(savedRequest, {
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
      readonly deliveryConfirmation: DeliveryConfirmationDto | null;
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
      delivery_confirmation: context.deliveryConfirmation,
    });
  }
}
