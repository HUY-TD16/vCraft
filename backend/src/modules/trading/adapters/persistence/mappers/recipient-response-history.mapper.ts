import type {
  Prisma,
  RecipientResponseHistory as PrismaRecipientResponseHistory,
} from '../../../../../generated/prisma/client';
import type { Id } from '../../../../../common/application/types/contract-types';
import type {
  ActorDto,
  PersistedRecipientResponseRecord,
  QuoteSnapshotDto,
  RecipientEventDto,
} from '../../../application/dtos/trading-persistence.dtos';
import {
  EntityId,
  InvalidTradingInputError,
  Quantity,
  QUOTE_STATUSES,
  type QuoteSnapshotData,
  RECIPIENT_EVENT_TYPES,
  RECIPIENT_RESPONSE_STATUSES,
  type RecipientResponseRecord,
  UnitPrice,
  Version,
} from '../../../domain';
import {
  assertEnumValue,
  bigintToId,
  dateToInstant,
  decimalToUnitPrice,
  idToBigInt,
  nullableBigintToId,
  nullableIdToBigInt,
  optionalIdToBigInt,
  parseInstantOrDate,
  toActorDto,
} from './shared-persistence.mapper';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Mapper for `RecipientResponseHistory` and its `quote_snapshot` JSONB column.
 * Strictly enforces the 6-field allowlist (`data-design.md` §2.23, `api-dtos.md` §2.3):
 * `{ unit_price, max_quantity, bid_accept_deadline, committed_delivery_at, status, version }`.
 */
export class RecipientResponseHistoryMapper {
  static toQuoteSnapshotDomain(raw: unknown): QuoteSnapshotData | null {
    if (raw === null || raw === undefined) {
      return null;
    }
    if (!isPlainRecord(raw)) {
      throw new InvalidTradingInputError(
        'quote_snapshot must be a JSON object or null.',
        { field: 'quote_snapshot' },
      );
    }

    const rawPrice = raw['unit_price'];
    if (
      typeof rawPrice !== 'number' &&
      typeof rawPrice !== 'string' &&
      typeof rawPrice !== 'bigint'
    ) {
      throw new InvalidTradingInputError(
        'quote_snapshot.unit_price must be a positive integer.',
        { field: 'quote_snapshot.unit_price' },
      );
    }

    const unitPrice = decimalToUnitPrice(rawPrice, 'quote_snapshot.unit_price');
    const maxQuantity = Quantity.of(
      Number(raw['max_quantity']),
      'quote_snapshot.max_quantity',
    ).value;
    const bidAcceptDeadline = parseInstantOrDate(
      raw['bid_accept_deadline'],
      'quote_snapshot.bid_accept_deadline',
    );
    const committedDeliveryAt = parseInstantOrDate(
      raw['committed_delivery_at'],
      'quote_snapshot.committed_delivery_at',
    );
    const status = assertEnumValue(
      raw['status'],
      QUOTE_STATUSES,
      'quote_snapshot.status',
    );
    const version = Version.of(
      Number(raw['version']),
      'quote_snapshot.version',
    ).value;

    return Object.freeze({
      unit_price: unitPrice,
      max_quantity: maxQuantity,
      bid_accept_deadline: bidAcceptDeadline,
      committed_delivery_at: committedDeliveryAt,
      status,
      version,
    });
  }

  /**
   * Serializes `QuoteSnapshotData` into a strict 6-field JSON object for JSONB persistence.
   * Extra properties are never persisted.
   */
  static toQuoteSnapshotJson(
    snapshot: QuoteSnapshotData | null | undefined,
  ): Prisma.InputJsonValue | typeof Prisma.DbNull {
    if (snapshot === null || snapshot === undefined) {
      return (
        // Return null-compatible JSON value for Prisma
        null as unknown as typeof Prisma.DbNull
      );
    }

    const validatedPrice = UnitPrice.of(
      snapshot.unit_price,
      'quote_snapshot.unit_price',
    ).value;
    const validatedQuantity = Quantity.of(
      snapshot.max_quantity,
      'quote_snapshot.max_quantity',
    ).value;
    const validatedStatus = assertEnumValue(
      snapshot.status,
      QUOTE_STATUSES,
      'quote_snapshot.status',
    );
    const validatedVersion = Version.of(
      snapshot.version,
      'quote_snapshot.version',
    ).value;

    return {
      unit_price: validatedPrice,
      max_quantity: validatedQuantity,
      bid_accept_deadline: dateToInstant(
        snapshot.bid_accept_deadline,
        'quote_snapshot.bid_accept_deadline',
      ),
      committed_delivery_at: dateToInstant(
        snapshot.committed_delivery_at,
        'quote_snapshot.committed_delivery_at',
      ),
      status: validatedStatus,
      version: validatedVersion,
    };
  }

  static toQuoteSnapshotDto(
    snapshot: QuoteSnapshotData | null | undefined,
  ): QuoteSnapshotDto | null {
    if (snapshot === null || snapshot === undefined) {
      return null;
    }

    return Object.freeze({
      unit_price: UnitPrice.of(snapshot.unit_price, 'quote_snapshot.unit_price')
        .value,
      max_quantity: Quantity.of(
        snapshot.max_quantity,
        'quote_snapshot.max_quantity',
      ).value,
      bid_accept_deadline: dateToInstant(
        snapshot.bid_accept_deadline,
        'quote_snapshot.bid_accept_deadline',
      ),
      committed_delivery_at: dateToInstant(
        snapshot.committed_delivery_at,
        'quote_snapshot.committed_delivery_at',
      ),
      status: assertEnumValue(
        snapshot.status,
        QUOTE_STATUSES,
        'quote_snapshot.status',
      ),
      version: Version.of(snapshot.version, 'quote_snapshot.version').value,
    });
  }

