import { z } from 'zod';
import {
  ALLOCATION_STATUSES,
  QUOTE_STATUSES,
  RECIPIENT_RESPONSE_STATUSES,
  REQUEST_STATUSES,
} from '../../../domain/value-objects/trading-enums';

export const positiveIdResponseSchema = z.string().regex(/^[1-9][0-9]*$/);

export const versionResponseSchema = z.int().min(1).max(2_147_483_647);

export const actorRefResponseSchema = z.strictObject({
  id: positiveIdResponseSchema,
  display_name: z.string().nullable(),
});

export const workshopRefResponseSchema = z.strictObject({
  id: positiveIdResponseSchema,
  name: z.string(),
});

export const categoryRefDtoSchema = z.strictObject({
  id: positiveIdResponseSchema,
  name: z.string(),
});

export const requestCurrentStateResponseSchema = z.strictObject({
  id: positiveIdResponseSchema,
  status: z.enum(REQUEST_STATUSES),
  version: versionResponseSchema,
  cancelled_at: z.string().nullable(),
});

export const recipientCurrentStateResponseSchema = z
  .strictObject({
    id: positiveIdResponseSchema,
    status: z.enum(RECIPIENT_RESPONSE_STATUSES),
    version: versionResponseSchema,
  })
  .nullable();

export const quoteCurrentStateResponseSchema = z
  .strictObject({
    id: positiveIdResponseSchema,
    status: z.enum(QUOTE_STATUSES),
    version: versionResponseSchema,
  })
  .nullable();

export const allocationCurrentStateResponseSchema = z
  .strictObject({
    id: positiveIdResponseSchema,
    status: z.enum(ALLOCATION_STATUSES),
    version: versionResponseSchema,
  })
  .nullable();

export const requestOperationResponseSchema = z.strictObject({
  id: positiveIdResponseSchema,
  replayed: z.boolean(),
  committed_at: z.string(),
  current_state: z.strictObject({
    request: requestCurrentStateResponseSchema,
  }),
});

export const allocationOperationResponseSchema = z.strictObject({
  id: positiveIdResponseSchema,
  replayed: z.boolean(),
  committed_at: z.string(),
  current_state: z.strictObject({
    request: requestCurrentStateResponseSchema,
    allocation: allocationCurrentStateResponseSchema,
  }),
});

export const recipientOperationResponseSchema = z.strictObject({
  id: positiveIdResponseSchema,
  replayed: z.boolean(),
  committed_at: z.string(),
  current_state: z.strictObject({
    request: requestCurrentStateResponseSchema,
    recipient: recipientCurrentStateResponseSchema,
  }),
});

export const recipientAndQuoteOperationResponseSchema = z.strictObject({
  id: positiveIdResponseSchema,
  replayed: z.boolean(),
  committed_at: z.string(),
  current_state: z.strictObject({
    request: requestCurrentStateResponseSchema,
    recipient: recipientCurrentStateResponseSchema,
    quote: quoteCurrentStateResponseSchema,
  }),
});

export const acceptQuoteOperationResponseSchema = z.strictObject({
  id: positiveIdResponseSchema,
  replayed: z.boolean(),
  committed_at: z.string(),
  current_state: z.strictObject({
    request: requestCurrentStateResponseSchema,
    quote: quoteCurrentStateResponseSchema.optional(),
  }),
});
