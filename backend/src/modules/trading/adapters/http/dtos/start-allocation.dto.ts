import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

export const startAllocationSchema = z.strictObject({
  expected_allocation_version: z.int().min(1).max(2_147_483_647),
});

export class StartAllocationDto extends createZodDto(startAllocationSchema) {}

import { allocationOperationResponseSchema } from './trading-openapi-response.schemas';
export const startAllocationOperationResponseSchema = allocationOperationResponseSchema;
