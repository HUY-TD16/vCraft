import { z } from 'zod';
import {
  createZodDto,
  paginationQuery,
} from '../../../../../common/http/pipes/global-validation.pipe';
import { ALLOCATION_STATUSES } from '../../../domain';

export const listArtisanAllocationsSchema = paginationQuery.extend({
  status: z.enum(ALLOCATION_STATUSES).optional(),
  delivery_deadline: z
    .string()
    .trim()
    .refine((val) => !Number.isNaN(Date.parse(val)), {
      message: 'delivery_deadline must be a valid date or date-time string.',
    })
    .optional(),
  committed_delivery_at: z
    .string()
    .trim()
    .refine((val) => !Number.isNaN(Date.parse(val)), {
      message: 'committed_delivery_at must be a valid date or date-time string.',
    })
    .optional(),
  request_id: z.string().regex(/^[1-9][0-9]*$/).optional(),
});

export class ListArtisanAllocationsQueryDto extends createZodDto(
  listArtisanAllocationsSchema,
) {}
