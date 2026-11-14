import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  Id,
  TrustedActor,
} from '../../../../../common/application/types/contract-types';
import {
  QuoteRequest,
  QuoteRequestNotFoundError,
  TradingPermissionDeniedError,
  InvalidTradingInputError,
} from '../../../domain';
import type { IQuoteRequestRepository } from '../../ports/repositories/trading-repositories.port';

export interface UpdateRecipientContactInput {
  readonly actor: TrustedActor;
  readonly requestId?: Id;
  readonly id?: Id;
  readonly expectedRequestVersion?: number;
  readonly expected_request_version?: number;
  readonly recipientName?: string;
  readonly recipient_name?: string;
  readonly recipientPhone?: string;
  readonly recipient_phone?: string;
  readonly tx?: TransactionContext;
}

export class UpdateRecipientContactUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
  ) {}

  async execute(input: UpdateRecipientContactInput): Promise<QuoteRequest> {
    if (input.actor.role !== 'buyer') {
      throw new TradingPermissionDeniedError(
        'Only buyers can update recipient contact information.',
      );
    }

    const requestId = input.requestId ?? input.id;
    if (!requestId) {
      throw new InvalidTradingInputError('requestId is required.', {
        field: 'requestId',
      });
    }

    const expectedVersion =
      input.expectedRequestVersion ?? input.expected_request_version;
    if (expectedVersion === undefined || expectedVersion === null) {
      throw new InvalidTradingInputError(
        'expected_request_version is required for updating recipient contact.',
        { field: 'expected_request_version' },
      );
    }

    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new InvalidTradingInputError(
        'expected_request_version must be a positive integer.',
        { field: 'expected_request_version' },
      );
    }

    const recipientName =
      input.recipientName !== undefined
        ? input.recipientName
        : input.recipient_name;
    const recipientPhone =
      input.recipientPhone !== undefined
        ? input.recipientPhone
        : input.recipient_phone;

    if (recipientName === undefined && recipientPhone === undefined) {
      throw new InvalidTradingInputError(
        'At least one of recipient_name or recipient_phone must be provided.',
        { field: 'recipient_name' },
      );
    }

    const runWithTx = async (tx: TransactionContext): Promise<QuoteRequest> => {
      const existing = await this.quoteRequestRepo.lockById(requestId, tx);
      if (!existing) {
        throw new QuoteRequestNotFoundError(
          `QuoteRequest ${requestId} was not found.`,
          { entity: 'QuoteRequest', id: requestId },
        );
      }

      if (existing.buyer_id !== input.actor.accountId) {
        throw new TradingPermissionDeniedError(
          'Actor is not the Buyer owner of this QuoteRequest.',
          { entity: 'QuoteRequest' },
        );
      }

      const now = new Date();
      const { request: updated, contactEditHistory } =
        existing.updateRecipientContact({
          buyerId: input.actor.accountId,
          expectedVersion,
          recipientName,
          recipientPhone,
          now,
        });

      return this.quoteRequestRepo.update(
        {
          request: updated,
          expectedVersion,
          contactEditHistory,
        },
        tx,
      );
    };

    if (input.tx) {
      return runWithTx(input.tx);
    }

    return this.txRunner.run((tx) => runWithTx(tx));
  }
}
