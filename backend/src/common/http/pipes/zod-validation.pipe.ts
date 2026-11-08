import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';

export class InputValidationError extends BadRequestException {
  constructor(readonly errors: { field: string; message: string }[]) {
    super();
  }
}

function pointer(path: PropertyKey[]): string {
  return path.map(key => '/' + String(key).replaceAll('~', '~0').replaceAll('/', '~1')).join('');
}

export class ZodValidationPipe<T extends z.ZodObject<z.core.$ZodShape, z.core.$strict>> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new InputValidationError(result.error.issues.flatMap(issue => {
      if (issue.code === 'unrecognized_keys') {
        return issue.keys.map(key => ({
          field: pointer([...issue.path, key]),
          message: 'Trường này không được phép gửi.',
        }));
      }
      return [{ field: pointer(issue.path), message: 'Giá trị không đúng định dạng hoặc giới hạn cho phép.' }];
    }));
  }
}
