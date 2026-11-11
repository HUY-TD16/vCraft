import { Prisma } from '../../../../../generated/prisma/client';
import type { Id, Instant } from '../../../../../common/application/types/contract-types';
import type {
  ActorDto,
  CategoryRefDto,
  WorkshopRefDto,
} from '../../../application/dtos/trading-persistence.dtos';
import {
  EntityId,
  InvalidTradingInputError,
  UnitPrice,
} from '../../../domain';

export function bigintToId(value: bigint, fieldName: string = 'id'): Id {
  if (typeof value !== 'bigint') {
    throw new InvalidTradingInputError(`${fieldName} must be a bigint.`, {
      field: fieldName,
    });
  }
  return EntityId.of(value.toString(), fieldName).value;
}

export function nullableBigintToId(
  value: bigint | null | undefined,
  fieldName: string = 'id',
): Id | null {
  if (value === null || value === undefined) {
    return null;
  }
  return bigintToId(value, fieldName);
}

export function idToBigInt(value: string, fieldName: string = 'id'): bigint {
  return EntityId.of(value, fieldName).toBigInt();
}

export function nullableIdToBigInt(
  value: string | null | undefined,
  fieldName: string = 'id',
): bigint | null {
  if (value === null || value === undefined) {
    return null;
  }
  return idToBigInt(value, fieldName);
}

export function optionalIdToBigInt(
  value: string | undefined,
  fieldName: string = 'id',
): bigint | undefined {
  if (value === undefined) {
    return undefined;
  }
  return idToBigInt(value, fieldName);
}

export function decimalToUnitPrice(
  value: Prisma.Decimal | number | string | bigint,
  fieldName: string = 'unit_price',
): number {
  let rawText: string;
  if (value instanceof Prisma.Decimal) {
    rawText = value.toFixed();
  } else if (typeof value === 'bigint') {
    rawText = value.toString();
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new InvalidTradingInputError(
        `${fieldName} must be a safe integer in VND.`,
        { field: fieldName },
      );
    }
    return UnitPrice.of(value, fieldName).value;
  } else if (typeof value === 'string') {
    rawText = value.trim();
  } else {
    throw new InvalidTradingInputError(`${fieldName} has an unsupported decimal type.`, {
      field: fieldName,
    });
  }

  if (!/^[1-9][0-9]*$/.test(rawText)) {
    throw new InvalidTradingInputError(
      `${fieldName} must be a positive integer string in VND (got "${rawText}").`,
      { field: fieldName },
    );
  }

  const parsed = Number(rawText);
  return UnitPrice.of(parsed, fieldName).value;
}

export function unitPriceToDecimal(
  value: number,
  fieldName: string = 'unit_price',
): Prisma.Decimal {
  const validated = UnitPrice.of(value, fieldName).value;
  return new Prisma.Decimal(validated.toString());
}

export function dateToInstant(
  value: Date,
  fieldName: string = 'timestamp',
): Instant {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidTradingInputError(
      `${fieldName} must be a valid Date instance.`,
      { field: fieldName },
    );
  }
  return value.toISOString();
}

export function nullableDateToInstant(
  value: Date | null | undefined,
  fieldName: string = 'timestamp',
): Instant | null {
  if (value === null || value === undefined) {
    return null;
  }
  return dateToInstant(value, fieldName);
}

export function parseInstantOrDate(
  value: unknown,
  fieldName: string = 'timestamp',
): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new InvalidTradingInputError(`${fieldName} is an invalid Date.`, {
        field: fieldName,
      });
    }
    return new Date(value.getTime());
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw new InvalidTradingInputError(
    `${fieldName} must be a valid ISO 8601 UTC string or Date.`,
    { field: fieldName },
  );
}

export function assertEnumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fieldName: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new InvalidTradingInputError(
      `Invalid value "${String(value)}" for ${fieldName}. Expected one of: ${allowed.join(', ')}.`,
      { field: fieldName },
    );
  }
  return value as T[number];
}

export function nullableEnumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fieldName: string,
): T[number] | null {
  if (value === null || value === undefined) {
    return null;
  }
  return assertEnumValue(value, allowed, fieldName);
}

/**
 * Maps an account reference strictly to `{ id, display_name }` (`docsAI/04-architecture/api-dtos.md` §1).
 * Never leaks `username`, `role`, `password_hash`, `phone`, or session data.
 */
export function toActorDto(actor: {
  readonly id: bigint | string;
  readonly display_name: string | null;
}): ActorDto {
  const id =
    typeof actor.id === 'bigint'
      ? bigintToId(actor.id, 'actor.id')
      : EntityId.of(actor.id, 'actor.id').value;
  return Object.freeze({
    id,
    display_name: actor.display_name ?? null,
  });
}

export function toNullableActorDto(
  actor:
    | {
        readonly id: bigint | string;
        readonly display_name: string | null;
      }
    | null
    | undefined,
): ActorDto | null {
  if (!actor) {
    return null;
  }
  return toActorDto(actor);
}

/**
 * Maps a workshop reference strictly to `{ id, name }` (`docsAI/04-architecture/api-dtos.md` §2.3).
 */
export function toWorkshopRefDto(workshop: {
  readonly id: bigint | string;
  readonly name: string;
}): WorkshopRefDto {
  const id =
    typeof workshop.id === 'bigint'
      ? bigintToId(workshop.id, 'workshop.id')
      : EntityId.of(workshop.id, 'workshop.id').value;
  if (typeof workshop.name !== 'string' || workshop.name.trim().length === 0) {
    throw new InvalidTradingInputError('workshop.name must be a non-empty string.', {
      field: 'workshop.name',
    });
  }
  return Object.freeze({
    id,
    name: workshop.name,
  });
}

/**
 * Maps a category reference strictly to `{ id, name }` (`docsAI/04-architecture/api-dtos.md` §2.2).
 */
export function toCategoryRefDto(
  category:
    | {
        readonly id: bigint | string;
        readonly name: string;
      }
    | null
    | undefined,
): CategoryRefDto | null {
  if (!category) {
    return null;
  }
  const id =
    typeof category.id === 'bigint'
      ? bigintToId(category.id, 'category.id')
      : EntityId.of(category.id, 'category.id').value;
  if (typeof category.name !== 'string' || category.name.trim().length === 0) {
    throw new InvalidTradingInputError('category.name must be a non-empty string.', {
      field: 'category.name',
    });
  }
  return Object.freeze({
    id,
    name: category.name,
  });
}
