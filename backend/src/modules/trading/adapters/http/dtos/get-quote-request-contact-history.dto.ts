import {
  createZodDto,
  paginationQuery,
} from '../../../../../common/http/pipes/global-validation.pipe';

export const getQuoteRequestContactHistorySchema = paginationQuery;

export class GetQuoteRequestContactHistoryQueryDto extends createZodDto(
  getQuoteRequestContactHistorySchema,
) {}
