import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
} from '../../../../../common/application/types/contract-types';
import {
  createPageResult,
  PAGINATION,
  type PageResult,
} from '../../../../../common/application/types/pagination';
import {
  TradingDomainError,
  TradingPermissionDeniedError,
  InvalidTradingInputError,
  type RequestStatus,
} from '../../../domain';
import type {
  FindBuyerQuoteRequestsInput,
  IQuoteRequestRepository,
} from '../../ports/repositories/trading-repositories.port';
import type { BuyerRequestSummaryDto } from '../../dtos/trading-persistence.dtos';

/**
 * Danh mục trạng thái cho phép lọc danh sách QuoteRequest của Buyer.
 * Bao gồm cả mã hiển thị nghiệp vụ (draft, bidding, accepted, in_production, delivered, cancelled)
 * và mã trạng thái trong CSDL domain (draft_request, sent_to_artisans, artisans_bidding, buyer_accepted).
 */
const ALLOWED_STATUS_FILTERS = new Set<string>([
  'draft',
  'bidding',
  'accepted',
  'in_production',
  'delivered',
  'cancelled',
  'draft_request',
  'sent_to_artisans',
  'artisans_bidding',
  'buyer_accepted',
]);

/**
 * Danh mục trường sắp xếp cho phép theo api-design.md §1.4.
 */
const ALLOWED_SORT_FIELDS = new Set<string>([
  'created_at',
  'updated_at',
  'bidding_deadline',
  'delivery_deadline',
  'quantity',
  'id',
]);

export interface ListBuyerQuoteRequestsQueryDto {
  readonly page?: number;
  readonly limit?: number;
  readonly status?: RequestStatus | string;
  readonly cancelled?: boolean;
  readonly sort_by?: string;
  readonly sortBy?: string;
  readonly order?: 'asc' | 'desc';
  readonly search?: string;
}

export interface ListBuyerQuoteRequestsCommand {
  readonly actor: AuthenticatedActor;
  readonly query: ListBuyerQuoteRequestsQueryDto;
}

export interface ListBuyerQuoteRequestsResult extends PageResult<BuyerRequestSummaryDto> {
  readonly items: readonly BuyerRequestSummaryDto[];
  readonly total: number;
}

export class ListBuyerQuoteRequestsUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
  ) {}

  async execute(
    command: ListBuyerQuoteRequestsCommand,
  ): Promise<ListBuyerQuoteRequestsResult> {
    // 1. Kiểm tra phân quyền vai trò (SEC-04, UC-14, UC-18)
    if (command.actor.role !== 'buyer') {
      throw new TradingPermissionDeniedError(
        'Only buyers can access their quote requests.',
      );
    }

    // 2. Kiểm tra cấp độ phiên bảo mật (SEC-05)
    if (command.actor.sessionLevel === 'temp_password') {
      throw new TradingDomainError(
        'TEMP_PASSWORD_RESTRICTED',
        'Temporary password session cannot access quote requests.',
      );
    }

    const { query } = command;

    // 3. Chuẩn hóa và xác thực phân trang (SEC-14, api-design §1.4)
    const page = query.page ?? PAGINATION.defaultPage;
    const limit = query.limit ?? PAGINATION.defaultLimit;

    if (!Number.isSafeInteger(page) || page < 1) {
      throw new InvalidTradingInputError('page must be an integer >= 1.', {
        field: 'page',
      });
    }

    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > PAGINATION.maxLimit
    ) {
      throw new InvalidTradingInputError(
        `limit must be an integer between 1 and ${PAGINATION.maxLimit}.`,
        { field: 'limit' },
      );
    }

    // 4. Chuẩn hóa tiêu chí sắp xếp
    const sortBy = query.sortBy ?? query.sort_by ?? 'created_at';
    if (!ALLOWED_SORT_FIELDS.has(sortBy)) {
      throw new InvalidTradingInputError(
        `Invalid sort field: ${sortBy}. Allowed fields: ${Array.from(ALLOWED_SORT_FIELDS).join(', ')}.`,
        { field: 'sort_by' },
      );
    }

    const order = query.order ?? 'desc';
    if (order !== 'asc' && order !== 'desc') {
      throw new InvalidTradingInputError(
        `Invalid sort order: ${order}. Must be 'asc' or 'desc'.`,
        { field: 'order' },
      );
    }

    // 5. Xác thực bộ lọc trạng thái (nếu có)
    if (query.status !== undefined && !ALLOWED_STATUS_FILTERS.has(query.status)) {
      throw new InvalidTradingInputError(
        `Invalid status filter: ${query.status}. Allowed values: ${Array.from(ALLOWED_STATUS_FILTERS).join(', ')}.`,
        { field: 'status' },
      );
    }

    // 6. Chuẩn hóa từ khóa tìm kiếm (tối đa 100 ký tự, tự động trim)
    let search: string | undefined = undefined;
    if (query.search !== undefined) {
      const trimmed = query.search.trim();
      if (trimmed.length > 100) {
        throw new InvalidTradingInputError(
          'Search keyword must not exceed 100 characters.',
          { field: 'search' },
        );
      }
      search = trimmed.length > 0 ? trimmed : undefined;
    }

    // Ánh xạ trạng thái thân thiện sang mã domain/CSDL
    let mappedStatus: string | readonly string[] | undefined = undefined;
    let mappedCancelled = query.cancelled;

    if (query.status !== undefined) {
      if (query.status === 'draft') {
        mappedStatus = 'draft_request';
      } else if (query.status === 'bidding') {
        mappedStatus = ['sent_to_artisans', 'artisans_bidding'];
      } else if (query.status === 'accepted') {
        mappedStatus = 'buyer_accepted';
      } else if (query.status === 'cancelled') {
        mappedCancelled = true;
        mappedStatus = undefined;
      } else {
        mappedStatus = query.status;
      }
    }

    const now = new Date();

    // 7. Tạo payload gửi xuống Repository Port
    const repoInput: FindBuyerQuoteRequestsInput = {
      buyerId: command.actor.accountId,
      page,
      limit,
      ...(mappedStatus !== undefined ? { status: mappedStatus } : {}),
      ...(mappedCancelled !== undefined ? { cancelled: mappedCancelled } : {}),
      sortBy,
      order,
      search,
      now,
    };

    // 8. Chạy trong transaction runner để đảm bảo tính nhất quán đọc
    const result = await this.txRunner.run(async (tx: TransactionContext) => {
      return this.quoteRequestRepo.findBuyerQuoteRequests(repoInput, tx);
    });

    // 9. Bọc kết quả thành PageResult chuẩn kèm items/total tương thích
    const pageResult = createPageResult(result.items, result.total, { page, limit });
    return {
      ...pageResult,
      items: pageResult.data,
      total: pageResult.pagination.total_records,
    };
  }
}
