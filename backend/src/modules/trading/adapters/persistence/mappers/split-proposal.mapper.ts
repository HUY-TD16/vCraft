import type {
  Prisma,
  SplitProposal as PrismaSplitProposal,
  SplitProposalItem as PrismaSplitProposalItem,
} from '../../../../../generated/prisma/client';
import type {
  ActorDto,
  SplitProposalDto,
  SplitProposalItemDto,
} from '../../../application/dtos/trading-persistence.dtos';
import {
  SPLIT_PROPOSAL_EXPIRE_REASONS,
  SPLIT_PROPOSAL_STATUSES,
  SplitProposal,
  type SplitProposalItem,
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
  toNullableActorDto,
} from './shared-persistence.mapper';
import { SplitProposalItemMapper } from './split-proposal-item.mapper';

export interface SplitProposalItemPricingContext {
  readonly workshopName: string;
  readonly unitPrice: number;
  readonly committedDeliveryAt: Date;
  readonly bidAcceptDeadline: Date;
}

export class SplitProposalMapper {
  static toDomain(
    row: PrismaSplitProposal & {
      readonly splitProposalItems?: readonly PrismaSplitProposalItem[];
      readonly items?: readonly PrismaSplitProposalItem[];
    },
    preMappedItems?: readonly SplitProposalItem[],
  ): SplitProposal {
    const rawItems = row.splitProposalItems ?? row.items ?? [];
    const items =
      preMappedItems ??
      rawItems.map((itemRow) => SplitProposalItemMapper.toDomain(itemRow));

    return SplitProposal.reconstitute({
      id: bigintToId(row.id, 'split_proposal.id'),
      request_id: bigintToId(row.request_id, 'split_proposal.request_id'),
      created_by: bigintToId(row.created_by, 'split_proposal.created_by'),
      status: assertEnumValue(
        row.status,
        SPLIT_PROPOSAL_STATUSES,
        'split_proposal.status',
      ),
      version: row.version,
      expired_at: row.expired_at ?? null,
      expire_reason: nullableEnumValue(
        row.expire_reason,
        SPLIT_PROPOSAL_EXPIRE_REASONS,
        'split_proposal.expire_reason',
      ),
      reject_reason: row.reject_reason ?? null,
      rejected_by: nullableBigintToId(
        row.rejected_by,
        'split_proposal.rejected_by',
      ),
      rejected_at: row.rejected_at ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      items,
    });
  }

  static toPrismaCreateInput(
    entity: SplitProposal,
    includeId: boolean = true,
  ): Prisma.SplitProposalUncheckedCreateInput {
    return {
      ...(includeId
        ? { id: optionalIdToBigInt(entity.id, 'split_proposal.id') }
        : {}),
      request_id: idToBigInt(entity.request_id, 'split_proposal.request_id'),
      created_by: idToBigInt(entity.created_by, 'split_proposal.created_by'),
      status: entity.status,
      version: entity.version,
      expired_at: entity.expired_at,
      expire_reason: entity.expire_reason,
      reject_reason: entity.reject_reason,
      rejected_by: nullableIdToBigInt(
        entity.rejected_by,
        'split_proposal.rejected_by',
      ),
      rejected_at: entity.rejected_at,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }

  static toPrismaUpdateInput(
    entity: SplitProposal,
  ): Prisma.SplitProposalUncheckedUpdateManyInput {
    return {
      status: entity.status,
      version: entity.version,
      expired_at: entity.expired_at,
      expire_reason: entity.expire_reason,
      reject_reason: entity.reject_reason,
      rejected_by: nullableIdToBigInt(
        entity.rejected_by,
        'split_proposal.rejected_by',
      ),
      rejected_at: entity.rejected_at,
      updated_at: entity.updated_at,
    };
  }

  static toDto(
    entity: SplitProposal,
    context: {
      readonly quoteMetadataByQuoteId: ReadonlyMap<
        string,
        SplitProposalItemPricingContext
      >;
      readonly rejectedByActor?: ActorDto | null;
    },
  ): SplitProposalDto {
    const acceptDeadlinesByQuoteId = new Map<string, Date>();
    const unitPricesByQuoteId = new Map<string, number>();
    const itemDtos: SplitProposalItemDto[] = [];

    for (const item of entity.items) {
      const meta = context.quoteMetadataByQuoteId.get(item.quote_id);
      if (!meta) {
        throw new Error(
          `Missing quote pricing metadata for quote_id ${item.quote_id} in SplitProposal ${entity.id}.`,
        );
      }
      acceptDeadlinesByQuoteId.set(item.quote_id, meta.bidAcceptDeadline);
      unitPricesByQuoteId.set(item.quote_id, meta.unitPrice);

      itemDtos.push(
        SplitProposalItemMapper.toDto(item, {
          workshopName: meta.workshopName,
          unitPrice: meta.unitPrice,
          committedDeliveryAt: meta.committedDeliveryAt,
        }),
      );
    }

    const decisionDeadline = entity.computeDecisionDeadline(
      acceptDeadlinesByQuoteId,
    );
    const totalAmount = entity.computeTotalAmount(unitPricesByQuoteId);

    return Object.freeze({
      id: entity.id,
      request_id: entity.request_id,
      status: entity.status,
      version: entity.version,
      created_at: dateToInstant(entity.created_at, 'created_at'),
      decision_deadline: dateToInstant(decisionDeadline, 'decision_deadline'),
      expired_at: nullableDateToInstant(entity.expired_at, 'expired_at'),
      expire_reason: entity.expire_reason,
      rejected_by: toNullableActorDto(context.rejectedByActor),
      rejected_at: nullableDateToInstant(entity.rejected_at, 'rejected_at'),
      reject_reason: entity.reject_reason,
      items: Object.freeze(itemDtos),
      total_amount: totalAmount,
    });
  }
}
