import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

export const startAllocationSchema = z.strictObject({
  expected_allocation_version: z.int().min(1).max(2_147_483_647),
});

export class StartAllocationDto extends createZodDto(startAllocationSchema) {}

export const startAllocationOperationResponseSchema = z.strictObject({
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
