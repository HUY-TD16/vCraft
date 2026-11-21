import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';
import { MAX_WITHDRAW_REASON_LENGTH } from '../../../domain/entities/quote.entity';

export const withdrawQuoteSchema = z.strictObject({
  expected_recipient_version: z.int().min(1).max(2_147_483_647),
  expected_quote_version: z.int().min(1).max(2_147_483_647),
  withdraw_reason: z.string().trim().min(1).max(MAX_WITHDRAW_REASON_LENGTH),
});

export class WithdrawQuoteDto extends createZodDto(withdrawQuoteSchema) {}

export const withdrawQuoteOperationResponseSchema = z.strictObject({
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
    recipient: z
      .strictObject({
        id: z.string().regex(/^[1-9][0-9]*$/),
        status: z.enum(['pending', 'declined', 'quoted', 'withdrawn']),
        version: z.int().min(1).max(2_147_483_647),
      })
      .nullable(),
    quote: z
      .strictObject({
        id: z.string().regex(/^[1-9][0-9]*$/),
        status: z.enum(['active', 'withdrawn', 'accepted']),
        version: z.int().min(1).max(2_147_483_647),
      })
      .nullable(),
  }),
});
