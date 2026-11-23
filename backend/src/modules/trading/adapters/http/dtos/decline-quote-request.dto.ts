import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';
import { MAX_DECLINE_REASON_LENGTH } from '../../../domain/entities/quote-request.entity';

export const declineQuoteRequestSchema = z.strictObject({
  expected_recipient_version: z.int().min(1).max(2_147_483_647),
  decline_reason: z
    .string()
    .trim()
    .max(MAX_DECLINE_REASON_LENGTH)
    .nullable()
    .optional(),
});

export class DeclineQuoteRequestDto extends createZodDto(
  declineQuoteRequestSchema,
) {}

export const recipientDtoResponseSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]*$/),
  request_id: z.string().regex(/^[1-9][0-9]*$/),
  workshop: z.strictObject({
    id: z.string().regex(/^[1-9][0-9]*$/),
    name: z.string(),
  }),
  response_status: z.enum(['pending', 'declined', 'quoted', 'withdrawn']),
  version: z.int().min(1).max(2_147_483_647),
  sent_at: z.string(),
  responded_at: z.string().nullable(),
  decline_reason: z.string().nullable(),
  eligibility_labels: z.array(
    z.enum([
      'QUOTE_WITHDRAWN',
      'QUOTE_EXPIRED',
      'WORKSHOP_SUSPENDED',
      'REQUEST_CANCELLED',
      'REQUEST_ACCEPTED',
    ]),
  ),
});

import { recipientOperationResponseSchema } from './trading-openapi-response.schemas';
export const declineOperationResponseSchema = recipientOperationResponseSchema;
