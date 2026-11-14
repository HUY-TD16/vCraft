import type { TransactionRunner } from '../../../../../common/application/ports/transaction-runner';
import type {
  Id,
  TrustedActor,
} from '../../../../../common/application/types/contract-types';
import {
  QuoteRequest,
  type RequestUnit,
  type DeliveryMode,
  TradingPermissionDeniedError,
} from '../../../domain';
import type { IQuoteRequestRepository } from '../../ports/repositories/trading-repositories.port';

export interface CreateDraftQuoteRequestDraftInput {
  readonly category_id?: Id | null;
  readonly spec?: string | null;
  readonly quantity?: number | null;
  readonly unit?: RequestUnit | null;
  readonly unit_set_description?: string | null;
  readonly delivery_mode?: DeliveryMode | null;
  readonly delivery_region?: string | null;
  readonly delivery_address?: string | null;
  readonly recipient_name?: string | null;
  readonly recipient_phone?: string | null;
  readonly bidding_deadline?: Date | string | null;
  readonly delivery_deadline?: Date | string | null;
}

export interface CreateDraftQuoteRequestInput {
  readonly actor: TrustedActor;
  readonly draft: CreateDraftQuoteRequestDraftInput;
}

export class CreateDraftQuoteRequestUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
  ) {}

  async execute(input: CreateDraftQuoteRequestInput): Promise<QuoteRequest> {
    if (input.actor.role !== 'buyer') {
      throw new TradingPermissionDeniedError(
        'Only buyers can create draft quote requests.',
      );
    }

    const now = new Date();
    const biddingDeadline = input.draft.bidding_deadline
      ? new Date(input.draft.bidding_deadline)
      : null;
    const deliveryDeadline = input.draft.delivery_deadline
      ? new Date(input.draft.delivery_deadline)
      : null;

    const { request, statusLog } = QuoteRequest.createDraft({
      id: '1',
      buyer_id: input.actor.accountId,
      draft: {
        category_id: input.draft.category_id ?? null,
        spec: input.draft.spec ?? null,
        quantity: input.draft.quantity ?? null,
        unit: input.draft.unit ?? null,
        unit_set_description: input.draft.unit_set_description ?? null,
        delivery_mode: input.draft.delivery_mode ?? null,
        delivery_region: input.draft.delivery_region ?? null,
        delivery_address: input.draft.delivery_address ?? null,
        recipient_name: input.draft.recipient_name ?? null,
        recipient_phone: input.draft.recipient_phone ?? null,
        bidding_deadline: biddingDeadline,
        delivery_deadline: deliveryDeadline,
      },
      now,
    });

    return this.txRunner.run(async (tx) => {
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
