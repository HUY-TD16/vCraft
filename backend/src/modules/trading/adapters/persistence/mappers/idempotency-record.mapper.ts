import type {
  IdempotencyRecord as PrismaIdempotencyRecord,
  Prisma,
} from '../../../../../generated/prisma/client';
import type { Id } from '../../../../../common/application/types/contract-types';
import type { OperationMetadata } from '../../../../../common/application/types/operation-metadata';
import type {
  CreateIdempotencyRecordInput,
  PersistedIdempotencyRecord,
  TradingCurrentStateDto,
  TradingOperationMetadataDto,
} from '../../../application/dtos/trading-persistence.dtos';
import {
  EntityId,
  InvalidTradingInputError,
} from '../../../domain';
import {
  bigintToId,
  dateToInstant,
  idToBigInt,
  optionalIdToBigInt,
  parseInstantOrDate,
} from './shared-persistence.mapper';

const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

function validateNonBlankField(value: string, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidTradingInputError(
      `${fieldName} must be a non-empty string.`,
      { field: fieldName },
    );
  }
  return value.trim();
}

export class IdempotencyRecordMapper {
  static validateKey(rawKey: string): string {
    const trimmed = validateNonBlankField(
      rawKey,
      'idempotency_record.idempotency_key',
    );
    if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new InvalidTradingInputError(
        `idempotency_record.idempotency_key cannot exceed ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
        { field: 'idempotency_record.idempotency_key' },
      );
    }
    return trimmed;
  }

  static toDomain<TSnapshot = unknown>(
    row: PrismaIdempotencyRecord,
    snapshotParser?: (raw: unknown) => TSnapshot,
  ): PersistedIdempotencyRecord<TSnapshot> {
    const idempotencyKey = IdempotencyRecordMapper.validateKey(
      row.idempotency_key,
    );
    const requestFingerprint = validateNonBlankField(
      row.request_fingerprint,
      'idempotency_record.request_fingerprint',
    );
    const action = validateNonBlankField(
      row.action,
      'idempotency_record.action',
    );
    const objectType = validateNonBlankField(
      row.object_type,
      'idempotency_record.object_type',
    );
    const createdAt = parseInstantOrDate(
      row.created_at,
      'idempotency_record.created_at',
    );
    const expiresAt = parseInstantOrDate(
      row.expires_at,
      'idempotency_record.expires_at',
    );

    if (expiresAt.getTime() <= createdAt.getTime()) {
      throw new InvalidTradingInputError(
        'idempotency_record.expires_at must be strictly after created_at.',
        { field: 'idempotency_record.expires_at' },
      );
    }

    const parsedSnapshot = snapshotParser
      ? snapshotParser(row.result_snapshot)
      : (row.result_snapshot as TSnapshot);

    return Object.freeze({
      id: bigintToId(row.id, 'idempotency_record.id'),
      idempotency_key: idempotencyKey,
      request_fingerprint: requestFingerprint,
      account_id: bigintToId(row.account_id, 'idempotency_record.account_id'),
      action,
      object_type: objectType,
      object_id: bigintToId(row.object_id, 'idempotency_record.object_id'),
      result_snapshot: parsedSnapshot,
      created_at: createdAt,
      expires_at: expiresAt,
    });
  }

  static toPrismaCreateInput<TSnapshot = unknown>(
    input: CreateIdempotencyRecordInput<TSnapshot>,
  ): Prisma.IdempotencyRecordUncheckedCreateInput {
    const idempotencyKey = IdempotencyRecordMapper.validateKey(
      input.idempotency_key,
    );
    const requestFingerprint = validateNonBlankField(
      input.request_fingerprint,
      'idempotency_record.request_fingerprint',
    );
    const action = validateNonBlankField(
      input.action,
      'idempotency_record.action',
    );
    const objectType = validateNonBlankField(
      input.object_type,
      'idempotency_record.object_type',
    );
    const createdAt = parseInstantOrDate(
      input.created_at,
      'idempotency_record.created_at',
    );
    const expiresAt = parseInstantOrDate(
      input.expires_at,
      'idempotency_record.expires_at',
    );

    if (expiresAt.getTime() <= createdAt.getTime()) {
      throw new InvalidTradingInputError(
        'idempotency_record.expires_at must be strictly after created_at.',
        { field: 'idempotency_record.expires_at' },
      );
    }

    if (
      input.result_snapshot === null ||
      input.result_snapshot === undefined ||
      typeof input.result_snapshot !== 'object'
    ) {
      throw new InvalidTradingInputError(
        'idempotency_record.result_snapshot must be a non-null JSON object.',
        { field: 'idempotency_record.result_snapshot' },
      );
    }

    return {
      ...(input.id !== undefined
        ? { id: optionalIdToBigInt(input.id, 'idempotency_record.id') }
        : {}),
      idempotency_key: idempotencyKey,
      request_fingerprint: requestFingerprint,
      account_id: idToBigInt(
        EntityId.of(input.account_id, 'idempotency_record.account_id').value,
        'idempotency_record.account_id',
      ),
      action,
      object_type: objectType,
      object_id: idToBigInt(
        EntityId.of(input.object_id, 'idempotency_record.object_id').value,
        'idempotency_record.object_id',
      ),
      result_snapshot: input.result_snapshot as Prisma.InputJsonValue,
      created_at: createdAt,
      expires_at: expiresAt,
    };
  }

  static toOperationMetadata<
    TState extends TradingCurrentStateDto = TradingCurrentStateDto,
  >(input: {
    readonly id: Id;
    readonly replayed: boolean;
    readonly committedAt: Date;
    readonly currentState: TState;
  }): TradingOperationMetadataDto<TState> {
    const metadata: OperationMetadata<TState> = {
      id: EntityId.of(input.id, 'operation.id').value,
      replayed: input.replayed,
      committed_at: dateToInstant(input.committedAt, 'operation.committed_at'),
      current_state: input.currentState,
    };
    return Object.freeze(metadata);
  }
}
