import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

export const closeBiddingSchema = z.strictObject({
  expected_request_version: z.int().positive(),
});

export class CloseBiddingDto extends createZodDto(closeBiddingSchema) {}
