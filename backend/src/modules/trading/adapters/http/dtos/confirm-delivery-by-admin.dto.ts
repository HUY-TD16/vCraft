import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';
import { MAX_ADMIN_CONFIRM_DELIVERY_TEXT_LENGTH } from '../../../domain/entities/quote-request.entity';
import { REQUEST_STATUSES } from '../../../domain/value-objects/trading-enums';

/**
 * Request DTO for `POST /api/v1/admin/quote-requests/:id/confirm-delivery-by-admin`
 * (`docsAI/04-architecture/api-design.md` §9.6, §10.5; `UC-26`, `BR-25`, `BR-27`).
 */
export const confirmDeliveryByAdminSchema = z.strictObject({
  expected_request_version: z.int().min(1).max(2_147_483_647),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(MAX_ADMIN_CONFIRM_DELIVERY_TEXT_LENGTH),
  evidence: z
    .string()
    .trim()
    .min(1)
    .max(MAX_ADMIN_CONFIRM_DELIVERY_TEXT_LENGTH),
});

export class ConfirmDeliveryByAdminDto extends createZodDto(
  confirmDeliveryByAdminSchema,
) {}

export const confirmDeliveryByAdminOperationResponseSchema = z.strictObject({
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
