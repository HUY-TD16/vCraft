import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';
import { REQUEST_STATUSES } from '../../../domain/value-objects/trading-enums';

export const confirmDeliverySchema = z.strictObject({
  expected_request_version: z.int().min(1).max(2_147_483_647),
});

export class ConfirmDeliveryDto extends createZodDto(confirmDeliverySchema) {}

import { requestOperationResponseSchema } from './trading-openapi-response.schemas';
export const confirmDeliveryOperationResponseSchema = requestOperationResponseSchema;
