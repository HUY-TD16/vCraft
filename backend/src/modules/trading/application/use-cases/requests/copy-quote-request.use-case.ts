import type { TransactionRunner } from '../../../../../common/application/ports/transaction-runner';
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

export interface CopyQuoteRequestInput {
  readonly actor: TrustedActor;
  readonly requestId?: Id;
  readonly id?: Id;
}

export class CopyQuoteRequestUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
  ) {}

  /**
   * Duplicates an existing QuoteRequest into a new Draft QuoteRequest.
   *
   * Business Rules:
   * - Actor must have role 'buyer'.
   * - SEC-06: If source QuoteRequest does not exist OR belongs to another buyer,
   *   QuoteRequestNotFoundError (HTTP 404) is thrown to prevent ID enumeration.
   * - Permissive state: Source request in ANY status (even 'cancelled' or 'delivered') can be copied.
   * - Specifications and delivery details are copied verbatim.
   * - Operational artifacts, child entities, deadlines, and cancellations are completely reset.
   */
  async execute(input: CopyQuoteRequestInput): Promise<QuoteRequest> {
    if (input.actor.role !== 'buyer') {
      throw new TradingPermissionDeniedError(
        'Only buyers can copy quote requests.',
      );
    }

    const requestId = input.requestId ?? input.id;
    if (!requestId || !requestId.trim()) {
      throw new InvalidTradingInputError('requestId is required.', {
        field: 'requestId',
      });
    }

    return this.txRunner.run(async (tx) => {
      const existing = await this.quoteRequestRepo.findById(requestId, tx);

      // SEC-06 Enforcement: Uniform 404 on both missing and foreign-owned requests
      if (!existing || existing.buyer_id !== input.actor.accountId) {
        throw new QuoteRequestNotFoundError(
          `QuoteRequest ${requestId} was not found.`,
          { entity: 'QuoteRequest', id: requestId },
        );
      }

      const { request, statusLog } = existing.copyAsDraft({
        newId: '1',
        buyerId: input.actor.accountId,
        now: new Date(),
      });

      return this.quoteRequestRepo.createDraft(
        {
          request,
          statusLog,
          useEntityId: false,
        },
        tx,
      );
    });
  }
}
