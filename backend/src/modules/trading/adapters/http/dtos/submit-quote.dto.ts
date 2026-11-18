import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';
import { recipientDtoResponseSchema } from './decline-quote-request.dto';

export const submitQuoteSchema = z.strictObject({
  expected_recipient_version: z.int().min(1).max(2_147_483_647),
  expected_quote_version: z.int().min(1).max(2_147_483_647).nullable(),
  unit_price: z.int().min(1).max(999_999_999_999_999),
  max_quantity: z.int().min(1).max(2_147_483_647),
  bid_accept_deadline: z.string().datetime({ offset: true }),
  committed_delivery_at: z.string().datetime({ offset: true }),
});

export class SubmitQuoteDto extends createZodDto(submitQuoteSchema) {}

export const quoteDtoResponseSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]*$/),
  request_id: z.string().regex(/^[1-9][0-9]*$/),
  workshop: z.strictObject({
    id: z.string().regex(/^[1-9][0-9]*$/),
    name: z.string(),
  }),
  unit_price: z.int().min(1).max(999_999_999_999_999),
  max_quantity: z.int().min(1).max(2_147_483_647),
  bid_accept_deadline: z.string(),
  committed_delivery_at: z.string(),
  status: z.enum(['active', 'withdrawn', 'accepted']),
  version: z.int().min(1).max(2_147_483_647),
  withdraw_reason: z.string().nullable(),
  withdrawn_at: z.string().nullable(),
  is_eligible: z.boolean(),
  ineligible_reasons: z.array(
    z.enum([
      'QUOTE_WITHDRAWN',
      'QUOTE_EXPIRED',
      'WORKSHOP_SUSPENDED',
      'REQUEST_CANCELLED',
      'REQUEST_ACCEPTED',
    ]),
  ),
  created_at: z.string(),
  updated_at: z.string(),
});

export const quoteMutationDtoResponseSchema = z.strictObject({
  quote: quoteDtoResponseSchema,
  recipient: recipientDtoResponseSchema,
});

export const submitQuoteOperationResponseSchema = z.strictObject({
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
