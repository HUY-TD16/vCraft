import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

export const AdminResetPasswordSchema = z.strictObject({
  admin_current_password: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
  verification_evidence: z.string().trim().min(1).max(1000),
});

export class AdminResetPasswordDto extends createZodDto(AdminResetPasswordSchema) {}
