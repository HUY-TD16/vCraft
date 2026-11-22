import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

export const ChangeTempPasswordSchema = z
  .strictObject({
    current_temp_password: z.string().min(12).max(128),
    new_password: z.string().min(12).max(128),
    new_password_confirmation: z.string().min(12).max(128),
  })
  .refine(data => data.new_password === data.new_password_confirmation, {
    message: 'Mật khẩu xác nhận không khớp',
    path: ['new_password_confirmation'],
  })
  .refine(data => data.new_password !== data.current_temp_password, {
    message: 'Mật khẩu mới phải khác mật khẩu tạm',
    path: ['new_password'],
  });

export class ChangeTempPasswordDto extends createZodDto(ChangeTempPasswordSchema) {}
