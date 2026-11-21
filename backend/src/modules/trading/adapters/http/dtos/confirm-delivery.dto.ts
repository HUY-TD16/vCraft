import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';
import { REQUEST_STATUSES } from '../../../domain/value-objects/trading-enums';

export const confirmDeliverySchema = z.strictObject({
  expected_request_version: z.int().min(1).max(2_147_483_647),
});

export class ConfirmDeliveryDto extends createZodDto(confirmDeliverySchema) {}

export const confirmDeliveryOperationResponseSchema = z.strictObject({
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
