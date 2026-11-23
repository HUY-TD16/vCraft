import { z } from 'zod';
import {
  createZodDto,
  paginationQuery,
} from '../../../../../common/http/pipes/global-validation.pipe';

export const getAllocationBatchesSchema = paginationQuery;
export const getAllocationBatchesQuerySchema = getAllocationBatchesSchema;

export class GetAllocationBatchesQueryDto extends createZodDto(
  getAllocationBatchesSchema,
) {}

export const allocationBatchDtoResponseSchema = z.strictObject({
  batch_id: z.string().regex(/^[1-9][0-9]*$/),
  batch_name: z.string().min(1),
  linked_quantity: z.number().int().min(1).max(2147483647),
  is_trace_public: z.boolean(),
  trace_url: z.string().regex(/^\/api\/v1\/trace\/.+$/).nullable(),
  linked_at: z.string(),
});
