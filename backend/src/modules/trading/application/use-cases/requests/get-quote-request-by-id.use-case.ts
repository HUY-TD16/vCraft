import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
  Instant,
} from '../../../../../common/application/types/contract-types';
import {
  EntityId,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../domain';
import type {
  IQuoteRequestRepository,
  QuoteRequestDetailRecord,
} from '../../ports/repositories/trading-repositories.port';
import type {
  AdminRequestDto,
  BuyerRequestDto,
  DeliveryConfirmationDto,
  InvitedRequestBaseDto,
  InvitedRequestDto,
  InvitedRequestWithAllocationDto,
  QuoteDto,
  RecipientDto,
  RequestBaseDto,
} from '../../dtos/trading-persistence.dtos';

export interface GetQuoteRequestByIdCommand {
  readonly actor: AuthenticatedActor;
  readonly id: string;
}

export type GetQuoteRequestByIdResult =
  | BuyerRequestDto
  | AdminRequestDto
  | InvitedRequestDto;

export class GetQuoteRequestByIdUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
  ) {}

  async execute(
    command: GetQuoteRequestByIdCommand,
  ): Promise<GetQuoteRequestByIdResult> {
    // 1. Kiểm tra cấp độ phiên bảo mật (SEC-05)
    if (command.actor.sessionLevel === 'temp_password') {
      throw new TradingDomainError(
        'TEMP_PASSWORD_RESTRICTED',
        'Temporary password session cannot access quote requests.',
      );
    }

    // 2. Kiểm tra tính hợp lệ của id (Positive 64-bit integer)
    const entityId = EntityId.of(command.id, 'id');

    // 3. Truy vấn nạp chi tiết thực thể và các quan hệ
    const detail = await this.txRunner.run(async (tx: TransactionContext) => {
      return this.quoteRequestRepo.findDetailById(entityId.value, tx);
    });

    if (!detail) {
      throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
    }

    const now = new Date();

    // 4. Phân quyền và khử dữ liệu theo vai trò (BR-04, SEC-04, SEC-06)
    if (command.actor.role === 'admin') {
      return this.mapToBuyerOrAdminDto(detail, now);
    }

    if (command.actor.role === 'buyer') {
      // SEC-06 IDOR protection: Non-owner Buyer receives 404 RESOURCE_NOT_FOUND
      if (detail.entity.buyer_id !== command.actor.accountId) {
        throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
      }

      return this.mapToBuyerOrAdminDto(detail, now);
    }

    if (command.actor.role === 'artisan') {
      if (!command.actor.workshopId) {
        throw new TradingPermissionDeniedError(
          'Artisan actor must belong to an active workshop.',
        );
      }

      const workshopId = command.actor.workshopId;
      const recipientItem = detail.recipients.find(
        (r) => r.entity.workshop_id === workshopId,
      );

      // SEC-06 IDOR protection: Uninvited Artisan receives 404 RESOURCE_NOT_FOUND
      if (!recipientItem) {
        throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
      }

      // Kiểm tra xem hộ này đã có Allocation trúng thầu chưa (BR-04, SEC-04)
      const allocationItem = detail.allocations.find(
        (a) => a.entity.workshop_id === workshopId,
      );
      const ownAllocationId = allocationItem ? allocationItem.entity.id : null;

      const ownRecipient: RecipientDto = Object.freeze({
        id: recipientItem.entity.id,
        request_id: recipientItem.entity.request_id,
        workshop: recipientItem.workshop,
        response_status: recipientItem.entity.response_status,
        version: recipientItem.entity.version,
        sent_at: recipientItem.entity.sent_at.toISOString(),
        responded_at: recipientItem.entity.responded_at
          ? recipientItem.entity.responded_at.toISOString()
          : null,
        decline_reason: recipientItem.entity.decline_reason,
        eligibility_labels: Object.freeze([]),
      });

      const quoteItem = detail.quotes.find(
        (q) => q.entity.workshop_id === workshopId,
      );

      let ownQuote: QuoteDto | null = null;
      if (quoteItem) {
        const evaluation = quoteItem.entity.evaluateEligibility({
          request: detail.entity,
          workshopIsActive: quoteItem.workshop.status === 'active',
          now,
        });

        ownQuote = Object.freeze({
          id: quoteItem.entity.id,
          request_id: quoteItem.entity.request_id,
          workshop: quoteItem.workshop,
          unit_price: quoteItem.entity.unit_price,
          max_quantity: quoteItem.entity.max_quantity,
          bid_accept_deadline:
            quoteItem.entity.bid_accept_deadline.toISOString(),
          committed_delivery_at:
            quoteItem.entity.committed_delivery_at.toISOString(),
          status: quoteItem.entity.status,
          version: quoteItem.entity.version,
          withdraw_reason: quoteItem.entity.withdraw_reason,
          withdrawn_at: quoteItem.entity.withdrawn_at
            ? quoteItem.entity.withdrawn_at.toISOString()
            : null,
          is_eligible: evaluation.is_eligible,
          ineligible_reasons: Object.freeze([...evaluation.ineligible_reasons]),
          created_at: quoteItem.entity.created_at.toISOString(),
          updated_at: quoteItem.entity.updated_at.toISOString(),
        });
      }

      const baseDto = this.buildBaseDto(detail, now);

      if (ownAllocationId === null) {
        const unallocated: InvitedRequestBaseDto = Object.freeze({
          ...baseDto,
          own_recipient: ownRecipient,
          own_quote: ownQuote,
        });
        return unallocated;
      }

      const allocated: InvitedRequestWithAllocationDto = Object.freeze({
        ...baseDto,
        own_recipient: ownRecipient,
        own_quote: ownQuote,
        own_allocation_id: EntityId.of(ownAllocationId, 'own_allocation_id')
          .value,
        recipient_name: detail.entity.recipient_name,
        recipient_phone: detail.entity.recipient_phone,
        delivery_address: detail.entity.delivery_address,
      });
      return allocated;
    }

    throw new TradingPermissionDeniedError('Unauthorized trading role.');
  }

  private buildBaseDto(
    detail: QuoteRequestDetailRecord,
    now: Date,
  ): RequestBaseDto {
    return {
      id: detail.entity.id,
      status: detail.entity.status,
      version: detail.entity.version,
      category: detail.category,
      spec: detail.entity.spec,
      quantity: detail.entity.quantity,
      unit: detail.entity.unit,
      unit_set_description: detail.entity.unit_set_description,
      delivery_mode: detail.entity.delivery_mode,
      delivery_region: detail.entity.delivery_region,
      bidding_deadline: detail.entity.bidding_deadline
        ? detail.entity.bidding_deadline.toISOString()
        : null,
      delivery_deadline: detail.entity.delivery_deadline
        ? detail.entity.delivery_deadline.toISOString()
        : null,
      bidding_closed_at: detail.entity.bidding_closed_at
        ? detail.entity.bidding_closed_at.toISOString()
        : null,
      is_bidding_open: detail.entity.isBiddingOpenAt(now),
      cancelled_at: detail.entity.cancelled_at
        ? detail.entity.cancelled_at.toISOString()
        : null,
      created_at: detail.entity.created_at.toISOString(),
      updated_at: detail.entity.updated_at.toISOString(),
    };
  }

  private mapToBuyerOrAdminDto(
    detail: QuoteRequestDetailRecord,
    now: Date,
  ): BuyerRequestDto {
    const isClosedOrCancelled =
      detail.entity.isCancelled() || detail.entity.isAcceptedOrBeyond();

    const eligibleQuotes = detail.quotes.filter((q) => {
      if (isClosedOrCancelled) {
        return false;
      }
      if (q.entity.status !== 'active') {
        return false;
      }
      const isWorkshopActive = q.workshop.status === 'active';
      if (!isWorkshopActive) {
        return false;
      }
      if (now.getTime() >= q.entity.bid_accept_deadline.getTime()) {
        return false;
      }
      if (
        detail.entity.delivery_deadline !== null &&
        q.entity.committed_delivery_at.getTime() >
          detail.entity.delivery_deadline.getTime()
      ) {
        return false;
      }
      return true;
    });

    const validQuoteCount = eligibleQuotes.length;
    const noValidQuotes = detail.entity.deriveNoValidQuotes(validQuoteCount);

    let nearestAcceptDeadline: Instant | null = null;
    if (eligibleQuotes.length > 0 && !isClosedOrCancelled) {
      const minTime = Math.min(
        ...eligibleQuotes.map((q) => q.entity.bid_accept_deadline.getTime()),
      );
      nearestAcceptDeadline = new Date(minTime).toISOString();
    }

    let deliveryConfirmation: DeliveryConfirmationDto | null = null;
    if (detail.entity.status === 'delivered') {
      const deliveryLog = detail.statusLogs.find(
        (log) =>
          log.entity.event_type === 'received_by_buyer' ||
          log.entity.event_type === 'received_by_admin',
      );
      if (deliveryLog) {
        const performedByActor = deliveryLog.performedBy ?? {
          id: deliveryLog.entity.performed_by ?? '0',
          display_name: null,
        };
        const performedAtDate =
          deliveryLog.entity.created_at instanceof Date
            ? deliveryLog.entity.created_at
            : new Date(deliveryLog.entity.created_at);

        deliveryConfirmation = Object.freeze({
          performed_by: performedByActor,
          performed_at: performedAtDate.toISOString(),
          is_admin_action: deliveryLog.entity.is_admin_action,
          reason: deliveryLog.entity.note,
          evidence: deliveryLog.entity.evidence,
        });
      }
    }

    const baseDto = this.buildBaseDto(detail, now);

    return Object.freeze({
      ...baseDto,
      buyer_id: detail.entity.buyer_id,
      recipient_name: detail.entity.recipient_name,
      recipient_phone: detail.entity.recipient_phone,
      delivery_address: detail.entity.delivery_address,
      cancel_reason: detail.entity.cancel_reason,
      split_requested_at: null,
      coordination_state: null,
      no_valid_quotes: noValidQuotes,
      nearest_accept_deadline: nearestAcceptDeadline,
      delivery_confirmation: deliveryConfirmation,
    });
  }
}
