import { Module } from '@nestjs/common';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

const backendDirectory = resolve(__dirname, '../../..');

const environment = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).refine(value => {
    const url = URL.parse(value);
    return !!url?.hostname && url.pathname.length > 1 && !url.hash
      && (!url.searchParams.has('schema') || !!url.searchParams.get('schema')?.trim());
  }),
  SESSION_SECRET: z.string().refine(value => value.trim().length >= 32),
  PORT: z.string().regex(/^\d+$/).default('3000').transform(Number).pipe(z.int().min(1).max(65535)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ORIGIN: z.url({ protocol: /^https?$/ }).default('http://localhost').refine(value => {
    const url = URL.parse(value);
    return !!url && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  }).transform(value => new URL(value).origin),
  UPLOAD_DIR: z.string().trim().min(1).default('./storage/uploads').transform(value => resolve(backendDirectory, value)),
});

export type AppConfig = Readonly<z.output<typeof environment>>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export class ConfigurationError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Missing or invalid environment variables: ${fields.join(', ')}`);
    this.name = 'ConfigurationError';
  }
}

export function readConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = environment.safeParse(env);
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map(issue => String(issue.path[0])));
    throw new ConfigurationError(Object.freeze([...fields]));
  }
  return Object.freeze(parsed.data);
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  envFile = resolve(backendDirectory, '.env'),
): AppConfig {
  const values = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const result = loadEnv({ path: envFile, processEnv: values, override: false });
  if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw new Error('Cannot read backend .env configuration file');
  }
  return readConfig(values);
}

@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
