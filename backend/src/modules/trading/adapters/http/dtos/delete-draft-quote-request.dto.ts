import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

export const deleteDraftQuoteRequestSchema = z.strictObject({
  expected_request_version: z.int().positive().max(2_147_483_647).optional(),
});

export class DeleteDraftQuoteRequestDto extends createZodDto(
  deleteDraftQuoteRequestSchema,
) {}
