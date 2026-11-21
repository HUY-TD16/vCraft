import type {
  Prisma,
  StatusLog as PrismaStatusLog,
} from '../../../../../generated/prisma/client';
import type { Id } from '../../../../../common/application/types/contract-types';
import type {
  ActorDto,
  DeliveryConfirmationDto,
  PersistedStatusLogRecord,
  RequestEventDto,
} from '../../../application/dtos/trading-persistence.dtos';
import {
  EntityId,
  InvalidTradingInputError,
  REQUEST_STATUSES,
  STATUS_LOG_EVENT_TYPES,
  type StatusLogRecord,
} from '../../../domain';
import {
  assertEnumValue,
  bigintToId,
  dateToInstant,
  idToBigInt,
  nullableBigintToId,
  nullableEnumValue,
  nullableIdToBigInt,
  optionalIdToBigInt,
  parseInstantOrDate,
  toActorDto,
  toNullableActorDto,
} from './shared-persistence.mapper';

export class StatusLogMapper {
  static toDomain(row: PrismaStatusLog): PersistedStatusLogRecord {
    return Object.freeze({
      id: bigintToId(row.id, 'status_log.id'),
      request_id: bigintToId(row.request_id, 'status_log.request_id'),
      event_type: assertEnumValue(
        row.event_type,
        STATUS_LOG_EVENT_TYPES,
        'status_log.event_type',
      ),
      prev_status: nullableEnumValue(
        row.prev_status,
        REQUEST_STATUSES,
        'status_log.prev_status',
      ),
      new_status: assertEnumValue(
        row.new_status,
        REQUEST_STATUSES,
        'status_log.new_status',
      ),
      performed_by: nullableBigintToId(
        row.performed_by,
        'status_log.performed_by',
      ),
      is_admin_action: row.is_admin_action,
      note: row.note ?? null,
      evidence: row.evidence ?? null,
      created_at: parseInstantOrDate(row.created_at, 'status_log.created_at'),
    });
  }

  static toPrismaCreateInput(
    record: StatusLogRecord & { readonly id?: Id },
  ): Prisma.StatusLogUncheckedCreateInput {
    const eventType = assertEnumValue(
      record.event_type,
      STATUS_LOG_EVENT_TYPES,
      'status_log.event_type',
    );
    const prevStatus = nullableEnumValue(
      record.prev_status,
      REQUEST_STATUSES,
      'status_log.prev_status',
    );
    const newStatus = assertEnumValue(
      record.new_status,
      REQUEST_STATUSES,
      'status_log.new_status',
    );

    return {
      ...(record.id !== undefined
        ? { id: optionalIdToBigInt(record.id, 'status_log.id') }
        : {}),
      request_id: idToBigInt(record.request_id, 'status_log.request_id'),
      event_type: eventType,
      prev_status: prevStatus,
      new_status: newStatus,
      performed_by: nullableIdToBigInt(
        record.performed_by,
        'status_log.performed_by',
      ),
      is_admin_action: record.is_admin_action,
      note: record.note ?? null,
      evidence: record.evidence ?? null,
      created_at: parseInstantOrDate(
        record.created_at,
        'status_log.created_at',
      ),
    };
  }

  static toDto(
    record: PersistedStatusLogRecord,
    performedByActor: ActorDto | null,
  ): RequestEventDto {
    return Object.freeze({
      id: EntityId.of(record.id, 'status_log.id').value,
      event_type: record.event_type,
      prev_status: record.prev_status,
      new_status: record.new_status,
      performed_by: toNullableActorDto(performedByActor),
      created_at: dateToInstant(record.created_at, 'status_log.created_at'),
      is_admin_action: record.is_admin_action,
      note: record.note,
      evidence: record.evidence,
    });
  }

  static fromPrismaWithActorToDto(
    row: PrismaStatusLog & {
      readonly performedBy?: {
        readonly id: bigint;
        readonly display_name: string | null;
      } | null;
    },
  ): RequestEventDto {
    const domain = StatusLogMapper.toDomain(row);
    return StatusLogMapper.toDto(
      domain,
      toNullableActorDto(row.performedBy ?? null),
    );
  }

  static toDeliveryConfirmationDto(
    record: PersistedStatusLogRecord,
    performedByActor: ActorDto,
  ): DeliveryConfirmationDto {
    if (
      record.event_type !== 'received_by_buyer' &&
      record.event_type !== 'received_by_admin'
    ) {
      throw new InvalidTradingInputError(
        `StatusLog event "${record.event_type}" is not a delivery confirmation event.`,
        { field: 'event_type' },
      );
    }

    return Object.freeze({
      performed_by: toActorDto(performedByActor),
      performed_at: dateToInstant(record.created_at, 'performed_at'),
      is_admin_action: record.is_admin_action,
      reason: record.note,
      evidence: record.evidence,
    });
  }
}
