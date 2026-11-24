import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

export const ChangePasswordSchema = z
  .strictObject({
    current_password: z.string().min(12).max(128),
    new_password: z.string().min(12).max(128),
    new_password_confirmation: z.string().min(12).max(128),
  })
  .refine(data => data.new_password === data.new_password_confirmation, {
    message: 'Mật khẩu xác nhận không khớp',
    path: ['new_password_confirmation'],
  })
  .refine(data => data.new_password !== data.current_password, {
    message: 'Mật khẩu mới phải khác mật khẩu hiện tại',
    path: ['new_password'],
  });

export class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}
