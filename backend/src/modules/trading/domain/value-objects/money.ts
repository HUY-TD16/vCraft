import { InvalidTradingInputError } from '../errors/trading-domain.errors';
import { Quantity } from './quantity';

const MAX_VND_UNIT_PRICE = 999_999_999_999_999;
const NON_NEGATIVE_INTEGER_STRING_REGEX = /^(0|[1-9][0-9]*)$/;

export class UnitPrice {
  readonly value: number;

  private constructor(value: number) {
    this.value = value;
    Object.freeze(this);
  }

  static of(value: number | bigint | string, fieldName: string = 'unit_price'): UnitPrice {
    const numeric =
      typeof value === 'number'
        ? value
        : typeof value === 'bigint'
          ? Number(value)
          : Number(value);

    if (
      !Number.isSafeInteger(numeric) ||
      numeric < 1 ||
      numeric > MAX_VND_UNIT_PRICE
    ) {
      throw new InvalidTradingInputError(
        `${fieldName} must be an integer VND amount between 1 and ${MAX_VND_UNIT_PRICE}.`,
        { field: fieldName },
      );
    }

    return new UnitPrice(numeric);
  }

  toBigInt(): bigint {
    return BigInt(this.value);
  }

  equals(other: UnitPrice | number): boolean {
    const otherValue = typeof other === 'number' ? other : other.value;
    return this.value === otherValue;
  }

  calculateLineTotal(quantity: Quantity | number): string {
    const qty = quantity instanceof Quantity ? quantity : Quantity.of(quantity, 'quantity');
    return (BigInt(this.value) * BigInt(qty.value)).toString(10);
  }

  static sumAmounts(amounts: readonly (string | bigint)[]): string {
    let total = 0n;
    for (const amount of amounts) {
      if (typeof amount === 'bigint') {
        if (amount < 0n) {
          throw new InvalidTradingInputError('Monetary amount cannot be negative.', {
            field: 'total_amount',
          });
        }
        total += amount;
      } else {
        if (!NON_NEGATIVE_INTEGER_STRING_REGEX.test(amount)) {
          throw new InvalidTradingInputError(
            'Monetary amount string must match ^(0|[1-9][0-9]*)$.',
            { field: 'total_amount' },
          );
        }
        total += BigInt(amount);
      }
    }
    return total.toString(10);
  }
}

export { UnitPrice as Money };
