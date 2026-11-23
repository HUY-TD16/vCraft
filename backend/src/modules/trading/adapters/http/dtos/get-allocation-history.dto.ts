import { z } from 'zod';
import {
  createZodDto,
  paginationQuery,
} from '../../../../../common/http/pipes/global-validation.pipe';
import {
  ALLOCATION_LOG_EVENT_TYPES,
  ALLOCATION_STATUSES,
} from '../../../domain/value-objects/trading-enums';

export const getAllocationHistorySchema = paginationQuery;
export const getAllocationHistoryQuerySchema = getAllocationHistorySchema;

export class GetAllocationHistoryQueryDto extends createZodDto(
  getAllocationHistorySchema,
) {}

export const allocationEventDtoResponseSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]*$/),
  event_type: z.enum(ALLOCATION_LOG_EVENT_TYPES),
  prev_status: z.enum(ALLOCATION_STATUSES).nullable(),
  new_status: z.enum(ALLOCATION_STATUSES),
  performed_by: z
    .strictObject({
      id: z.string().regex(/^[1-9][0-9]*$/),
      display_name: z.string().nullable(),
    })
    .nullable(),
  created_at: z.string(),
  is_admin_action: z.boolean(),
  note: z.string().nullable(),
  evidence: z.string().nullable(),
});
