import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

export const RegisterBuyerSchema = z.strictObject({
  username: z.string().trim().min(4).max(32).regex(/^[a-zA-Z0-9._]+$/),
  password: z.string().min(12).max(128),
  password_confirmation: z.string().min(12).max(128),
  display_name: z.string().trim().min(2).max(100),
  phone: z.string().trim().max(20).optional(),
});

export class RegisterBuyerDto extends createZodDto(RegisterBuyerSchema) {}
