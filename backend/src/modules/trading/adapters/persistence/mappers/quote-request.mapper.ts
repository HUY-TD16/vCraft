import type {
  Prisma,
  QuoteRequest as PrismaQuoteRequest,
} from '../../../../../generated/prisma/client';
import type { Id, Instant } from '../../../../../common/application/types/contract-types';
import type {
  AdminRequestDto,
  BuyerRequestDto,
  BuyerRequestSummaryDto,
  CategoryRefDto,
  DeliveryConfirmationDto,
  InvitedRequestBaseDto,
  InvitedRequestDto,
  InvitedRequestWithAllocationDto,
  QuoteDto,
  RecipientDto,
  RequestBaseDto,
} from '../../../application/dtos/trading-persistence.dtos';
import {
  type CoordinationState,
  DELIVERY_MODES,
  EntityId,
  QuoteRequest,
  REQUEST_STATUSES,
  REQUEST_UNITS,
} from '../../../domain';
import {
  assertEnumValue,
  bigintToId,
  dateToInstant,
  idToBigInt,
  nullableBigintToId,
  nullableDateToInstant,
  nullableEnumValue,
  nullableIdToBigInt,
  optionalIdToBigInt,
} from './shared-persistence.mapper';

export interface BuyerRequestDtoMapperContext {
  readonly category: CategoryRefDto | null;
  readonly now: Date;
  readonly coordinationState?: CoordinationState | null;
  readonly noValidQuotes?: boolean;
  readonly nearestAcceptDeadline?: Date | Instant | null;
  readonly deliveryConfirmation?: DeliveryConfirmationDto | null;
}

export interface QuoteSummaryEvaluationItem {
  readonly status: string;
  readonly bid_accept_deadline: Date;
  readonly committed_delivery_at: Date;
  readonly workshop?: {
    readonly status: string;
  } | null;
}

export interface BuyerRequestSummaryDtoMapperContext {
  readonly category: CategoryRefDto | null;
  readonly now: Date;
  readonly coordinationState?: CoordinationState | null;
  readonly noValidQuotes?: boolean;
  readonly nearestAcceptDeadline?: Date | Instant | null;
  readonly quotes?: readonly QuoteSummaryEvaluationItem[] | null;
}

