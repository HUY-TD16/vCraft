import type {
  Prisma,
  Quote as PrismaQuote,
} from '../../../../../generated/prisma/client';
import type {
  QuoteDto,
  QuoteMutationDto,
  RecipientDto,
  WorkshopRefDto,
} from '../../../application/dtos/trading-persistence.dtos';
import {
  type IneligibleQuoteReason,
  Quote,
  QUOTE_STATUSES,
  type QuoteRequest,
} from '../../../domain';
import {
  assertEnumValue,
  bigintToId,
  dateToInstant,
  decimalToUnitPrice,
  idToBigInt,
  nullableBigintToId,
  nullableDateToInstant,
  nullableIdToBigInt,
  optionalIdToBigInt,
  toWorkshopRefDto,
  unitPriceToDecimal,
} from './shared-persistence.mapper';

export interface QuoteDtoMapperContext {
  readonly workshop: WorkshopRefDto;
  readonly isEligible?: boolean;
  readonly ineligibleReasons?: readonly IneligibleQuoteReason[];
  readonly evaluationContext?: {
    readonly request: QuoteRequest;
    readonly workshopIsActive: boolean;
    readonly now: Date;
  };
}

export class QuoteMapper {
  static toDomain(row: PrismaQuote): Quote {
    return Quote.reconstitute({
      id: bigintToId(row.id, 'quote.id'),
      request_id: bigintToId(row.request_id, 'quote.request_id'),
      workshop_id: bigintToId(row.workshop_id, 'quote.workshop_id'),
      unit_price: decimalToUnitPrice(row.unit_price, 'quote.unit_price'),
      max_quantity: row.max_quantity,
      bid_accept_deadline: row.bid_accept_deadline,
      committed_delivery_at: row.committed_delivery_at,
      status: assertEnumValue(row.status, QUOTE_STATUSES, 'quote.status'),
      version: row.version,
      withdraw_reason: row.withdraw_reason ?? null,
      withdrawn_by: nullableBigintToId(row.withdrawn_by, 'quote.withdrawn_by'),
      withdrawn_at: row.withdrawn_at ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }

  static toPrismaCreateInput(
    entity: Quote,
    includeId: boolean = true,
  ): Prisma.QuoteUncheckedCreateInput {
    return {
      ...(includeId ? { id: optionalIdToBigInt(entity.id, 'quote.id') } : {}),
      request_id: idToBigInt(entity.request_id, 'quote.request_id'),
      workshop_id: idToBigInt(entity.workshop_id, 'quote.workshop_id'),
      unit_price: unitPriceToDecimal(entity.unit_price, 'quote.unit_price'),
      max_quantity: entity.max_quantity,
      bid_accept_deadline: entity.bid_accept_deadline,
      committed_delivery_at: entity.committed_delivery_at,
      status: entity.status,
      version: entity.version,
      withdraw_reason: entity.withdraw_reason,
      withdrawn_by: nullableIdToBigInt(
        entity.withdrawn_by,
        'quote.withdrawn_by',
      ),
      withdrawn_at: entity.withdrawn_at,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }

  static toPrismaUpdateInput(
    entity: Quote,
  ): Prisma.QuoteUncheckedUpdateManyInput {
    return {
      unit_price: unitPriceToDecimal(entity.unit_price, 'quote.unit_price'),
      max_quantity: entity.max_quantity,
      bid_accept_deadline: entity.bid_accept_deadline,
      committed_delivery_at: entity.committed_delivery_at,
      status: entity.status,
      version: entity.version,
      withdraw_reason: entity.withdraw_reason,
      withdrawn_by: nullableIdToBigInt(
        entity.withdrawn_by,
        'quote.withdrawn_by',
      ),
      withdrawn_at: entity.withdrawn_at,
      updated_at: entity.updated_at,
    };
  }

  static toDto(entity: Quote, context: QuoteDtoMapperContext): QuoteDto {
    let isEligible = context.isEligible ?? false;
    let ineligibleReasons: readonly IneligibleQuoteReason[] =
      context.ineligibleReasons ?? [];

    if (context.evaluationContext) {
      const evaluated = entity.evaluateEligibility(context.evaluationContext);
      isEligible = evaluated.is_eligible;
      ineligibleReasons = evaluated.ineligible_reasons;
    }

    return Object.freeze({
      id: entity.id,
      request_id: entity.request_id,
      workshop: toWorkshopRefDto(context.workshop),
      unit_price: entity.unit_price,
      max_quantity: entity.max_quantity,
      bid_accept_deadline: dateToInstant(
        entity.bid_accept_deadline,
        'bid_accept_deadline',
      ),
      committed_delivery_at: dateToInstant(
        entity.committed_delivery_at,
        'committed_delivery_at',
      ),
      status: entity.status,
      version: entity.version,
      withdraw_reason: entity.withdraw_reason,
      withdrawn_at: nullableDateToInstant(entity.withdrawn_at, 'withdrawn_at'),
      is_eligible: isEligible,
      ineligible_reasons: Object.freeze([...ineligibleReasons]),
      created_at: dateToInstant(entity.created_at, 'created_at'),
      updated_at: dateToInstant(entity.updated_at, 'updated_at'),
    });
  }

  static toMutationDto(
    quote: QuoteDto,
    recipient: RecipientDto,
  ): QuoteMutationDto {
    return Object.freeze({
      quote,
      recipient,
    });
  }
}
