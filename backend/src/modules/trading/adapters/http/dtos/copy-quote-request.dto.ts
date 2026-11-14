import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';

export const copyQuoteRequestSchema = z.strictObject({});

export class CopyQuoteRequestDto extends createZodDto(copyQuoteRequestSchema) {}
