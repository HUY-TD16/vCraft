import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { appLogger, type AppLogger } from '../../observability/app-logger';
import { requestContext, type RequestContext } from '../../observability/request-context';

export type ContextRequest = Request & { requestId?: string };

export function requestContextMiddleware(logger: AppLogger = appLogger) {
  return (request: ContextRequest, response: Response, next: NextFunction): void => {
    const context: RequestContext = { requestId: randomUUID(), module: 'Http' };
    request.requestId = context.requestId;
    response.setHeader('X-Request-ID', context.requestId);
    const started = performance.now();
    let recorded = false;
    const record = (aborted: boolean) => {
      if (recorded) return;
      recorded = true;
      requestContext.run(context, () => logger.event(
        response.statusCode >= 500 ? 'error' : aborted || response.statusCode >= 400 ? 'warn' : 'info',
        'http_request', context.module, {
          method: request.method, route: context.route ?? 'unmatched', status: response.statusCode,
          duration_ms: Math.round((performance.now() - started) * 100) / 100,
          outcome: aborted ? 'aborted' : 'completed', code: context.errorCode,
        },
      ));
    };
    response.once('finish', () => record(false));
    response.once('close', () => record(!response.writableFinished));
    requestContext.run(context, next);
  };
}
