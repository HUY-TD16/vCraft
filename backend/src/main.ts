import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { APP_CONFIG, type AppConfig } from './common/config/app-config';
import { checkUploadDirectory } from './infrastructure/storage/check-upload-directory';
import { AppModule } from './bootstrap/app.module';
import { appLogger } from './common/observability/app-logger';
import { configureHttp } from './bootstrap/configure-http';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, abortOnError: false, logger: appLogger });
  const config = app.get<AppConfig>(APP_CONFIG);
  app.enableShutdownHooks();

  configureHttp(app);

  await app.init();
  await checkUploadDirectory(config.UPLOAD_DIR);
  await app.listen(config.PORT);
}

void bootstrap().catch(error => {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', module: 'Bootstrap',
    event: 'startup_failed', message: error instanceof Error && /^(UPLOAD_DIR|Missing or invalid environment variables:|Cannot read backend .env)/.test(error.message)
      ? error.message : 'Backend startup failed. Check database connectivity and configuration.' }));
  process.exit(1);
});
