import { assertTradingActor } from '../../helpers/trading-actor.helper';
import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  Id,
  TrustedActor,
} from '../../../../../common/application/types/contract-types';
import {
  QuoteRequestNotFoundError,
  TradingDomainError,
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
  readonly tx?: TransactionContext;
}

export class DeleteDraftQuoteRequestUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
  ) {}

  async execute(input: DeleteDraftQuoteRequestInput): Promise<void> {
    assertTradingActor(input.actor, {
      expectedRole: 'buyer',
      tempPasswordMessage: 'Temporary password session cannot delete draft quote requests.',
      roleDeniedMessage: 'Only buyers can delete draft quote requests.',
    });

    const requestId = input.requestId ?? input.id;
    if (!requestId || !requestId.trim()) {
      throw new InvalidTradingInputError('requestId is required.', {
        field: 'requestId',
      });
    }

    const expectedVersion =
      input.expectedRequestVersion ?? input.expected_request_version;

    const runWithTx = async (tx: TransactionContext): Promise<void> => {
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
    };

    if (input.tx) {
      await runWithTx(input.tx);
      return;
    }

    await this.txRunner.run((tx) => runWithTx(tx));
  }
}
