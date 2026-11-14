import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

export const updateDraftQuoteRequestSchema = z.strictObject({
  expected_request_version: z.int().positive(),
  category_id: z.string().regex(/^[1-9][0-9]*$/).nullable().optional(),
  spec: z.string().trim().nullable().optional(),
  quantity: z.int().positive().nullable().optional(),
  unit: z.enum(['piece', 'set']).nullable().optional(),
  unit_set_description: z.string().trim().nullable().optional(),
  delivery_mode: z.enum(['at_workshop', 'at_buyer_address']).nullable().optional(),
  delivery_region: z.string().trim().nullable().optional(),
  delivery_address: z.string().trim().nullable().optional(),
  recipient_name: z.string().trim().nullable().optional(),
  recipient_phone: z.string().trim().nullable().optional(),
  bidding_deadline: z.string().datetime({ offset: true }).nullable().optional(),
  delivery_deadline: z.string().datetime({ offset: true }).nullable().optional(),
});

export class UpdateDraftQuoteRequestDto extends createZodDto(
  updateDraftQuoteRequestSchema,
) {}