export interface InvitedRequestDtoMapperContext {
  readonly category: CategoryRefDto | null;
  readonly now: Date;
  readonly ownRecipient: RecipientDto;
  readonly ownQuote: QuoteDto | null;
  /**
   * When present, indicates the invited workshop holds a confirmed Allocation
   * on this QuoteRequest (`BR-04`, `SEC-04`). When null or undefined, contact
   * and detailed address fields MUST be omitted from the returned DTO.
   */
  readonly ownAllocationId?: Id | null;
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
  static toDomain(row: PrismaQuoteRequest): QuoteRequest {
    return QuoteRequest.reconstitute({
      id: bigintToId(row.id, 'quote_request.id'),
      buyer_id: bigintToId(row.buyer_id, 'quote_request.buyer_id'),
      category_id: nullableBigintToId(
        row.category_id,
        'quote_request.category_id',
      ),
      spec: row.spec ?? null,
      quantity: row.quantity ?? null,
      unit: nullableEnumValue(row.unit, REQUEST_UNITS, 'quote_request.unit'),
      unit_set_description: row.unit_set_description ?? null,
      status: assertEnumValue(
        row.status,
        REQUEST_STATUSES,
        'quote_request.status',
      ),
      delivery_mode: nullableEnumValue(
        row.delivery_mode,
        DELIVERY_MODES,
        'quote_request.delivery_mode',
      ),
      delivery_region: row.delivery_region ?? null,
      delivery_address: row.delivery_address ?? null,
      recipient_name: row.recipient_name ?? null,
      recipient_phone: row.recipient_phone ?? null,
      bidding_deadline: row.bidding_deadline ?? null,
      delivery_deadline: row.delivery_deadline ?? null,
      bidding_closed_at: row.bidding_closed_at ?? null,
      version: row.version,
      cancelled_at: row.cancelled_at ?? null,
      cancelled_by: nullableBigintToId(
        row.cancelled_by,
        'quote_request.cancelled_by',
      ),
      cancel_reason: row.cancel_reason ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }

  static toPrismaCreateInput(
    entity: QuoteRequest,
    includeId: boolean = true,
  ): Prisma.QuoteRequestUncheckedCreateInput {
    return {
      ...(includeId ? { id: optionalIdToBigInt(entity.id, 'quote_request.id') } : {}),
      buyer_id: idToBigInt(entity.buyer_id, 'quote_request.buyer_id'),
      category_id: nullableIdToBigInt(
        entity.category_id,
        'quote_request.category_id',
      ),
      spec: entity.spec,
      quantity: entity.quantity,
      unit: entity.unit,
      unit_set_description: entity.unit_set_description,
      status: entity.status,
      delivery_mode: entity.delivery_mode,
      delivery_region: entity.delivery_region,
      delivery_address: entity.delivery_address,
      recipient_name: entity.recipient_name,
      recipient_phone: entity.recipient_phone,
      bidding_deadline: entity.bidding_deadline,
      delivery_deadline: entity.delivery_deadline,
      bidding_closed_at: entity.bidding_closed_at,
      version: entity.version,
      cancelled_at: entity.cancelled_at,
      cancelled_by: nullableIdToBigInt(
        entity.cancelled_by,
        'quote_request.cancelled_by',
      ),
      cancel_reason: entity.cancel_reason,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }

  static toPrismaUpdateInput(
    entity: QuoteRequest,
  ): Prisma.QuoteRequestUncheckedUpdateManyInput {
    return {
      category_id: nullableIdToBigInt(
        entity.category_id,
        'quote_request.category_id',
      ),
      spec: entity.spec,
      quantity: entity.quantity,
      unit: entity.unit,
      unit_set_description: entity.unit_set_description,
      status: entity.status,
      delivery_mode: entity.delivery_mode,
      delivery_region: entity.delivery_region,
      delivery_address: entity.delivery_address,
      recipient_name: entity.recipient_name,
      recipient_phone: entity.recipient_phone,
      bidding_deadline: entity.bidding_deadline,
      delivery_deadline: entity.delivery_deadline,
      bidding_closed_at: entity.bidding_closed_at,
      version: entity.version,
      cancelled_at: entity.cancelled_at,
      cancelled_by: nullableIdToBigInt(
        entity.cancelled_by,
        'quote_request.cancelled_by',
      ),
      cancel_reason: entity.cancel_reason,
      updated_at: entity.updated_at,
    };
  }

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

  static toSummaryDto(
    entity: QuoteRequest,
    context: BuyerRequestSummaryDtoMapperContext,
  ): BuyerRequestSummaryDto {
    let noValidQuotes = context.noValidQuotes ?? false;
    let nearestAcceptDeadline = context.nearestAcceptDeadline;

    if (context.quotes !== undefined && context.quotes !== null) {
      const eligibleQuotes = context.quotes.filter((q) => {
        if (entity.isCancelled() || entity.isAcceptedOrBeyond()) {
          return false;
        }
        if (q.status !== 'active') {
          return false;
        }
        const isWorkshopActive = q.workshop?.status === 'active';
        if (!isWorkshopActive) {
          return false;
        }
        if (context.now.getTime() >= q.bid_accept_deadline.getTime()) {
          return false;
        }
        if (
          entity.delivery_deadline !== null &&
          q.committed_delivery_at.getTime() > entity.delivery_deadline.getTime()
        ) {
          return false;
        }
        return true;
      });

      const validQuoteCount = eligibleQuotes.length;
      noValidQuotes = entity.deriveNoValidQuotes(validQuoteCount);

      if (
        eligibleQuotes.length > 0 &&
        !entity.isCancelled() &&
        !entity.isAcceptedOrBeyond()
      ) {
        const minTime = Math.min(
          ...eligibleQuotes.map((q) => q.bid_accept_deadline.getTime()),
        );
        nearestAcceptDeadline = new Date(minTime);
      } else {
        nearestAcceptDeadline = null;
      }
    }

    return Object.freeze({
      id: entity.id,
      status: entity.status,
      version: entity.version,
      category: context.category,
      quantity: entity.quantity,
      unit: entity.unit,
      bidding_deadline: nullableDateToInstant(
        entity.bidding_deadline,
        'bidding_deadline',
      ),
      delivery_deadline: nullableDateToInstant(
        entity.delivery_deadline,
        'delivery_deadline',
      ),
      is_bidding_open: entity.isBiddingOpenAt(context.now),
      cancelled_at: nullableDateToInstant(entity.cancelled_at, 'cancelled_at'),
      split_requested_at: null,
      coordination_state: context.coordinationState ?? null,
      no_valid_quotes: noValidQuotes,
      nearest_accept_deadline: normalizeNearestDeadline(nearestAcceptDeadline),
      created_at: dateToInstant(entity.created_at, 'created_at'),
    });
  }

  /**
   * Maps QuoteRequest to Artisan `InvitedRequestDto` (`BR-04`, `SEC-04`, `api-dtos.md` §2.2).
   * Strictly omits `recipient_name`, `recipient_phone`, `delivery_address`, and `own_allocation_id`
   * unless `context.ownAllocationId` is present.
   */
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
}
