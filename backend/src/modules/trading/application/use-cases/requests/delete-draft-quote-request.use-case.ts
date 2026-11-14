import type { TransactionRunner } from '../../../../../common/application/ports/transaction-runner';
import type {
  Id,
  TrustedActor,
} from '../../../../../common/application/types/contract-types';
import {
  QuoteRequestNotFoundError,
  TradingPermissionDeniedError,
  InvalidTradingInputError,
} from '../../../domain';
import type { IQuoteRequestRepository } from '../../ports/repositories/trading-repositories.port';

export interface DeleteDraftQuoteRequestInput {
  readonly actor: TrustedActor;
  readonly requestId?: Id;
  readonly id?: Id;
  readonly expectedRequestVersion?: number;
  readonly expected_request_version?: number;
}

export class DeleteDraftQuoteRequestUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
  ) {}

  async execute(input: DeleteDraftQuoteRequestInput): Promise<void> {
    if (input.actor.role !== 'buyer') {
      throw new TradingPermissionDeniedError(
        'Only buyers can delete draft quote requests.',
      );
    }

    const requestId = input.requestId ?? input.id;
    if (!requestId || !requestId.trim()) {
      throw new InvalidTradingInputError('requestId is required.', {
        field: 'requestId',
      });
    }

    const expectedVersion =
      input.expectedRequestVersion ?? input.expected_request_version;

    await this.txRunner.run(async (tx) => {
      const quoteRequest = await this.quoteRequestRepo.lockById(requestId, tx);
      if (!quoteRequest) {
        throw new QuoteRequestNotFoundError(
          `QuoteRequest ${requestId} was not found.`,
          { requestId },
        );
      }

      quoteRequest.assertCanBeDeletedBy(input.actor.accountId, expectedVersion);

      await this.quoteRequestRepo.deleteDraft(
        {
          requestId: quoteRequest.id,
          buyerId: input.actor.accountId,
          expectedVersion: quoteRequest.version,
        },
        tx,
      );
    });
  }
}
