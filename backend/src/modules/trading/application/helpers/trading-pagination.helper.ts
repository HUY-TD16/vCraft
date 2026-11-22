import { PAGINATION } from '../../../../common/application/types/pagination';
import { InvalidTradingInputError } from '../../domain';

export interface TradingPaginationSource {
  readonly query?: {
    readonly page?: number;
    readonly limit?: number;
  };
  readonly page?: number;
  readonly limit?: number;
}

export interface ResolvedTradingPagination {
  readonly page: number;
  readonly limit: number;
}

export function resolveTradingPagination(
  source: TradingPaginationSource,
): ResolvedTradingPagination {
  const page = source.query?.page ?? source.page ?? PAGINATION.defaultPage;
  const limit = source.query?.limit ?? source.limit ?? PAGINATION.defaultLimit;

  if (!Number.isSafeInteger(page) || page < 1) {
    throw new InvalidTradingInputError(
      'page must be a positive integer greater than or equal to 1.',
      { field: 'page' },
    );
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

  return { page, limit };
}
