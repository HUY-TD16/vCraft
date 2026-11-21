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
  FindAdminQuoteRequestsInput,
  IQuoteRequestRepository,
} from '../../ports/repositories/trading-repositories.port';
import type { BuyerRequestSummaryDto } from '../../dtos/trading-persistence.dtos';

/**
 * Danh mục trạng thái cho phép lọc danh sách QuoteRequest của Admin.
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

export interface ListAdminQuoteRequestsQueryDto {
  readonly page?: number;
  readonly limit?: number;
  readonly status?: RequestStatus | string;
  readonly cancelled?: boolean;
  readonly buyer_id?: string;
  readonly buyerId?: string;
  readonly category_id?: string;
  readonly categoryId?: string;
  readonly sort_by?: string;
  readonly sortBy?: string;
  readonly order?: 'asc' | 'desc';
  readonly search?: string;
}

export interface ListAdminQuoteRequestsCommand {
  readonly actor: AuthenticatedActor;
  readonly query: ListAdminQuoteRequestsQueryDto;
}

export interface ListAdminQuoteRequestsResult
  extends PageResult<BuyerRequestSummaryDto> {
  readonly items: readonly BuyerRequestSummaryDto[];
  readonly total: number;
}

export class ListAdminQuoteRequestsUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
  ) {}

  async execute(
    command: ListAdminQuoteRequestsCommand,
  ): Promise<ListAdminQuoteRequestsResult> {
    // 1. Kiểm tra phân quyền vai trò (Admin only) (SEC-04, UC-18, BR-02)
    if (command.actor.role !== 'admin') {
      throw new TradingPermissionDeniedError(
        'Only administrators can access all quote requests.',
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

    // 7. Xác thực buyer_id (nếu có)
    const rawBuyerId = query.buyerId ?? query.buyer_id;
    let buyerId: Id | undefined = undefined;
    if (rawBuyerId !== undefined) {
      if (!/^[1-9]\d*$/.test(rawBuyerId)) {
        throw new InvalidTradingInputError(
          'buyer_id must be a positive integer ID.',
          { field: 'buyer_id' },
        );
      }
      buyerId = rawBuyerId as Id;
    }

    // 8. Xác thực category_id (nếu có)
    const rawCategoryId = query.categoryId ?? query.category_id;
    let categoryId: Id | undefined = undefined;
    if (rawCategoryId !== undefined) {
      if (!/^[1-9]\d*$/.test(rawCategoryId)) {
        throw new InvalidTradingInputError(
          'category_id must be a positive integer ID.',
          { field: 'category_id' },
        );
      }
      categoryId = rawCategoryId as Id;
    }

    // 9. Ánh xạ trạng thái thân thiện sang mã domain/CSDL
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

    // 10. Tạo payload gửi xuống Repository Port
    const repoInput: FindAdminQuoteRequestsInput = {
      ...(buyerId !== undefined ? { buyerId } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
      page,
      limit,
      ...(mappedStatus !== undefined ? { status: mappedStatus } : {}),
      ...(mappedCancelled !== undefined ? { cancelled: mappedCancelled } : {}),
      sortBy,
      order,
      search,
      now,
    };

    // 11. Chạy trong transaction runner để đảm bảo tính nhất quán đọc
    const result = await this.txRunner.run(async (tx: TransactionContext) => {
      return this.quoteRequestRepo.findAdminQuoteRequests(repoInput, tx);
    });

    // 12. Bọc kết quả thành PageResult chuẩn kèm items/total tương thích
    const pageResult = createPageResult(result.items, result.total, { page, limit });
    return {
      ...pageResult,
      items: pageResult.data,
      total: pageResult.pagination.total_records,
    };
  }
}
