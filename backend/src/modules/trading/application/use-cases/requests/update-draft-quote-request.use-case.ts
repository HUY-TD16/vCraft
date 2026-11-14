import type { TransactionRunner } from '../../../../../common/application/ports/transaction-runner';
import type {
  Id,
  TrustedActor,
} from '../../../../../common/application/types/contract-types';
import {
  QuoteRequest,
  type RequestUnit,
  type DeliveryMode,
  type DraftQuoteRequestInput,
  TradingPermissionDeniedError,
  QuoteRequestNotFoundError,
  InvalidTradingInputError,
} from '../../../domain';
import type { IQuoteRequestRepository } from '../../ports/repositories/trading-repositories.port';

export interface UpdateDraftQuoteRequestDraftInput {
  readonly category_id?: Id | null;
  readonly categoryId?: Id | null;
  readonly spec?: string | null;
  readonly quantity?: number | null;
  readonly unit?: RequestUnit | null;
  readonly unit_set_description?: string | null;
  readonly unitSetDescription?: string | null;
  readonly delivery_mode?: DeliveryMode | null;
  readonly deliveryMode?: DeliveryMode | null;
  readonly delivery_region?: string | null;
  readonly deliveryRegion?: string | null;
  readonly delivery_address?: string | null;
  readonly deliveryAddress?: string | null;
  readonly recipient_name?: string | null;
  readonly recipientName?: string | null;
  readonly recipient_phone?: string | null;
  readonly recipientPhone?: string | null;
  readonly bidding_deadline?: Date | string | null;
  readonly biddingDeadline?: Date | string | null;
  readonly delivery_deadline?: Date | string | null;
  readonly deliveryDeadline?: Date | string | null;
}

export interface UpdateDraftQuoteRequestInput {
  readonly actor: TrustedActor;
  readonly requestId?: Id;
  readonly id?: Id;
  readonly expectedRequestVersion?: number;
  readonly expected_request_version?: number;
  readonly draft?: UpdateDraftQuoteRequestDraftInput;
  readonly category_id?: Id | null;
  readonly categoryId?: Id | null;
  readonly spec?: string | null;
  readonly quantity?: number | null;
  readonly unit?: RequestUnit | null;
  readonly unit_set_description?: string | null;
  readonly unitSetDescription?: string | null;
  readonly delivery_mode?: DeliveryMode | null;
  readonly deliveryMode?: DeliveryMode | null;
  readonly delivery_region?: string | null;
  readonly deliveryRegion?: string | null;
  readonly delivery_address?: string | null;
  readonly deliveryAddress?: string | null;
  readonly recipient_name?: string | null;
  readonly recipientName?: string | null;
  readonly recipient_phone?: string | null;
  readonly recipientPhone?: string | null;
  readonly bidding_deadline?: Date | string | null;
  readonly biddingDeadline?: Date | string | null;
  readonly delivery_deadline?: Date | string | null;
  readonly deliveryDeadline?: Date | string | null;
}

export class UpdateDraftQuoteRequestUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
  ) {}

  async execute(input: UpdateDraftQuoteRequestInput): Promise<QuoteRequest> {
    if (input.actor.role !== 'buyer') {
      throw new TradingPermissionDeniedError(
        'Only buyers can update draft quote requests.',
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
        'expected_request_version is required for updating draft quote request.',
        { field: 'expected_request_version' },
      );
    }

    const d = input.draft ?? {};

    const categoryId =
      d.category_id !== undefined
        ? d.category_id
        : d.categoryId !== undefined
          ? d.categoryId
          : input.category_id !== undefined
            ? input.category_id
            : input.categoryId;

    const spec = d.spec !== undefined ? d.spec : input.spec;
    const quantity = d.quantity !== undefined ? d.quantity : input.quantity;
    const unit = d.unit !== undefined ? d.unit : input.unit;

    const unitSetDescription =
      d.unit_set_description !== undefined
        ? d.unit_set_description
        : d.unitSetDescription !== undefined
          ? d.unitSetDescription
          : input.unit_set_description !== undefined
            ? input.unit_set_description
            : input.unitSetDescription;

    const deliveryMode =
      d.delivery_mode !== undefined
        ? d.delivery_mode
        : d.deliveryMode !== undefined
          ? d.deliveryMode
          : input.delivery_mode !== undefined
            ? input.delivery_mode
            : input.deliveryMode;

    const deliveryRegion =
      d.delivery_region !== undefined
        ? d.delivery_region
        : d.deliveryRegion !== undefined
          ? d.deliveryRegion
          : input.delivery_region !== undefined
            ? input.delivery_region
            : input.deliveryRegion;

    const deliveryAddress =
      d.delivery_address !== undefined
        ? d.delivery_address
        : d.deliveryAddress !== undefined
          ? d.deliveryAddress
          : input.delivery_address !== undefined
            ? input.delivery_address
            : input.deliveryAddress;

    const recipientName =
      d.recipient_name !== undefined
        ? d.recipient_name
        : d.recipientName !== undefined
          ? d.recipientName
          : input.recipient_name !== undefined
            ? input.recipient_name
            : input.recipientName;

    const recipientPhone =
      d.recipient_phone !== undefined
        ? d.recipient_phone
        : d.recipientPhone !== undefined
          ? d.recipientPhone
          : input.recipient_phone !== undefined
            ? input.recipient_phone
            : input.recipientPhone;

    const rawBiddingDeadline =
      d.bidding_deadline !== undefined
        ? d.bidding_deadline
        : d.biddingDeadline !== undefined
          ? d.biddingDeadline
          : input.bidding_deadline !== undefined
            ? input.bidding_deadline
            : input.biddingDeadline;

    const rawDeliveryDeadline =
      d.delivery_deadline !== undefined
        ? d.delivery_deadline
        : d.deliveryDeadline !== undefined
          ? d.deliveryDeadline
          : input.delivery_deadline !== undefined
            ? input.delivery_deadline
            : input.deliveryDeadline;

    const biddingDeadline =
      rawBiddingDeadline !== undefined
        ? rawBiddingDeadline === null
          ? null
          : new Date(rawBiddingDeadline)
        : undefined;

    const deliveryDeadline =
      rawDeliveryDeadline !== undefined
        ? rawDeliveryDeadline === null
          ? null
          : new Date(rawDeliveryDeadline)
        : undefined;

    const domainDraft: DraftQuoteRequestInput = {
      ...(categoryId !== undefined && { category_id: categoryId }),
      ...(spec !== undefined && { spec }),
      ...(quantity !== undefined && { quantity }),
      ...(unit !== undefined && { unit }),
      ...(unitSetDescription !== undefined && {
        unit_set_description: unitSetDescription,
      }),
      ...(deliveryMode !== undefined && { delivery_mode: deliveryMode }),
      ...(deliveryRegion !== undefined && { delivery_region: deliveryRegion }),
      ...(deliveryAddress !== undefined && { delivery_address: deliveryAddress }),
      ...(recipientName !== undefined && { recipient_name: recipientName }),
      ...(recipientPhone !== undefined && { recipient_phone: recipientPhone }),
      ...(biddingDeadline !== undefined && { bidding_deadline: biddingDeadline }),
      ...(deliveryDeadline !== undefined && {
        delivery_deadline: deliveryDeadline,
      }),
    };

    return this.txRunner.run(async (tx) => {
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
      const updated = existing.updateDraft({
        buyerId: input.actor.accountId,
        expectedVersion,
        draft: domainDraft,
        now,
      });

      return this.quoteRequestRepo.update(
        {
          request: updated,
          expectedVersion,
        },
        tx,
      );
    });
  }
}
