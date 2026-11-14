import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type { AuthenticatedActor } from '../../../../../common/security/guards/authenticated-request';
import { HttpResult } from '../../../../../common/http/interceptors/response-envelope.interceptor';
import {
  EntityId,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../domain';
import type {
  IQuoteRequestRepository,
  IContactEditHistoryRepository,
  IAllocationRepository,
} from '../../ports/repositories/trading-repositories.port';
import type { ContactEventDto } from '../../dtos/trading-persistence.dtos';

export interface GetContactHistoryQueryInput {
  readonly page?: number;
  readonly limit?: number;
}

export interface GetContactHistoryCommand {
  readonly actor: AuthenticatedActor;
  readonly requestId: string;
  readonly query?: GetContactHistoryQueryInput;
}

export class GetContactHistoryUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly contactEditHistoryRepo: IContactEditHistoryRepository,
    private readonly allocationRepo: IAllocationRepository,
  ) {}

  async execute(
    command: GetContactHistoryCommand,
  ): Promise<HttpResult<readonly ContactEventDto[]>> {
    // 1. Kiểm tra cấp độ phiên bảo mật (SEC-05)
    if (command.actor.sessionLevel === 'temp_password') {
      throw new TradingDomainError(
        'TEMP_PASSWORD_RESTRICTED',
        'Temporary password session cannot access contact history.',
      );
    }

    // 2. Kiểm tra tính hợp lệ của requestId (Positive 64-bit integer)
    const entityId = EntityId.of(command.requestId, 'id');

    const page = command.query?.page ?? 1;
    const limit = command.query?.limit ?? 20;

    // 3. Thực thi truy vấn trong transaction runner
    const result = await this.txRunner.run(async (tx: TransactionContext) => {
      // Nạp QuoteRequest để kiểm tra quyền truy cập & chống IDOR
      const request = await this.quoteRequestRepo.findById(
        entityId.value,
        tx,
      );

      if (!request) {
        throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
      }

      // 4. Phân quyền truy cập (BR-04, BR-11, UC-14, SEC-06, api-design §10.4)
      // Quyền đọc: Buyer sở hữu yêu cầu, Admin, và Artisan có Allocation
      // Giữ quyền đọc sau hủy / hoàn tất (cancelled_at !== null hoặc status === 'delivered')
      if (command.actor.role === 'admin') {
        // Admin được phép truy cập tất cả yêu cầu
      } else if (command.actor.role === 'buyer') {
        // SEC-06 IDOR protection: Non-owner Buyer nhận 404 RESOURCE_NOT_FOUND
        if (request.buyer_id !== command.actor.accountId) {
          throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
        }
      } else if (command.actor.role === 'artisan') {
        // Artisan chỉ được truy cập khi có Allocation (BR-04, SEC-04)
        if (!command.actor.workshopId) {
          throw new TradingPermissionDeniedError(
            'Artisan actor must belong to an active workshop.',
          );
        }

        const allocation = await this.allocationRepo.findByRequestAndWorkshop(
          entityId.value,
          command.actor.workshopId,
          tx,
        );

        // Artisan không có Allocation → 404 RESOURCE_NOT_FOUND (chống IDOR)
        if (!allocation) {
          throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
        }
      } else {
        throw new TradingPermissionDeniedError('Unauthorized trading role.');
      }

      // 5. Truy vấn lịch sử sửa thông tin liên hệ có phân trang
      return this.contactEditHistoryRepo.findEventsWithPagination(
        {
          requestId: entityId.value,
          page,
          limit,
        },
        tx,
      );
    });

    return HttpResult.paginated(result.rows, result.totalRecords, {
      page,
      limit,
    });
  }
}
