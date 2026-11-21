import type { Id, Instant } from '../../../../common/application/types/contract-types';
import {
  type CoordinationState,
  EntityId,
  InvalidTradingInputError,
  type QuoteRequest,
} from '../../domain';
import type {
  AdminRequestDto,
  BuyerRequestDto,
  CategoryRefDto,
  DeliveryConfirmationDto,
  InvitedRequestBaseDto,
  InvitedRequestDto,
  InvitedRequestWithAllocationDto,
  QuoteDto,
  RecipientDto,
  RequestBaseDto,
} from '../dtos/trading-persistence.dtos';
import type { QuoteRequestDetailRecord } from '../ports/repositories/trading-repositories.port';

export interface BuyerRequestDtoMapperContext {
  readonly category: CategoryRefDto | null;
  readonly now: Date;
  readonly coordinationState?: CoordinationState | null;
  readonly noValidQuotes?: boolean;
  readonly nearestAcceptDeadline?: Date | Instant | null;
  readonly deliveryConfirmation?: DeliveryConfirmationDto | null;
}

export interface InvitedRequestDtoMapperContext {
  readonly category: CategoryRefDto | null;
  readonly now: Date;
  readonly ownRecipient: RecipientDto;
  readonly ownQuote: QuoteDto | null;
  readonly ownAllocationId?: Id | null;
}

function dateToInstant(
  value: Date,
  fieldName: string = 'timestamp',
): Instant {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidTradingInputError(
      `${fieldName} must be a valid Date instance.`,
      { field: fieldName },
    );
  }
  return value.toISOString();
}

function nullableDateToInstant(
  value: Date | null | undefined,
  fieldName: string = 'timestamp',
): Instant | null {
  if (value === null || value === undefined) {
    return null;
  }
  return dateToInstant(value, fieldName);
}

function normalizeNearestDeadline(
  value: Date | Instant | null | undefined,
): Instant | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return dateToInstant(value, 'nearest_accept_deadline');
  }
  return value;
}

