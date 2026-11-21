import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

export const ChangeTempPasswordSchema = z.strictObject({
  current_temp_password: z.string().min(12).max(128),
  new_password: z.string().min(12).max(128),
  new_password_confirmation: z.string().min(12).max(128),
});

export class ChangeTempPasswordDto extends createZodDto(ChangeTempPasswordSchema) {}
