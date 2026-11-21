import type {
  AllocationBatch as PrismaAllocationBatch,
  Prisma,
} from '../../../../../generated/prisma/client';
import type { AllocationBatchDto } from '../../../application/dtos/trading-persistence.dtos';
import {
  AllocationBatchLink,
  InvalidTradingInputError,
} from '../../../domain';
import {
  bigintToId,
  dateToInstant,
  idToBigInt,
  optionalIdToBigInt,
} from './shared-persistence.mapper';

export interface AllocationBatchDtoMapperContext {
  readonly batchName: string;
  readonly batchStatus: 'draft' | 'published';
  readonly traceUrl: string | null;
  /**
   * When true (default for Buyer view per `BR-09`, `api-design.md` §10.4, `api-dtos.md` §2.3),
   * `trace_url` is masked (`null`) whenever `batchStatus !== 'published'`.
   */
  readonly maskDraftTraceUrl?: boolean;
}

export class AllocationBatchMapper {
  static toDomain(row: PrismaAllocationBatch): AllocationBatchLink {
    return AllocationBatchLink.reconstitute({
      id: bigintToId(row.id, 'allocation_batch.id'),
      workshop_id: bigintToId(row.workshop_id, 'allocation_batch.workshop_id'),
      allocation_id: bigintToId(
        row.allocation_id,
        'allocation_batch.allocation_id',
      ),
      batch_id: bigintToId(row.batch_id, 'allocation_batch.batch_id'),
      linked_quantity: row.linked_quantity,
      linked_at: row.linked_at,
      linked_by: bigintToId(row.linked_by, 'allocation_batch.linked_by'),
    });
  }

  static toPrismaCreateInput(
    entity: AllocationBatchLink,
    includeId: boolean = true,
  ): Prisma.AllocationBatchUncheckedCreateInput {
    return {
      ...(includeId && entity.id !== undefined
        ? { id: optionalIdToBigInt(entity.id, 'allocation_batch.id') }
        : {}),
      workshop_id: idToBigInt(
        entity.workshop_id,
        'allocation_batch.workshop_id',
      ),
      allocation_id: idToBigInt(
        entity.allocation_id,
        'allocation_batch.allocation_id',
      ),
      batch_id: idToBigInt(entity.batch_id, 'allocation_batch.batch_id'),
      linked_quantity: entity.linked_quantity,
      linked_at: entity.linked_at,
      linked_by: idToBigInt(entity.linked_by, 'allocation_batch.linked_by'),
    };
  }

  static toDto(
    entity: AllocationBatchLink,
    context: AllocationBatchDtoMapperContext,
  ): AllocationBatchDto {
    if (
      typeof context.batchName !== 'string' ||
      context.batchName.trim().length === 0
    ) {
      throw new InvalidTradingInputError(
        'batch_name must be a non-empty string.',
        { field: 'batch_name' },
      );
    }

    const isTracePublic = context.batchStatus === 'published';
    const shouldMaskTraceUrl = context.maskDraftTraceUrl ?? true;
    const exposedTraceUrl =
      isTracePublic || !shouldMaskTraceUrl ? (context.traceUrl ?? null) : null;

    return Object.freeze({
      batch_id: entity.batch_id,
      batch_name: context.batchName,
      linked_quantity: entity.linked_quantity,
      is_trace_public: isTracePublic,
      trace_url: exposedTraceUrl,
      linked_at: dateToInstant(entity.linked_at, 'linked_at'),
    });
  }
}
