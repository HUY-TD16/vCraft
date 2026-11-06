import { Module } from '@nestjs/common';
import { resolve } from 'node:path';
import { z } from 'zod';

const environment = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).refine(value => {
    const url = URL.parse(value);
    return !!url?.hostname && url.pathname.length > 1;
  }),
  SESSION_SECRET: z.string().trim().min(32),
  PORT: z.string().regex(/^\d+$/).default('3000').transform(Number).pipe(z.int().min(1).max(65535)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ORIGIN: z.url({ protocol: /^https?$/ }).default('http://localhost').refine(value => {
    const url = URL.parse(value);
    return !!url && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  }).transform(value => new URL(value).origin),
  UPLOAD_DIR: z.string().trim().min(1).default('./storage/uploads').transform(value => resolve(value)),
});

export type AppConfig = z.output<typeof environment>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function readConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = environment.safeParse(env);
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map(issue => issue.path[0]));
    throw new Error(`Missing or invalid environment variables: ${[...fields].join(', ')}`);
  }
  return parsed.data;
}

@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => readConfig(process.env) }],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
