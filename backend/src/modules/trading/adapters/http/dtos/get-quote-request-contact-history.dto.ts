import { z } from 'zod';
import {
  createZodDto,
  paginationQuery,
} from '../../../../../common/http/pipes/global-validation.pipe';

export const getQuoteRequestContactHistorySchema = paginationQuery;

export class GetQuoteRequestContactHistoryQueryDto extends createZodDto(
  getQuoteRequestContactHistorySchema,
) {}

export const contactEventDtoResponseSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]*$/),
  prev_recipient_name: z.string().nullable(),
  prev_recipient_phone: z.string().nullable(),
  new_recipient_name: z.string().nullable(),
  new_recipient_phone: z.string().nullable(),
  edited_by: z.strictObject({
    id: z.string().regex(/^[1-9][0-9]*$/),
    display_name: z.string().nullable(),
  }),
  edited_at: z.string(),
  version: z.int().min(1).max(2_147_483_647),
});
