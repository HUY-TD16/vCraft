import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

export const updateRecipientContactSchema = z
  .strictObject({
    expected_request_version: z.int().positive(),
    recipient_name: z.string().trim().min(1).max(200).optional(),
    recipient_phone: z.string().trim().min(1).max(20).optional(),
  })
  .refine(
    (data) =>
      data.recipient_name !== undefined || data.recipient_phone !== undefined,
    {
      message:
        'At least one of recipient_name or recipient_phone must be provided.',
      path: ['recipient_name'],
    },
  );

export class UpdateRecipientContactDto extends createZodDto(
  updateRecipientContactSchema,
) {}