  static toDomain(
    row: PrismaRecipientResponseHistory,
  ): PersistedRecipientResponseRecord {
    const eventType = assertEnumValue(
      row.event_type,
      RECIPIENT_EVENT_TYPES,
      'recipient_response_history.event_type',
    );
    const prevStatus = assertEnumValue(
      row.prev_status,
      RECIPIENT_RESPONSE_STATUSES,
      'recipient_response_history.prev_status',
    );
    const newStatus = assertEnumValue(
      row.new_status,
      RECIPIENT_RESPONSE_STATUSES,
      'recipient_response_history.new_status',
    );
    const quoteId = nullableBigintToId(
      row.quote_id,
      'recipient_response_history.quote_id',
    );
    const quoteSnapshot = RecipientResponseHistoryMapper.toQuoteSnapshotDomain(
      row.quote_snapshot,
    );

    if (eventType === 'declined') {
      if (quoteId !== null || quoteSnapshot !== null) {
        throw new InvalidTradingInputError(
          'Declined RecipientResponseHistory event must have quote_id = null and quote_snapshot = null.',
          { field: 'quote_snapshot' },
        );
      }
    } else if (quoteId === null || quoteSnapshot === null) {
      throw new InvalidTradingInputError(
        `RecipientResponseHistory event "${eventType}" requires both quote_id and quote_snapshot.`,
        { field: 'quote_snapshot' },
      );
    }

    return Object.freeze({
      id: bigintToId(row.id, 'recipient_response_history.id'),
      recipient_id: bigintToId(
        row.recipient_id,
        'recipient_response_history.recipient_id',
      ),
      quote_id: quoteId,
      event_type: eventType,
      prev_status: prevStatus,
      new_status: newStatus,
      reason: row.reason ?? null,
      quote_snapshot: quoteSnapshot,
      performed_by: bigintToId(
        row.performed_by,
        'recipient_response_history.performed_by',
      ),
      created_at: parseInstantOrDate(
        row.created_at,
        'recipient_response_history.created_at',
      ),
    });
  }

  static toPrismaCreateInput(
    record: RecipientResponseRecord & { readonly id?: Id },
    NullValue:
      | typeof Prisma.JsonNull
      | typeof Prisma.DbNull
      | undefined = undefined,
  ): Prisma.RecipientResponseHistoryUncheckedCreateInput {
    const eventType = assertEnumValue(
      record.event_type,
      RECIPIENT_EVENT_TYPES,
      'recipient_response_history.event_type',
    );
    const prevStatus = assertEnumValue(
      record.prev_status,
      RECIPIENT_RESPONSE_STATUSES,
      'recipient_response_history.prev_status',
    );
    const newStatus = assertEnumValue(
      record.new_status,
      RECIPIENT_RESPONSE_STATUSES,
      'recipient_response_history.new_status',
    );

    if (eventType === 'declined') {
      if (record.quote_id !== null || record.quote_snapshot !== null) {
        throw new InvalidTradingInputError(
          'Declined RecipientResponseHistory event must have quote_id = null and quote_snapshot = null.',
          { field: 'quote_snapshot' },
        );
      }
    } else if (record.quote_id === null || record.quote_snapshot === null) {
      throw new InvalidTradingInputError(
        `RecipientResponseHistory event "${eventType}" requires both quote_id and quote_snapshot.`,
        { field: 'quote_snapshot' },
      );
    }

    const serializedSnapshot =
      record.quote_snapshot !== null
        ? RecipientResponseHistoryMapper.toQuoteSnapshotJson(
            record.quote_snapshot,
          )
        : NullValue;

    return {
      ...(record.id !== undefined
        ? { id: optionalIdToBigInt(record.id, 'recipient_response_history.id') }
        : {}),
      recipient_id: idToBigInt(
        record.recipient_id,
        'recipient_response_history.recipient_id',
      ),
      quote_id: nullableIdToBigInt(
        record.quote_id,
        'recipient_response_history.quote_id',
      ),
      event_type: eventType,
      prev_status: prevStatus,
      new_status: newStatus,
      reason: record.reason ?? null,
      ...(serializedSnapshot !== undefined
        ? { quote_snapshot: serializedSnapshot }
        : {}),
      performed_by: idToBigInt(
        record.performed_by,
        'recipient_response_history.performed_by',
      ),
      created_at: parseInstantOrDate(
        record.created_at,
        'recipient_response_history.created_at',
      ),
    };
  }

  static toDto(
    record: PersistedRecipientResponseRecord,
    performedByActor: ActorDto,
  ): RecipientEventDto {
    return Object.freeze({
      id: EntityId.of(record.id, 'recipient_response_history.id').value,
      event_type: record.event_type,
      prev_status: record.prev_status,
      new_status: record.new_status,
      reason: record.reason,
      quote_snapshot: RecipientResponseHistoryMapper.toQuoteSnapshotDto(
        record.quote_snapshot,
      ),
      performed_by: toActorDto(performedByActor),
      created_at: dateToInstant(
        record.created_at,
        'recipient_response_history.created_at',
      ),
    });
  }

  static fromPrismaWithActorToDto(
    row: PrismaRecipientResponseHistory & {
      readonly performedBy: {
        readonly id: bigint;
        readonly display_name: string | null;
      };
    },
  ): RecipientEventDto {
    const domain = RecipientResponseHistoryMapper.toDomain(row);
    return RecipientResponseHistoryMapper.toDto(
      domain,
      toActorDto(row.performedBy),
    );
  }
}
