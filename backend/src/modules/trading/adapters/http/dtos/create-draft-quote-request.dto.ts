import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';
import {
  COORDINATION_STATES,
  DELIVERY_MODES,
  REQUEST_STATUSES,
  REQUEST_UNITS,
} from '../../../domain/value-objects/trading-enums';

const MAX_BIGINT_ID = 9223372036854775807n;
const MAX_INT32 = 2_147_483_647;

const positiveBigIntIdSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((val) => BigInt(val) <= MAX_BIGINT_ID, {
    message: 'ID exceeds the 64-bit signed integer range.',
  });

export const createDraftQuoteRequestSchema = z.strictObject({
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

export class CreateDraftQuoteRequestDto extends createZodDto(createDraftQuoteRequestSchema) {}

export const buyerRequestDtoResponseSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]*$/),
  buyer_id: z.string().regex(/^[1-9][0-9]*$/),
  status: z.enum(REQUEST_STATUSES),
  version: z.int().min(1).max(MAX_INT32),
  category: z
    .strictObject({
      id: z.string().regex(/^[1-9][0-9]*$/),
      name: z.string(),
    })
    .nullable(),
  spec: z.string().nullable(),
  quantity: z.int().min(1).max(MAX_INT32).nullable(),
  unit: z.enum(REQUEST_UNITS).nullable(),
  unit_set_description: z.string().nullable(),
  delivery_mode: z.enum(DELIVERY_MODES).nullable(),
  delivery_region: z.string().nullable(),
  delivery_address: z.string().nullable(),
  recipient_name: z.string().nullable(),
  recipient_phone: z.string().nullable(),
  bidding_deadline: z.string().nullable(),
  delivery_deadline: z.string().nullable(),
  bidding_closed_at: z.string().nullable(),
  is_bidding_open: z.boolean(),
  cancelled_at: z.string().nullable(),
  cancel_reason: z.string().nullable(),
  split_requested_at: z.string().nullable(),
  coordination_state: z.enum(COORDINATION_STATES).nullable(),
  no_valid_quotes: z.boolean(),
  nearest_accept_deadline: z.string().nullable(),
  delivery_confirmation: z
    .strictObject({
      performed_by: z.strictObject({
        id: z.string().regex(/^[1-9][0-9]*$/),
        display_name: z.string().nullable(),
      }),
      performed_at: z.string(),
      is_admin_action: z.boolean(),
      reason: z.string().nullable(),
      evidence: z.string().nullable(),
    })
    .nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
