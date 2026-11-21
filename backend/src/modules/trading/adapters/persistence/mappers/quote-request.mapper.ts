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
  InvitedRequestDto,
  RequestBaseDto,
} from '../../../application/dtos/trading-persistence.dtos';
import {
  type BuyerRequestDtoMapperContext,
  type InvitedRequestDtoMapperContext,
  QuoteRequestMapper as QuoteRequestApplicationMapper,
} from '../../../application/mappers/quote-request.mapper';
import type { QuoteRequestDetailRecord } from '../../../application/ports/repositories/trading-repositories.port';
import {
  type CoordinationState,
  DELIVERY_MODES,
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

export type {
  BuyerRequestDtoMapperContext,
  InvitedRequestDtoMapperContext,
};

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
      ...(includeId
        ? { id: optionalIdToBigInt(entity.id, 'quote_request.id') }
        : {}),
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
    return QuoteRequestApplicationMapper.toBaseDto(entity, context);
  }

  static toBuyerRequestDto(
    entity: QuoteRequest,
    context: BuyerRequestDtoMapperContext,
  ): BuyerRequestDto {
    return QuoteRequestApplicationMapper.toBuyerRequestDto(entity, context);
  }

  static toAdminRequestDto(
    entity: QuoteRequest,
    context: BuyerRequestDtoMapperContext,
  ): AdminRequestDto {
    return QuoteRequestApplicationMapper.toAdminRequestDto(entity, context);
  }

  static fromDetailOrEntityToBuyerOrAdminDto(input: {
    readonly detail?: QuoteRequestDetailRecord | null;
    readonly fallbackEntity?: QuoteRequest;
    readonly now: Date;
    readonly fallbackActorId?: Id;
    readonly fallbackDeliveryConfirmation?: DeliveryConfirmationDto | null;
  }): BuyerRequestDto {
    return QuoteRequestApplicationMapper.fromDetailOrEntityToBuyerOrAdminDto(
      input,
    );
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
    return QuoteRequestApplicationMapper.toInvitedRequestDto(entity, context);
  }
}
