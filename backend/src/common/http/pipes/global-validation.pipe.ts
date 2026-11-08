import { InternalServerErrorException, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

type StrictSchema = z.ZodObject<z.core.$ZodShape, z.core.$strict>;

export function createZodDto<T extends StrictSchema>(schema: T) {
  class Dto { static readonly schema = schema; }
  return Dto as unknown as { new(): z.output<T>; readonly schema: T };
}

export class GlobalValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type === 'custom') return value;
    const schema = (metadata.metatype as { schema?: StrictSchema } | undefined)?.schema;
    if (!schema) throw new InternalServerErrorException();
    return new ZodValidationPipe(schema).transform(value === undefined ? {} : value);
  }
}

export const queryInteger = (minimum: number, maximum = Number.MAX_SAFE_INTEGER) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(minimum).max(maximum));

export const queryBoolean = z.enum(['true', 'false']).transform(value => value === 'true');

export const paginationQuery = z.strictObject({
  page: queryInteger(1).default(1),
  limit: queryInteger(1, 100).default(20),
});
