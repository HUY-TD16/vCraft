import { z } from 'zod';
import {
  createZodDto,
  paginationQuery,
} from '../../../../../common/http/pipes/global-validation.pipe';
import { ALLOCATION_STATUSES } from '../../../domain';

export const listQuoteRequestAllocationsSchema = paginationQuery.extend({
  status: z.enum(ALLOCATION_STATUSES).optional(),
});

export class ListQuoteRequestAllocationsQueryDto extends createZodDto(
  listQuoteRequestAllocationsSchema,
) {}
