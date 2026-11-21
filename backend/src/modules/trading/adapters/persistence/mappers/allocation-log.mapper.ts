import type {
  AllocationLog as PrismaAllocationLog,
  Prisma,
} from '../../../../../generated/prisma/client';
import type { Id } from '../../../../../common/application/types/contract-types';
import type {
  ActorDto,
  AllocationEventDto,
  PersistedAllocationLogRecord,
} from '../../../application/dtos/trading-persistence.dtos';
import {
  ALLOCATION_LOG_EVENT_TYPES,
  ALLOCATION_STATUSES,
  type AllocationLogRecord,
  EntityId,
} from '../../../domain';
import {
  assertEnumValue,
  bigintToId,
  dateToInstant,
  idToBigInt,
  nullableEnumValue,
  optionalIdToBigInt,
  parseInstantOrDate,
  toNullableActorDto,
} from './shared-persistence.mapper';

export class AllocationLogMapper {
  static toDomain(row: PrismaAllocationLog): PersistedAllocationLogRecord {
    return Object.freeze({
      id: bigintToId(row.id, 'allocation_log.id'),
      allocation_id: bigintToId(
        row.allocation_id,
        'allocation_log.allocation_id',
      ),
      event_type: assertEnumValue(
        row.event_type,
        ALLOCATION_LOG_EVENT_TYPES,
        'allocation_log.event_type',
      ),
      prev_status: nullableEnumValue(
        row.prev_status,
        ALLOCATION_STATUSES,
        'allocation_log.prev_status',
      ),
      new_status: assertEnumValue(
        row.new_status,
        ALLOCATION_STATUSES,
        'allocation_log.new_status',
      ),
      performed_by: bigintToId(row.performed_by, 'allocation_log.performed_by'),
      is_admin_action: row.is_admin_action,
      note: row.note ?? null,
      evidence: row.evidence ?? null,
      created_at: parseInstantOrDate(
        row.created_at,
        'allocation_log.created_at',
      ),
    });
  }

  static toPrismaCreateInput(
    record: AllocationLogRecord & { readonly id?: Id },
  ): Prisma.AllocationLogUncheckedCreateInput {
    const eventType = assertEnumValue(
      record.event_type,
      ALLOCATION_LOG_EVENT_TYPES,
      'allocation_log.event_type',
    );
    const prevStatus = nullableEnumValue(
      record.prev_status,
      ALLOCATION_STATUSES,
      'allocation_log.prev_status',
    );
    const newStatus = assertEnumValue(
      record.new_status,
      ALLOCATION_STATUSES,
      'allocation_log.new_status',
    );

    return {
      ...(record.id !== undefined
        ? { id: optionalIdToBigInt(record.id, 'allocation_log.id') }
        : {}),
      allocation_id: idToBigInt(
        record.allocation_id,
        'allocation_log.allocation_id',
      ),
      event_type: eventType,
      prev_status: prevStatus,
      new_status: newStatus,
      performed_by: idToBigInt(
        record.performed_by,
        'allocation_log.performed_by',
      ),
      is_admin_action: record.is_admin_action,
      note: record.note ?? null,
      evidence: record.evidence ?? null,
      created_at: parseInstantOrDate(
        record.created_at,
        'allocation_log.created_at',
      ),
    };
  }

  static toDto(
    record: PersistedAllocationLogRecord,
    performedByActor: ActorDto | null,
  ): AllocationEventDto {
    return Object.freeze({
      id: EntityId.of(record.id, 'allocation_log.id').value,
      event_type: record.event_type,
      prev_status: record.prev_status,
      new_status: record.new_status,
      performed_by: toNullableActorDto(performedByActor),
      created_at: dateToInstant(record.created_at, 'allocation_log.created_at'),
      is_admin_action: record.is_admin_action,
      note: record.note,
      evidence: record.evidence,
    });
  }

  static fromPrismaWithActorToDto(
    row: PrismaAllocationLog & {
      readonly performedBy?: {
        readonly id: bigint;
        readonly display_name: string | null;
      } | null;
    },
  ): AllocationEventDto {
    const domain = AllocationLogMapper.toDomain(row);
    return AllocationLogMapper.toDto(
      domain,
      toNullableActorDto(row.performedBy ?? null),
    );
  }
}
