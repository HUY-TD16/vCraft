import { StreamableFile, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { map } from 'rxjs';
import { ProblemDetailsFilter } from '../filters/problem-details.filter';
import { appLogger, type AppLogger } from '../../observability/app-logger';
import { createPageResult, type Pagination, type PaginationParams } from '../../application/types/pagination';
import type { OperationMetadata } from '../../application/types/operation-metadata';

export type { Pagination } from '../../application/types/pagination';

export class HttpResult<T, TState = unknown> {
  constructor(readonly data: T, readonly metadata: {
    pagination?: Pagination;
    operation?: OperationMetadata<TState>;
  } = {}) {}

  static paginated<T>(data: readonly T[], totalRecords: number, params: PaginationParams): HttpResult<readonly T[]> {
    const page = createPageResult(data, totalRecords, params);
    return new HttpResult(page.data, { pagination: page.pagination });
  }
}

export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly logger: AppLogger = appLogger) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(map(value => {
      if (response.statusCode === 204 || response.headersSent) return undefined;
      if (value instanceof StreamableFile) {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        value.setErrorHandler(error => new ProblemDetailsFilter(this.logger).catch(error, context));
        value.setErrorLogger(() => {});
        return value;
      }
      return value instanceof HttpResult
        ? { success: true, data: value.data, ...value.metadata }
        : { success: true, data: value ?? null };
    }));
  }
}
