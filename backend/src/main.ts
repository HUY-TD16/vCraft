import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { UnsupportedMediaTypeException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from './common/config/app-config';
import { ProblemDetailsFilter } from './common/http/filters/problem-details.filter';
import { RequestDeadlineInterceptor } from './common/http/request-deadline.interceptor';
import { hasMultipartBoundary, isUploadRequest } from './common/http/upload-request';
import { checkUploadDirectory } from './infrastructure/storage/check-upload-directory';
import { AppModule } from './bootstrap/app.module';
import cookieParser = require('cookie-parser');

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, abortOnError: false });
  const config = app.get<AppConfig>(APP_CONFIG);
  app.enableShutdownHooks();

  // SEC-14: Prefix API toàn hệ thống
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalInterceptors(new RequestDeadlineInterceptor());
  app.use('/api/', (req: Request, _res: Response, next: NextFunction) => {
    if (isUploadRequest(req)) {
      return hasMultipartBoundary(req) ? next() : next(new UnsupportedMediaTypeException());
    }
    if (!req.headers['transfer-encoding'] && !Number(req.headers['content-length'])) return next();
    if (req.is('application/json')) return next();
    return next(new UnsupportedMediaTypeException());
  });
  app.useBodyParser('json', { limit: '1mb' });

  // SEC-05: Cookie parser phục vụ Session Cookie
  app.use(cookieParser());

  await app.init();
  await checkUploadDirectory(config.UPLOAD_DIR);
  await app.listen(config.PORT);
}

void bootstrap().catch(error => {
  console.error(error instanceof Error && /^(UPLOAD_DIR|Missing or invalid environment variables:)/.test(error.message)
    ? error.message : 'Backend startup failed. Check database connectivity and configuration.');
  process.exit(1);
});
