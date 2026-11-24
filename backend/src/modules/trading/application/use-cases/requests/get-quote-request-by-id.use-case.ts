import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
} from '../../../../../common/application/types/contract-types';
import { QuoteRequestMapper } from '../../mappers/quote-request.mapper';
import {
  EntityId,
  QuoteRequestNotFoundError,
  TradingPermissionDeniedError,
} from '../../../domain';
import {
  assertTradingArtisanWorkshop,
  assertTradingNormalSession,
} from '../../helpers/trading-actor.helper';
import type { IQuoteRequestRepository } from '../../ports/repositories/trading-repositories.port';
import type {
  AdminRequestDto,
  BuyerRequestDto,
  InvitedRequestDto,
  QuoteDto,
  RecipientDto,
} from '../../dtos/trading-persistence.dtos';

export interface GetQuoteRequestByIdCommand {
  readonly actor: AuthenticatedActor;
  readonly id: string;
  readonly tx?: TransactionContext;
  readonly draftOnly?: boolean;
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
    assertTradingNormalSession(
      command.actor,
      'Temporary password session cannot access quote requests.',
    );

    // 2. Kiểm tra tính hợp lệ của id (Positive 64-bit integer)
    const entityId = EntityId.of(command.id, 'id');

    // 3. Truy vấn nạp chi tiết thực thể và các quan hệ
    const loadDetail = (id: Id, tx?: TransactionContext) => {
      if (
        command.draftOnly &&
        typeof this.quoteRequestRepo.findDraftDetailById === 'function'
      ) {
        return this.quoteRequestRepo.findDraftDetailById(id, tx);
      }
      return this.quoteRequestRepo.findDetailById(id, tx);
    };

    const detail = command.tx
      ? await loadDetail(entityId.value, command.tx)
      : await this.txRunner.run(async (tx: TransactionContext) => {
          return loadDetail(entityId.value, tx);
        });

    if (!detail) {
      throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
    }

    const now = new Date();

    // 4. Phân quyền và khử dữ liệu theo vai trò (BR-04, SEC-04, SEC-06)
    if (command.actor.role === 'admin') {
      return QuoteRequestMapper.fromDetailOrEntityToBuyerOrAdminDto({
        detail,
        now,
      });
    }

    if (command.actor.role === 'buyer') {
      // SEC-06 IDOR protection: Non-owner Buyer receives 404 RESOURCE_NOT_FOUND
      if (detail.entity.buyer_id !== command.actor.accountId) {
        throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
      }

      return QuoteRequestMapper.fromDetailOrEntityToBuyerOrAdminDto({
        detail,
        now,
      });
    }

    if (command.actor.role === 'artisan') {
      const workshopId = assertTradingArtisanWorkshop(
        command.actor,
        'Artisan actor must belong to an active workshop.',
      );
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

      return QuoteRequestMapper.toInvitedRequestDto(detail.entity, {
        category: detail.category,
        now,
        ownRecipient,
        ownQuote,
        ownAllocationId,
      });
    }

    throw new TradingPermissionDeniedError('Unauthorized trading role.');
  }
}
