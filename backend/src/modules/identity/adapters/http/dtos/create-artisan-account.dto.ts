import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

export const CreateArtisanAccountSchema = z.strictObject({
  username: z.string().trim().min(4).max(32).regex(/^[a-zA-Z0-9._]+$/),
  workshop_name: z.string().trim().min(2).max(200),
  address: z.string().trim().max(500).optional(),
});

export class CreateArtisanAccountDto extends createZodDto(CreateArtisanAccountSchema) {}
