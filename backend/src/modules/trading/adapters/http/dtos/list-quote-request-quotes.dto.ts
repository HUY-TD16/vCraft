import {
  createZodDto,
  paginationQuery,
} from '../../../../../common/http/pipes/global-validation.pipe';

export const listQuoteRequestQuotesSchema = paginationQuery;

export class ListQuoteRequestQuotesQueryDto extends createZodDto(
  listQuoteRequestQuotesSchema,
) {}
