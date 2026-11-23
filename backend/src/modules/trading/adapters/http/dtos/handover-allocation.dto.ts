import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';
import { MAX_DELIVERY_NOTE_LENGTH } from '../../../domain/entities/allocation.entity';

export const handoverAllocationSchema = z.strictObject({
  expected_allocation_version: z.int().min(1).max(2_147_483_647),
  delivery_note: z
    .string()
    .trim()
    .max(MAX_DELIVERY_NOTE_LENGTH)
    .nullable()
    .optional(),
});

export const recordArtisanHandoverSchema = handoverAllocationSchema;

export class HandoverAllocationDto extends createZodDto(
  handoverAllocationSchema,
) {}

export { HandoverAllocationDto as RecordArtisanHandoverDto };

import { allocationOperationResponseSchema } from './trading-openapi-response.schemas';
export const handoverAllocationOperationResponseSchema = allocationOperationResponseSchema;

export const recordArtisanHandoverOperationResponseSchema =
  handoverAllocationOperationResponseSchema;
