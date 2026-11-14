import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
} from '../../../../../common/application/types/contract-types';
import {
  createPageResult,
  PAGINATION,
  type PageResult,
} from '../../../../../common/application/types/pagination';
import {
  InvalidTradingInputError,
  TradingDomainError,
  TradingPermissionDeniedError,
  type RequestStatus,
} from '../../../domain';
import type {
  FindArtisanQuoteRequestsInput,
  IQuoteRequestRepository,
} from '../../ports/repositories/trading-repositories.port';
import type { InvitedRequestDto } from '../../dtos/trading-persistence.dtos';

const ALLOWED_STATUS_FILTERS = new Set<string>([
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

const ALLOWED_RESPONSE_STATUS_FILTERS = new Set<string>([
  'pending',
  'quoted',
  'declined',
  'withdrawn',
]);

const ALLOWED_SORT_FIELDS = new Set<string>([
  'created_at',
  'bidding_deadline',
  'delivery_deadline',
  'quantity',
  'id',
]);

export interface ListArtisanQuoteRequestsQueryDto {
  readonly page?: number;
  readonly limit?: number;
  readonly status?: RequestStatus | string;
  readonly response_status?: string;
  readonly sort_by?: string;
  readonly sortBy?: string;
  readonly order?: 'asc' | 'desc';
  readonly search?: string;
}

export interface ListArtisanQuoteRequestsCommand {
  readonly actor: AuthenticatedActor;
  readonly query: ListArtisanQuoteRequestsQueryDto;
}

export interface ListArtisanQuoteRequestsResult
  extends PageResult<InvitedRequestDto> {
  readonly items: readonly InvitedRequestDto[];
  readonly total: number;
}

export class ListArtisanQuoteRequestsUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
  ) {}

  async execute(
    command: ListArtisanQuoteRequestsCommand,
  ): Promise<ListArtisanQuoteRequestsResult> {
    // 1. Phân quyền vai trò (SEC-04, UC-18)
    if (command.actor.role !== 'artisan') {
      throw new TradingPermissionDeniedError(
        'Only artisans can access their invited quote requests.',
      );
    }

    // 2. Cô lập xưởng (SEC-06 IDOR: Nghệ nhân phải gắn liền với workshopId hợp lệ)
    if (!command.actor.workshopId) {
      throw new TradingPermissionDeniedError(
        'Artisan actor is not associated with any workshop.',
      );
    }

    // 3. Giới hạn phiên mật khẩu tạm (SEC-05)
    if (command.actor.sessionLevel === 'temp_password') {
      throw new TradingDomainError(
        'TEMP_PASSWORD_RESTRICTED',
        'Temporary password session cannot access quote requests.',
      );
    }

    const { query } = command;

    // 4. Chuẩn hóa và xác thực phân trang (SEC-14, api-design §1.4)
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

    // 5. Chuẩn hóa tiêu chí sắp xếp
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

    // 6. Xác thực bộ lọc trạng thái QuoteRequest (nếu có)
    if (query.status !== undefined && !ALLOWED_STATUS_FILTERS.has(query.status)) {
      throw new InvalidTradingInputError(
        `Invalid status filter: ${query.status}. Allowed values: ${Array.from(ALLOWED_STATUS_FILTERS).join(', ')}.`,
        { field: 'status' },
      );
    }

    // 7. Xác thực bộ lọc response_status (nếu có)
    if (
      query.response_status !== undefined &&
      !ALLOWED_RESPONSE_STATUS_FILTERS.has(query.response_status)
    ) {
      throw new InvalidTradingInputError(
        `Invalid response_status filter: ${query.response_status}. Allowed values: ${Array.from(ALLOWED_RESPONSE_STATUS_FILTERS).join(', ')}.`,
        { field: 'response_status' },
      );
    }

    // 8. Chuẩn hóa từ khóa tìm kiếm (tối đa 100 ký tự, tự động trim)
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
    if (query.status !== undefined) {
      if (query.status === 'bidding') {
        mappedStatus = ['sent_to_artisans', 'artisans_bidding'];
      } else if (query.status === 'accepted') {
        mappedStatus = 'buyer_accepted';
      } else {
        mappedStatus = query.status;
      }
    }

    const now = new Date();

    // 9. Tạo payload gửi xuống Repository Port
    const repoInput: FindArtisanQuoteRequestsInput = {
      workshopId: command.actor.workshopId,
      page,
      limit,
      ...(mappedStatus !== undefined ? { status: mappedStatus } : {}),
      ...(query.response_status !== undefined
        ? { responseStatus: query.response_status }
        : {}),
      sortBy,
      order,
      search,
      now,
    };

    // 10. Chạy trong transaction runner để đảm bảo tính nhất quán đọc
    const result = await this.txRunner.run(async (tx: TransactionContext) => {
      return this.quoteRequestRepo.findArtisanQuoteRequests(repoInput, tx);
    });

    // 11. Bọc kết quả thành PageResult chuẩn kèm items/total tương thích
    const pageResult = createPageResult(result.items, result.total, {
      page,
      limit,
    });
    return {
      ...pageResult,
      items: pageResult.data,
      total: pageResult.pagination.total_records,
    };
  }
}
