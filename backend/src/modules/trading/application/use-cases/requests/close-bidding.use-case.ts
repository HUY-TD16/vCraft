import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  Id,
  TrustedActor,
} from '../../../../../common/application/types/contract-types';
import {
  InvalidTradingInputError,
  QuoteRequest,
  QuoteRequestNotFoundError,
  TradingPermissionDeniedError,
} from '../../../domain';
import type { IQuoteRequestRepository } from '../../ports/repositories/trading-repositories.port';

export interface CloseBiddingInput {
  readonly actor: TrustedActor;
  readonly requestId?: Id;
  readonly id?: Id;
  readonly expectedRequestVersion?: number;
  readonly expected_request_version?: number;
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export class CloseBiddingUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
  ) {}

  async execute(input: CloseBiddingInput): Promise<QuoteRequest> {
    if (input.actor.role !== 'buyer') {
      throw new TradingPermissionDeniedError('Only buyers can close bidding.');
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
        'expected_request_version is required for closing bidding.',
        { field: 'expected_request_version' },
      );
    }

    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new InvalidTradingInputError(
        'expected_request_version must be a positive integer.',
        { field: 'expected_request_version' },
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

      const now = input.now ?? new Date();
      const { request: updated, statusLog } = existing.closeBiddingEarly({
        buyerId: input.actor.accountId,
        expectedVersion,
        now,
      });

      return this.quoteRequestRepo.update(
        {
          request: updated,
          expectedVersion,
          statusLogs: [statusLog],
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
