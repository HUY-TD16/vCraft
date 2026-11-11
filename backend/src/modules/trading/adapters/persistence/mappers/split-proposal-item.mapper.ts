import type {
  Prisma,
  SplitProposalItem as PrismaSplitProposalItem,
} from '../../../../../generated/prisma/client';
import type { SplitProposalItemDto } from '../../../application/dtos/trading-persistence.dtos';
import {
  InvalidTradingInputError,
  SplitProposalItem,
  UnitPrice,
} from '../../../domain';
import {
  bigintToId,
  dateToInstant,
  idToBigInt,
  optionalIdToBigInt,
  parseInstantOrDate,
} from './shared-persistence.mapper';

export class SplitProposalItemMapper {
  static toDomain(row: PrismaSplitProposalItem): SplitProposalItem {
    return SplitProposalItem.reconstitute({
      id: bigintToId(row.id, 'split_proposal_item.id'),
      proposal_id: bigintToId(
        row.proposal_id,
        'split_proposal_item.proposal_id',
      ),
      request_id: bigintToId(row.request_id, 'split_proposal_item.request_id'),
      workshop_id: bigintToId(
        row.workshop_id,
        'split_proposal_item.workshop_id',
      ),
      quote_id: bigintToId(row.quote_id, 'split_proposal_item.quote_id'),
      quote_version: row.quote_version,
      allocated_quantity: row.allocated_quantity,
    });
  }

  static toPrismaCreateInput(
    entity: SplitProposalItem,
    includeId: boolean = true,
  ): Prisma.SplitProposalItemUncheckedCreateInput {
    return {
      ...(includeId
        ? { id: optionalIdToBigInt(entity.id, 'split_proposal_item.id') }
        : {}),
      proposal_id: idToBigInt(
        entity.proposal_id,
        'split_proposal_item.proposal_id',
      ),
      request_id: idToBigInt(
        entity.request_id,
        'split_proposal_item.request_id',
      ),
      workshop_id: idToBigInt(
        entity.workshop_id,
        'split_proposal_item.workshop_id',
      ),
      quote_id: idToBigInt(entity.quote_id, 'split_proposal_item.quote_id'),
      quote_version: entity.quote_version,
      allocated_quantity: entity.allocated_quantity,
    };
  }

  static toDto(
    entity: SplitProposalItem,
    context: {
      readonly workshopName: string;
      readonly unitPrice: number;
      readonly committedDeliveryAt: Date | string;
    },
  ): SplitProposalItemDto {
    if (
      typeof context.workshopName !== 'string' ||
      context.workshopName.trim().length === 0
    ) {
      throw new InvalidTradingInputError(
        'workshop_name must be a non-empty string.',
        { field: 'workshop_name' },
      );
    }

    const validatedUnitPrice = UnitPrice.of(
      context.unitPrice,
      'unit_price',
    ).value;
    const committedDeliveryDate = parseInstantOrDate(
      context.committedDeliveryAt,
      'committed_delivery_at',
    );
    const lineTotal = entity.calculateLineTotal(validatedUnitPrice);

    return Object.freeze({
      workshop_id: entity.workshop_id,
      workshop_name: context.workshopName,
      quote_id: entity.quote_id,
      quote_version: entity.quote_version,
      quantity: entity.allocated_quantity,
      unit_price: validatedUnitPrice,
      committed_delivery_at: dateToInstant(
        committedDeliveryDate,
        'committed_delivery_at',
      ),
      line_total: lineTotal,
    });
  }
}
