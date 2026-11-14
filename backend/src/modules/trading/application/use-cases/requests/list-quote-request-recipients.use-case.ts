import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type { AuthenticatedActor } from '../../../../../common/security/guards/authenticated-request';
import { HttpResult } from '../../../../../common/http/interceptors/response-envelope.interceptor';
import {
  EntityId,
  type IneligibleQuoteReason,
  type RecipientResponseStatus,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../domain';
import type {
  IQuoteRequestRepository,
  IRequestRecipientRepository,
} from '../../ports/repositories/trading-repositories.port';
import type { RecipientDto } from '../../dtos/trading-persistence.dtos';

export interface ListQuoteRequestRecipientsQueryInput {
  readonly page?: number;
  readonly limit?: number;
  readonly response_status?: RecipientResponseStatus;
}

export interface ListQuoteRequestRecipientsCommand {
  readonly actor: AuthenticatedActor;
  readonly requestId: string;
  readonly query?: ListQuoteRequestRecipientsQueryInput;
}

export class ListQuoteRequestRecipientsUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly recipientRepo: IRequestRecipientRepository,
  ) {}

  async execute(
    command: ListQuoteRequestRecipientsCommand,
  ): Promise<HttpResult<readonly RecipientDto[]>> {
    // 1. Kiểm tra cấp độ phiên bảo mật (SEC-05)
    if (command.actor.sessionLevel === 'temp_password') {
      throw new TradingDomainError(
        'TEMP_PASSWORD_RESTRICTED',
        'Temporary password session cannot access quote request recipients.',
      );
    }

    // 2. Kiểm tra tính hợp lệ của requestId (Positive 64-bit integer)
    const entityId = EntityId.of(command.requestId, 'id');

    const page = command.query?.page ?? 1;
    const limit = command.query?.limit ?? 20;

    // 3. Thực thi truy vấn trong transaction runner
    const { quoteRequest, recipientsResult } = await this.txRunner.run(
      async (tx: TransactionContext) => {
        // Nạp QuoteRequest để kiểm tra quyền truy cập & chống IDOR
        const request = await this.quoteRequestRepo.findById(
          entityId.value,
          tx,
        );

        if (!request) {
          throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
        }

        // Kiểm tra phân quyền truy cập (BR-04, UC-18, SEC-06)
        if (command.actor.role === 'buyer') {
          // SEC-06 IDOR protection: Non-owner Buyer nhận 404 RESOURCE_NOT_FOUND
          if (request.buyer_id !== command.actor.accountId) {
            throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
          }
        } else if (command.actor.role === 'admin') {
          // Admin được phép truy cập tất cả yêu cầu
        } else {
          // Artisan hoặc các vai trò khác bị cấm truy cập danh sách hộ nhận đối thủ
          throw new TradingPermissionDeniedError(
            'Actor does not have permission to view quote request recipients.',
          );
        }

        const queryResult = await this.recipientRepo.findRecipientsWithDetails(
          {
            requestId: entityId.value,
            responseStatus: command.query?.response_status,
            page,
            limit,
          },
          tx,
        );

        return {
          quoteRequest: request,
          recipientsResult: queryResult,
        };
      },
    );

    const now = new Date();

    // 4. Ánh xạ các bản ghi sang RecipientDto kèm nhãn điều kiện hiệu lực và data masking
    const dtos: RecipientDto[] = recipientsResult.rows.map((row) => {
      const labels: IneligibleQuoteReason[] = [];

      // Nhãn hủy yêu cầu (INV-01)
      if (quoteRequest.isCancelled()) {
        labels.push('REQUEST_CANCELLED');
      }

      // Nhãn yêu cầu đã được chấp nhận (chốt cho hộ khác hoặc đang sản xuất)
      if (quoteRequest.isAcceptedOrBeyond()) {
        labels.push('REQUEST_ACCEPTED');
      }

      // Nhãn xưởng bị tạm ngừng hoạt động (BR-13)
      if (row.workshop.status === 'suspended') {
        labels.push('WORKSHOP_SUSPENDED');
      }

      // Nhãn báo giá đã bị rút (BR-15)
      if (
        row.entity.response_status === 'withdrawn' ||
        row.quote?.status === 'withdrawn'
      ) {
        labels.push('QUOTE_WITHDRAWN');
      }

      // Nhãn báo giá đã quá hạn chấp nhận (BR-13, UC-18)
      if (
        row.quote &&
        row.quote.status !== 'accepted' &&
        now.getTime() >= row.quote.bid_accept_deadline.getTime()
      ) {
        labels.push('QUOTE_EXPIRED');
      }

      const uniqueLabels = Object.freeze(Array.from(new Set(labels)));

      const dto: RecipientDto = Object.freeze({
        id: row.entity.id,
        request_id: row.entity.request_id,
        workshop: Object.freeze({
          id: row.workshop.id,
          name: row.workshop.name,
        }),
        response_status: row.entity.response_status,
        version: row.entity.version,
        sent_at: row.entity.sent_at.toISOString(),
        responded_at: row.entity.responded_at
          ? row.entity.responded_at.toISOString()
          : null,
        decline_reason: row.entity.decline_reason,
        eligibility_labels: uniqueLabels,
      });

      return dto;
    });

    // 5. Đóng gói kết quả phân trang theo chuẩn HttpResult
    return HttpResult.paginated(dtos, recipientsResult.totalRecords, {
      page,
      limit,
    });
  }
}
