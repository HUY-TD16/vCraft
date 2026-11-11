import {
  InsufficientCapacityError,
  InvalidTradingInputError,
  TRADING_INVARIANTS,
} from '../errors/trading-domain.errors';

const MAX_INT32_QUANTITY = 2147483647;

export class Quantity {
  readonly value: number;

  private constructor(value: number) {
    this.value = value;
    Object.freeze(this);
  }

  static of(value: number, fieldName: string = 'quantity'): Quantity {
    if (!Number.isInteger(value) || value < 1 || value > MAX_INT32_QUANTITY) {
      throw new InvalidTradingInputError(
        `${fieldName} must be a positive integer between 1 and ${MAX_INT32_QUANTITY}.`,
        {
          invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
          field: fieldName,
        },
      );
    }
    return new Quantity(value);
  }

  equals(other: Quantity | number): boolean {
    const otherValue = typeof other === 'number' ? other : other.value;
    return this.value === otherValue;
  }

  canSatisfyFull(required: Quantity | number): boolean {
    const reqValue = typeof required === 'number' ? required : required.value;
    return this.value >= reqValue;
  }

  assertCanSatisfyDirectAccept(required: Quantity | number): void {
    const req = required instanceof Quantity ? required : Quantity.of(required, 'request.quantity');
    if (this.value < req.value) {
      throw new InsufficientCapacityError(
        `Direct acceptance requires 100% capacity (${req.value}), but quote only supports ${this.value}.`,
        {
          invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
          field: 'max_quantity',
        },
      );
    }
  }

  assertNotExceedingRequestQuantity(requestQuantity: Quantity | number): void {
    const req =
      requestQuantity instanceof Quantity
        ? requestQuantity
        : Quantity.of(requestQuantity, 'request.quantity');
    if (this.value > req.value) {
      throw new InvalidTradingInputError(
        `max_quantity (${this.value}) cannot exceed request.quantity (${req.value}).`,
        {
          invariant: TRADING_INVARIANTS.INV_03_QUANTITY_AND_SPLIT_PROPOSAL,
          field: 'max_quantity',
        },
      );
    }
  }

  static sumAsBigInt(quantities: readonly (Quantity | number)[]): bigint {
    let total = 0n;
    for (const item of quantities) {
      const q = item instanceof Quantity ? item.value : Quantity.of(item).value;
      total += BigInt(q);
    }
    return total;
  }

  static sumAsDecimalString(quantities: readonly (Quantity | number)[]): string {
    return Quantity.sumAsBigInt(quantities).toString(10);
  }
}
