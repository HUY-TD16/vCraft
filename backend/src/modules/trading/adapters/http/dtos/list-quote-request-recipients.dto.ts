import { z } from 'zod';
import {
  createZodDto,
  paginationQuery,
} from '../../../../../common/http/pipes/global-validation.pipe';
import {
  RECIPIENT_RESPONSE_STATUSES,
  type RecipientResponseStatus,
} from '../../../domain/value-objects/trading-enums';

export const listQuoteRequestRecipientsSchema = paginationQuery.extend({
  response_status: z.enum(RECIPIENT_RESPONSE_STATUSES).optional(),
});

export class ListQuoteRequestRecipientsQueryDto extends createZodDto(
  listQuoteRequestRecipientsSchema,
) {}