export class QuoteRequestMapper {
  static toBaseDto(
    entity: QuoteRequest,
    context: { readonly category: CategoryRefDto | null; readonly now: Date },
  ): RequestBaseDto {
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
      bidding_deadline: nullableDateToInstant(
        entity.bidding_deadline,
        'bidding_deadline',
      ),
      delivery_deadline: nullableDateToInstant(
        entity.delivery_deadline,
        'delivery_deadline',
      ),
      bidding_closed_at: nullableDateToInstant(
        entity.bidding_closed_at,
        'bidding_closed_at',
      ),
      is_bidding_open: entity.isBiddingOpenAt(context.now),
      cancelled_at: nullableDateToInstant(entity.cancelled_at, 'cancelled_at'),
      created_at: dateToInstant(entity.created_at, 'created_at'),
      updated_at: dateToInstant(entity.updated_at, 'updated_at'),
    });
  }

  static toBuyerRequestDto(
    entity: QuoteRequest,
    context: BuyerRequestDtoMapperContext,
  ): BuyerRequestDto {
    const base = QuoteRequestMapper.toBaseDto(entity, context);
    return Object.freeze({
      ...base,
      buyer_id: entity.buyer_id,
      recipient_name: entity.recipient_name,
      recipient_phone: entity.recipient_phone,
      delivery_address: entity.delivery_address,
      cancel_reason: entity.cancel_reason,
      split_requested_at: null,
      coordination_state: context.coordinationState ?? null,
      no_valid_quotes: context.noValidQuotes ?? false,
      nearest_accept_deadline: normalizeNearestDeadline(
        context.nearestAcceptDeadline,
      ),
      delivery_confirmation: context.deliveryConfirmation ?? null,
    });
  }

  static toAdminRequestDto(
    entity: QuoteRequest,
    context: BuyerRequestDtoMapperContext,
  ): AdminRequestDto {
    return QuoteRequestMapper.toBuyerRequestDto(entity, context);
  }

  static toInvitedRequestDto(
    entity: QuoteRequest,
    context: InvitedRequestDtoMapperContext,
  ): InvitedRequestDto {
    const base = QuoteRequestMapper.toBaseDto(entity, context);

    if (
      context.ownAllocationId === null ||
      context.ownAllocationId === undefined
    ) {
      const unallocated: InvitedRequestBaseDto = {
        ...base,
        own_recipient: context.ownRecipient,
        own_quote: context.ownQuote,
      };
      return Object.freeze(unallocated);
    }

    const validatedAllocationId = EntityId.of(
      context.ownAllocationId,
      'own_allocation_id',
    ).value;
    const allocated: InvitedRequestWithAllocationDto = {
      ...base,
      own_recipient: context.ownRecipient,
      own_quote: context.ownQuote,
      own_allocation_id: validatedAllocationId,
      recipient_name: entity.recipient_name,
      recipient_phone: entity.recipient_phone,
      delivery_address: entity.delivery_address,
    };
    return Object.freeze(allocated);
  }

  static fromDetailOrEntityToBuyerOrAdminDto(input: {
    readonly detail?: QuoteRequestDetailRecord | null;
    readonly fallbackEntity?: QuoteRequest;
    readonly now: Date;
    readonly fallbackActorId?: Id;
    readonly fallbackDeliveryConfirmation?: DeliveryConfirmationDto | null;
  }): BuyerRequestDto {
    if (input.detail) {
      const { detail, now } = input;
      const isClosedOrCancelled =
        detail.entity.isCancelled() || detail.entity.isAcceptedOrBeyond();

      const eligibleQuotes = (detail.quotes ?? []).filter((q) => {
        if (isClosedOrCancelled) {
          return false;
        }
        if (q.entity.status !== 'active') {
          return false;
        }
        if (q.workshop.status !== 'active') {
          return false;
        }
        if (now.getTime() >= q.entity.bid_accept_deadline.getTime()) {
          return false;
        }
        if (
          detail.entity.delivery_deadline !== null &&
          q.entity.committed_delivery_at.getTime() >
            detail.entity.delivery_deadline.getTime()
        ) {
          return false;
        }
        return true;
      });

      const validQuoteCount = eligibleQuotes.length;
      const noValidQuotes = detail.entity.deriveNoValidQuotes(validQuoteCount);

      let nearestAcceptDeadline: Instant | null = null;
      if (eligibleQuotes.length > 0 && !isClosedOrCancelled) {
        const minTime = Math.min(
          ...eligibleQuotes.map((q) => q.entity.bid_accept_deadline.getTime()),
        );
        nearestAcceptDeadline = new Date(minTime).toISOString();
      }

      let deliveryConfirmation: DeliveryConfirmationDto | null =
        input.fallbackDeliveryConfirmation ?? null;
      if (detail.entity.status === 'delivered') {
        const deliveryLog = (detail.statusLogs ?? []).find(
          (log) =>
            log.entity.event_type === 'received_by_buyer' ||
            log.entity.event_type === 'received_by_admin',
        );
        if (deliveryLog) {
          const performedByActor = deliveryLog.performedBy ?? {
            id:
              deliveryLog.entity.performed_by ??
              input.fallbackActorId ??
              '0',
            display_name: null,
          };
          const performedAtDate =
            deliveryLog.entity.created_at instanceof Date
              ? deliveryLog.entity.created_at
              : new Date(deliveryLog.entity.created_at);

          deliveryConfirmation = Object.freeze({
            performed_by: performedByActor,
            performed_at: performedAtDate.toISOString(),
            is_admin_action: deliveryLog.entity.is_admin_action,
            reason: deliveryLog.entity.note,
            evidence: deliveryLog.entity.evidence,
          });
        }
      }

      return QuoteRequestMapper.toBuyerRequestDto(detail.entity, {
        category: detail.category,
        now,
        coordinationState: null,
        noValidQuotes,
        nearestAcceptDeadline,
        deliveryConfirmation,
      });
    }

    const entity = input.fallbackEntity;
    if (!entity) {
      throw new Error(
        'Either detail or fallbackEntity is required to map QuoteRequest DTO.',
      );
    }

    return QuoteRequestMapper.toBuyerRequestDto(entity, {
      category: entity.category_id
        ? { id: entity.category_id, name: '' }
        : null,
      now: input.now,
      coordinationState: null,
      noValidQuotes: false,
      nearestAcceptDeadline: null,
      deliveryConfirmation: input.fallbackDeliveryConfirmation ?? null,
    });
  }
}
