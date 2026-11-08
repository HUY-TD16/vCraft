import { UnsupportedMediaTypeException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import cookieParser = require('cookie-parser');
import { appLogger, type AppLogger } from '../common/observability/app-logger';
import { requestContextMiddleware } from '../common/http/middleware/request-context.middleware';
import { ProblemDetailsFilter } from '../common/http/filters/problem-details.filter';
import { GlobalValidationPipe } from '../common/http/pipes/global-validation.pipe';
import { RequestLoggingInterceptor } from '../common/http/interceptors/request-logging.interceptor';
import { ResponseEnvelopeInterceptor } from '../common/http/interceptors/response-envelope.interceptor';
import { RequestDeadlineInterceptor } from '../common/http/request-deadline.interceptor';
import { hasMultipartBoundary, isUploadRequest } from '../common/http/upload-request';

export function configureHttp(app: NestExpressApplication, logger: AppLogger = appLogger): void {
  app.setGlobalPrefix('api/v1');
  app.use(requestContextMiddleware(logger));
  app.useGlobalFilters(new ProblemDetailsFilter(logger));
  app.useGlobalPipes(new GlobalValidationPipe());
  app.useGlobalInterceptors(new RequestLoggingInterceptor(), new RequestDeadlineInterceptor(), new ResponseEnvelopeInterceptor(logger));
  app.use('/api/', (req: Request, _res: Response, next: NextFunction) => {
    if (isUploadRequest(req)) {
      return hasMultipartBoundary(req) ? next() : next(new UnsupportedMediaTypeException());
    }
    if (!req.headers['transfer-encoding'] && !Number(req.headers['content-length'])) return next();
    if (req.is('application/json')) return next();
    return next(new UnsupportedMediaTypeException());
  });
  app.useBodyParser('json', { limit: '1mb' });
  app.use(cookieParser());
}
