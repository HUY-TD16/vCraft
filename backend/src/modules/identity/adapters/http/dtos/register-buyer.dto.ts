import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';
import { VnPhoneSchema } from '../../../../../common/validators/common-schemas';

export const RegisterBuyerSchema = z
  .strictObject({
    username: z.string().trim().min(4).max(32).regex(/^[a-zA-Z0-9._]+$/),
    password: z.string().min(12).max(128),
    password_confirmation: z.string().min(12).max(128),
    display_name: z.string().trim().min(2).max(100),
    phone: VnPhoneSchema.optional(),
  })
  .refine(data => data.password === data.password_confirmation, {
    message: 'Mật khẩu xác nhận không khớp',
    path: ['password_confirmation'],
  });

export class RegisterBuyerDto extends createZodDto(RegisterBuyerSchema) {}
