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

export const linkBatchItemSchema = z.strictObject({
  batch_id: positiveBigIntIdSchema,
  linked_quantity: z.int().min(1).max(2_147_483_647),
});

export const linkAllocationBatchesSchema = z.strictObject({
  expected_allocation_version: z.int().min(1).max(2_147_483_647),
  links: z.array(linkBatchItemSchema).max(100),
});

export const linkBatchesSchema = linkAllocationBatchesSchema;

export class LinkAllocationBatchesDto extends createZodDto(
  linkAllocationBatchesSchema,
) {}

export { LinkAllocationBatchesDto as LinkBatchesDto };

export const linkAllocationBatchesOperationResponseSchema = z.strictObject({
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
    allocation: z
      .strictObject({
        id: z.string().regex(/^[1-9][0-9]*$/),
        status: z.enum(['not_started', 'in_production', 'handed_over']),
        version: z.int().min(1).max(2_147_483_647),
      })
      .nullable(),
  }),
});

export const linkBatchesOperationResponseSchema =
  linkAllocationBatchesOperationResponseSchema;
