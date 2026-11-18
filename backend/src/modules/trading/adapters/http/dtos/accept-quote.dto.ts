import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

const MAX_BIGINT_ID = 9223372036854775807n;

const positiveBigIntIdSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine(
    (val) => {
      try {
        const parsed = BigInt(val);
        return parsed > 0n && parsed <= MAX_BIGINT_ID;
      } catch {
        return false;
      }
    },
    { message: 'ID exceeds the 64-bit signed integer range.' },
  );

export const acceptQuoteSchema = z.strictObject({
  quote_id: positiveBigIntIdSchema,
  expected_request_version: z.int().min(1).max(2_147_483_647),
  expected_quote_version: z.int().min(1).max(2_147_483_647),
});

export class AcceptQuoteDto extends createZodDto(acceptQuoteSchema) {}

export const actorRefResponseSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]*$/),
  display_name: z.string().nullable(),
});

export const allocationDtoResponseSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]*$/),
  request_id: z.string().regex(/^[1-9][0-9]*$/),
  workshop: z.strictObject({
    id: z.string().regex(/^[1-9][0-9]*$/),
    name: z.string(),
  }),
  quote_id: z.string().regex(/^[1-9][0-9]*$/),
  quantity: z.int().min(1).max(2_147_483_647),
  unit_price: z.int().min(1).max(999_999_999_999_999),
  committed_delivery_at: z.string(),
  status: z.enum(['not_started', 'in_production', 'handed_over']),
  version: z.int().min(1).max(2_147_483_647),
  started_at: z.string().nullable(),
  started_by: actorRefResponseSchema.nullable(),
  handed_over_at: z.string().nullable(),
  handed_over_by: actorRefResponseSchema.nullable(),
  delivery_note: z.string().nullable(),
  admin_handed_over: z.boolean(),
  admin_handover_reason: z.string().nullable(),
  admin_delivery_evidence: z.string().nullable(),
  admin_handover_actual_at: z.string().nullable(),
  traceability_warning: z
    .enum(['NO_BATCH_LINK', 'INCOMPLETE_TRACEABILITY'])
    .nullable(),
});

export const acceptanceDtoResponseSchema = z.strictObject({
  request_id: z.string().regex(/^[1-9][0-9]*$/),
  request_status: z.enum([
    'draft_request',
    'sent_to_artisans',
    'artisans_bidding',
    'buyer_accepted',
    'in_production',
    'delivered',
  ]),
  request_version: z.int().min(1).max(2_147_483_647),
  allocations: z.array(allocationDtoResponseSchema),
});

export const acceptQuoteOperationResponseSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]*$/),
  replayed: z.boolean(),
  committed_at: z.string(),
  current_state: z.strictObject({
    request: z.strictObject({
      id: z.string().regex(/^[1-9][0-9]*$/),
      status: z.enum([
        'draft_request',
        'sent_to_artisans',
        'artisans_bidding',
        'buyer_accepted',
        'in_production',
        'delivered',
      ]),
      version: z.int().min(1).max(2_147_483_647),
      cancelled_at: z.string().nullable(),
    }),
    quote: z
      .strictObject({
        id: z.string().regex(/^[1-9][0-9]*$/),
        status: z.enum(['active', 'withdrawn', 'accepted']),
        version: z.int().min(1).max(2_147_483_647),
      })
      .nullable()
      .optional(),
  }),
});
