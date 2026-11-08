import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { requestContext } from '../../observability/request-context';

export class RequestLoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const store = requestContext.getStore();
    const request = context.switchToHttp().getRequest<Request>();
    if (store) {
      store.module = context.getClass().name;
      if (typeof request.route?.path === 'string') store.route = request.route.path;
    }
    return next.handle();
  }
}
