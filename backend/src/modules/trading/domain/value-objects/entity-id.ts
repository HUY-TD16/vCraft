import { InvalidTradingInputError } from '../errors/trading-domain.errors';

const POSITIVE_DECIMAL_ID_REGEX = /^[1-9][0-9]*$/;
const MAX_BIGINT_ID = 9223372036854775807n;

export class EntityId {
  readonly value: string;

  private constructor(value: string) {
    this.value = value;
    Object.freeze(this);
  }

  static of(raw: string | bigint | number, fieldName: string = 'id'): EntityId {
    const normalized = typeof raw === 'string' ? raw : String(raw);
    if (!POSITIVE_DECIMAL_ID_REGEX.test(normalized)) {
      throw new InvalidTradingInputError(
        `${fieldName} must be a positive decimal integer string.`,
        { field: fieldName },
      );
    }

    const asBigInt = BigInt(normalized);
    if (asBigInt <= 0n || asBigInt > MAX_BIGINT_ID) {
      throw new InvalidTradingInputError(
        `${fieldName} exceeds the 64-bit signed integer range.`,
        { field: fieldName },
      );
    }

    return new EntityId(normalized);
  }

  toBigInt(): bigint {
    return BigInt(this.value);
  }

  equals(other: EntityId | string): boolean {
    const otherValue = typeof other === 'string' ? other : other.value;
    return this.value === otherValue;
  }

  toString(): string {
    return this.value;
  }

  static compare(left: EntityId | string, right: EntityId | string): number {
    const leftId = left instanceof EntityId ? left : EntityId.of(left);
    const rightId = right instanceof EntityId ? right : EntityId.of(right);
    const a = leftId.toBigInt();
    const b = rightId.toBigInt();
    if (a < b) {
      return -1;
    }
    if (a > b) {
      return 1;
    }
    return 0;
  }

  static sortAscending(ids: readonly (EntityId | string)[]): string[] {
    return [...ids]
      .map((item) => (item instanceof EntityId ? item.value : EntityId.of(item).value))
      .sort((a, b) => EntityId.compare(a, b));
  }
}
