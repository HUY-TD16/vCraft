import { assertTradingNormalSession } from '../../helpers/trading-actor.helper';
import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type { AuthenticatedActor } from '../../../../../common/application/types/contract-types';
import { HttpResult } from '../../../../../common/http/interceptors/response-envelope.interceptor';
import {
  EntityId,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../domain';
import type {
  IQuoteRequestRepository,
  IStatusLogRepository,
} from '../../ports/repositories/trading-repositories.port';
import type { RequestEventDto } from '../../dtos/trading-persistence.dtos';

export interface GetStatusHistoryQueryInput {
  readonly page?: number;
  readonly limit?: number;
}

export interface GetStatusHistoryCommand {
  readonly actor: AuthenticatedActor;
  readonly requestId: string;
  readonly query?: GetStatusHistoryQueryInput;
}

export class GetStatusHistoryUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly statusLogRepo: IStatusLogRepository,
  ) {}

  async execute(
    command: GetStatusHistoryCommand,
  ): Promise<HttpResult<readonly RequestEventDto[]>> {
    // 1. Kiểm tra cấp độ phiên bảo mật (SEC-05)
    assertTradingNormalSession(
      command.actor,
      'Temporary password session cannot access quote request status history.',
    );

    // 2. Kiểm tra tính hợp lệ của requestId (Positive 64-bit integer, ném InvalidTradingInputError nếu sai định dạng)
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

      // 4. Phân quyền truy cập & Chống IDOR (SEC-06, UC-18, BR-26, api-design §10.4)
      if (command.actor.role === 'admin') {
        // Admin được phép truy cập lịch sử của bất kỳ yêu cầu nào
      } else if (command.actor.role === 'buyer') {
        // SEC-06 IDOR protection: Non-owner Buyer nhận 404 RESOURCE_NOT_FOUND (không tiết lộ sự tồn tại của tài nguyên)
        if (request.buyer_id !== command.actor.accountId) {
          throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
        }
      } else {
        // Artisan hoặc vai trò khác không có quyền truy cập endpoint này
        throw new TradingPermissionDeniedError('Unauthorized trading role.');
      }

      // 5. Truy vấn lịch sử trạng thái có phân trang và sắp xếp created_at desc, id desc
      return this.statusLogRepo.findEventsWithPagination(
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
