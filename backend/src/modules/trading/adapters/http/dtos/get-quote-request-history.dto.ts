import { z } from 'zod';
import {
  createZodDto,
  paginationQuery,
} from '../../../../../common/http/pipes/global-validation.pipe';
import {
  REQUEST_STATUSES,
  STATUS_LOG_EVENT_TYPES,
} from '../../../domain/value-objects/trading-enums';

export const getQuoteRequestHistorySchema = paginationQuery;

export class GetQuoteRequestHistoryQueryDto extends createZodDto(
  getQuoteRequestHistorySchema,
) {}

export const requestEventDtoResponseSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]*$/),
  event_type: z.enum(STATUS_LOG_EVENT_TYPES),
  prev_status: z.enum(REQUEST_STATUSES).nullable(),
  new_status: z.enum(REQUEST_STATUSES),
  performed_by: z
    .strictObject({
      id: z.string().regex(/^[1-9][0-9]*$/),
      display_name: z.string().nullable(),
    })
    .nullable(),
  is_admin_action: z.boolean(),
  note: z.string().nullable(),
  evidence: z.string().nullable(),
  created_at: z.string(),
});
