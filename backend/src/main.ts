import { NestFactory } from '@nestjs/core';
import { AppModule } from './bootstrap/app.module';
import cookieParser from 'cookie-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // SEC-14: Prefix API toàn hệ thống
  app.setGlobalPrefix('api');

  // SEC-05: Cookie parser phục vụ Session Cookie
  app.use(cookieParser());

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`vCraft Backend is running on: http://localhost:${port}/api`);
}

bootstrap();
