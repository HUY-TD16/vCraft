import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

export const ChangePasswordSchema = z.strictObject({
  current_password: z.string().min(12).max(128),
  new_password: z.string().min(12).max(128),
  new_password_confirmation: z.string().min(12).max(128),
});

export class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}
