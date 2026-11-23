import { z } from 'zod';
import { allocationDtoResponseSchema } from './accept-quote.dto';

export const allocationDetailDtoResponseSchema = z.strictObject({
  ...allocationDtoResponseSchema.shape,
  recipient_name: z.string().nullable(),
  recipient_phone: z.string().nullable(),
  delivery_address: z.string().nullable(),
});
