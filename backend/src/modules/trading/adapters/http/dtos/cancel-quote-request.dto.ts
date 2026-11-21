import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';
import { MAX_CANCEL_REASON_LENGTH } from '../../../domain/entities/quote-request.entity';
import { REQUEST_STATUSES } from '../../../domain/value-objects/trading-enums';

export const cancelQuoteRequestSchema = z.strictObject({
  expected_request_version: z.int().min(1).max(2_147_483_647),
  cancel_reason: z
    .string()
    .trim()
    .max(MAX_CANCEL_REASON_LENGTH)
    .nullable()
    .optional(),
});

export class CancelQuoteRequestDto extends createZodDto(
  cancelQuoteRequestSchema,
) {}

export const cancelQuoteRequestOperationResponseSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]*$/),
  replayed: z.boolean(),
  committed_at: z.string(),
  current_state: z.strictObject({
    request: z.strictObject({
      id: z.string().regex(/^[1-9][0-9]*$/),
      status: z.enum(REQUEST_STATUSES),
      version: z.int().min(1).max(2_147_483_647),
      cancelled_at: z.string().nullable(),
    }),
  }),
});
