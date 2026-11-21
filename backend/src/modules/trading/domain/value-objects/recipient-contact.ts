import { InvalidTradingInputError } from '../errors/trading-domain.errors';

const MAX_RECIPIENT_NAME_LENGTH = 200;
const MAX_RECIPIENT_PHONE_LENGTH = 20;

export class RecipientContact {
  readonly recipientName: string;
  readonly recipientPhone: string;

  private constructor(recipientName: string, recipientPhone: string) {
    this.recipientName = recipientName;
    this.recipientPhone = recipientPhone;
    Object.freeze(this);
  }

  static of(recipientName: string, recipientPhone: string): RecipientContact {
    const trimmedName = recipientName.trim();
    const trimmedPhone = recipientPhone.trim();

    if (trimmedName.length === 0 || trimmedName.length > MAX_RECIPIENT_NAME_LENGTH) {
      throw new InvalidTradingInputError(
        `recipient_name must be a non-empty string up to ${MAX_RECIPIENT_NAME_LENGTH} characters.`,
        { field: 'recipient_name' },
      );
    }

    if (trimmedPhone.length === 0 || trimmedPhone.length > MAX_RECIPIENT_PHONE_LENGTH) {
      throw new InvalidTradingInputError(
        `recipient_phone must be a non-empty string up to ${MAX_RECIPIENT_PHONE_LENGTH} characters.`,
        { field: 'recipient_phone' },
      );
    }

    return new RecipientContact(trimmedName, trimmedPhone);
  }

  equals(other: RecipientContact): boolean {
    return (
      this.recipientName === other.recipientName &&
      this.recipientPhone === other.recipientPhone
    );
  }
}
