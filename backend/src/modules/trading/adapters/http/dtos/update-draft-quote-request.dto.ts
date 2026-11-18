import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

const MAX_BIGINT_ID = 9223372036854775807n;
const MAX_INT32 = 2_147_483_647;

const positiveBigIntIdSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((val) => BigInt(val) <= MAX_BIGINT_ID, {
    message: 'ID exceeds the 64-bit signed integer range.',
  });

export const updateDraftQuoteRequestSchema = z.strictObject({
  expected_request_version: z.int().positive().max(MAX_INT32),
  category_id: positiveBigIntIdSchema.nullable().optional(),
  spec: z.string().trim().max(10_000).nullable().optional(),
  quantity: z.int().positive().max(MAX_INT32).nullable().optional(),
  unit: z.enum(['piece', 'set']).nullable().optional(),
  unit_set_description: z.string().trim().max(10_000).nullable().optional(),
  delivery_mode: z.enum(['at_workshop', 'at_buyer_address']).nullable().optional(),
  delivery_region: z.string().trim().max(200).nullable().optional(),
  delivery_address: z.string().trim().max(10_000).nullable().optional(),
  recipient_name: z.string().trim().max(200).nullable().optional(),
  recipient_phone: z.string().trim().max(20).nullable().optional(),
  bidding_deadline: z.string().datetime({ offset: true }).nullable().optional(),
  delivery_deadline: z.string().datetime({ offset: true }).nullable().optional(),
});

export class UpdateDraftQuoteRequestDto extends createZodDto(
  updateDraftQuoteRequestSchema,
) {}
