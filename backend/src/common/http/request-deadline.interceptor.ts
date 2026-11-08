import { type CallHandler, type ExecutionContext, InternalServerErrorException, type NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { type Observable, mergeMap, takeUntil, throwError, timer } from 'rxjs';
import { isUploadRequest } from './upload-request';

export class RequestDeadlineInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    if (isUploadRequest(request)) return next.handle();

    const deadline = timer(15_000).pipe(
      mergeMap(() => throwError(() => new InternalServerErrorException())),
    );
    return next.handle().pipe(takeUntil(deadline));
  }
}
