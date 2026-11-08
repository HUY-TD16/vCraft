export const PAGINATION = Object.freeze({ defaultPage: 1, defaultLimit: 20, maxLimit: 100 });

export interface PaginationParams {
  readonly page: number;
  readonly limit: number;
}

export interface Pagination extends PaginationParams {
  readonly total_records: number;
  readonly total_pages: number;
}

export interface PageResult<T> {
  readonly data: readonly T[];
  readonly pagination: Pagination;
}

export function createPageResult<T>(data: readonly T[], totalRecords: number, params: PaginationParams): PageResult<T> {
  if (!Number.isSafeInteger(params.page) || params.page < 1
    || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > PAGINATION.maxLimit
    || !Number.isSafeInteger(totalRecords) || totalRecords < 0
    || data.length > params.limit || data.length > totalRecords) {
    throw new RangeError('Invalid pagination result');
  }
  return {
    data,
    pagination: {
      page: params.page, limit: params.limit,
      total_records: totalRecords, total_pages: Math.ceil(totalRecords / params.limit),
    },
  };
}
