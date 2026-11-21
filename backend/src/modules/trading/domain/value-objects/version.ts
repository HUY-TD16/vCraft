import {
  ConcurrencyConflictError,
  InvalidTradingInputError,
  TRADING_INVARIANTS,
} from '../errors/trading-domain.errors';

const MAX_INT32 = 2147483647;

export class Version {
  readonly value: number;

  private constructor(value: number) {
    this.value = value;
    Object.freeze(this);
  }

  static initial(): Version {
    return new Version(1);
  }

  static of(value: number, fieldName: string = 'version'): Version {
    if (!Number.isInteger(value) || value < 1 || value > MAX_INT32) {
      throw new InvalidTradingInputError(
        `${fieldName} must be an integer between 1 and ${MAX_INT32}.`,
        { field: fieldName },
      );
    }
    return new Version(value);
  }

  next(): Version {
    if (this.value >= MAX_INT32) {
      throw new InvalidTradingInputError('Version overflow beyond 32-bit signed integer limit.', {
        field: 'version',
      });
    }
    return new Version(this.value + 1);
  }

  equals(other: Version | number): boolean {
    const otherValue = typeof other === 'number' ? other : other.value;
    return this.value === otherValue;
  }

  assertMatches(expected: Version | number, entityName: string = 'Entity'): void {
    const expectedVersion =
      expected instanceof Version ? expected : Version.of(expected, 'expected_version');
    if (this.value !== expectedVersion.value) {
      throw new ConcurrencyConflictError(
        `${entityName} version mismatch: expected ${expectedVersion.value}, actual ${this.value}.`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: entityName,
        },
      );
    }
  }
}
