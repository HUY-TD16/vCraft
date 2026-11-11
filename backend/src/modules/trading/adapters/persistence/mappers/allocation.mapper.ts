import type {
  Allocation as PrismaAllocation,
  AllocationBatch as PrismaAllocationBatch,
  Prisma,
} from '../../../../../generated/prisma/client';
import type {
  ActorDto,
  AllocationDto,
  WorkshopRefDto,
} from '../../../application/dtos/trading-persistence.dtos';
import {
  Allocation,
  ALLOCATION_STATUSES,
  type AllocationBatchLink,
  type TraceabilityWarning,
} from '../../../domain';
import { AllocationBatchMapper } from './allocation-batch.mapper';
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
  toNullableActorDto,
  toWorkshopRefDto,
  unitPriceToDecimal,
} from './shared-persistence.mapper';

export interface AllocationDtoMapperContext {
  readonly workshop: WorkshopRefDto;
  readonly startedByActor?: ActorDto | null;
  readonly handedOverByActor?: ActorDto | null;
  readonly traceabilityWarning?: TraceabilityWarning | null;
  readonly publishedBatchIds?: ReadonlySet<string>;
}

export class AllocationMapper {
  static toDomain(
    row: PrismaAllocation & {
      readonly allocationBatches?: readonly PrismaAllocationBatch[];
      readonly allocation_batches?: readonly PrismaAllocationBatch[];
    },
    preMappedBatchLinks?: readonly AllocationBatchLink[],
  ): Allocation {
    const rawBatches = row.allocationBatches ?? row.allocation_batches ?? [];
    const batchLinks =
      preMappedBatchLinks ??
      rawBatches.map((linkRow) => AllocationBatchMapper.toDomain(linkRow));

    return Allocation.reconstitute({
      id: bigintToId(row.id, 'allocation.id'),
      request_id: bigintToId(row.request_id, 'allocation.request_id'),
      workshop_id: bigintToId(row.workshop_id, 'allocation.workshop_id'),
      quote_id: bigintToId(row.quote_id, 'allocation.quote_id'),
      quantity: row.quantity,
      unit_price: decimalToUnitPrice(row.unit_price, 'allocation.unit_price'),
      committed_delivery_at: row.committed_delivery_at,
      status: assertEnumValue(
        row.status,
        ALLOCATION_STATUSES,
        'allocation.status',
      ),
      version: row.version,
      started_at: row.started_at ?? null,
      started_by: nullableBigintToId(row.started_by, 'allocation.started_by'),
      handed_over_at: row.handed_over_at ?? null,
      handed_over_by: nullableBigintToId(
        row.handed_over_by,
        'allocation.handed_over_by',
      ),
      delivery_note: row.delivery_note ?? null,
      admin_handed_over: row.admin_handed_over,
      admin_delivery_evidence: row.admin_delivery_evidence ?? null,
      admin_handover_reason: row.admin_handover_reason ?? null,
      admin_handover_actual_at: row.admin_handover_actual_at ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      batch_links: batchLinks,
    });
  }

  static toPrismaCreateInput(
    entity: Allocation,
    includeId: boolean = true,
  ): Prisma.AllocationUncheckedCreateInput {
    return {
      ...(includeId
        ? { id: optionalIdToBigInt(entity.id, 'allocation.id') }
        : {}),
      request_id: idToBigInt(entity.request_id, 'allocation.request_id'),
      workshop_id: idToBigInt(entity.workshop_id, 'allocation.workshop_id'),
      quote_id: idToBigInt(entity.quote_id, 'allocation.quote_id'),
      quantity: entity.quantity,
      unit_price: unitPriceToDecimal(
        entity.unit_price,
        'allocation.unit_price',
      ),
      committed_delivery_at: entity.committed_delivery_at,
      status: entity.status,
      version: entity.version,
      started_at: entity.started_at,
      started_by: nullableIdToBigInt(
        entity.started_by,
        'allocation.started_by',
      ),
      handed_over_at: entity.handed_over_at,
      handed_over_by: nullableIdToBigInt(
        entity.handed_over_by,
        'allocation.handed_over_by',
      ),
      delivery_note: entity.delivery_note,
      admin_handed_over: entity.admin_handed_over,
      admin_delivery_evidence: entity.admin_delivery_evidence,
      admin_handover_reason: entity.admin_handover_reason,
      admin_handover_actual_at: entity.admin_handover_actual_at,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }

  static toPrismaUpdateInput(
    entity: Allocation,
  ): Prisma.AllocationUncheckedUpdateManyInput {
    return {
      status: entity.status,
      version: entity.version,
      started_at: entity.started_at,
      started_by: nullableIdToBigInt(
        entity.started_by,
        'allocation.started_by',
      ),
      handed_over_at: entity.handed_over_at,
      handed_over_by: nullableIdToBigInt(
        entity.handed_over_by,
        'allocation.handed_over_by',
      ),
      delivery_note: entity.delivery_note,
      admin_handed_over: entity.admin_handed_over,
      admin_delivery_evidence: entity.admin_delivery_evidence,
      admin_handover_reason: entity.admin_handover_reason,
      admin_handover_actual_at: entity.admin_handover_actual_at,
      updated_at: entity.updated_at,
    };
  }

  static toDto(
    entity: Allocation,
    context: AllocationDtoMapperContext,
  ): AllocationDto {
    const warning =
      context.traceabilityWarning !== undefined
        ? context.traceabilityWarning
        : context.publishedBatchIds !== undefined
          ? entity.deriveTraceabilityWarning(context.publishedBatchIds)
          : null;

    return Object.freeze({
      id: entity.id,
      request_id: entity.request_id,
      workshop: toWorkshopRefDto(context.workshop),
      quote_id: entity.quote_id,
      quantity: entity.quantity,
      unit_price: entity.unit_price,
      committed_delivery_at: dateToInstant(
        entity.committed_delivery_at,
        'committed_delivery_at',
      ),
      status: entity.status,
      version: entity.version,
      started_at: nullableDateToInstant(entity.started_at, 'started_at'),
      started_by: toNullableActorDto(context.startedByActor),
      handed_over_at: nullableDateToInstant(
        entity.handed_over_at,
        'handed_over_at',
      ),
      handed_over_by: toNullableActorDto(context.handedOverByActor),
      delivery_note: entity.delivery_note,
      admin_handed_over: entity.admin_handed_over,
      admin_handover_reason: entity.admin_handover_reason,
      admin_delivery_evidence: entity.admin_delivery_evidence,
      admin_handover_actual_at: nullableDateToInstant(
        entity.admin_handover_actual_at,
        'admin_handover_actual_at',
      ),
      traceability_warning: warning,
    });
  }
}
