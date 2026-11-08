import 'reflect-metadata';
import { Body, Controller, Get, HttpCode, Module, Post, Query, StreamableFile } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { configureHttp } from '../../src/bootstrap/configure-http';
import { AppLogger } from '../../src/common/observability/app-logger';
import { requestContext } from '../../src/common/observability/request-context';
import { createZodDto, paginationQuery, queryBoolean } from '../../src/common/http/pipes/global-validation.pipe';
import { HttpResult } from '../../src/common/http/interceptors/response-envelope.interceptor';
import { ApiProblem } from '../../src/common/http/filters/api-problem';
import { WorkshopSuspended } from '../../src/modules/workshops/domain/errors/workshop-suspended';

class InputDto extends createZodDto(z.strictObject({
  name: z.string().trim().min(1), password: z.string().min(1),
  items: z.array(z.strictObject({ quantity: z.int().positive() })),
})) {}
class QueryDto extends createZodDto(paginationQuery.extend({ enabled: queryBoolean.optional() })) {}

@Controller('fixture')
class FixtureController {
  @Post() input(@Body() body: InputDto) { return body; }
  @Get() query(@Query() query: QueryDto) { return query; }
  @Get('page') page() { return new HttpResult([], { pagination: { page: 1, limit: 20, total_records: 0, total_pages: 0 } }); }
  @Get('operation') operation() { return new HttpResult({ id: '1' }, { operation: {
    id: '2', replayed: false, committed_at: '2026-11-08T00:00:00.000Z', current_state: { id: '1' },
  } }); }
  @Get('business') business() { throw new WorkshopSuspended(); }
  @Get('unexpected') unexpected() { throw new Error('password=private-password SQL SELECT private-phone'); }
  @Get('limited') limited() { throw new ApiProblem('RATE_LIMIT_EXCEEDED', 5); }
  @Get('unavailable') unavailable() { throw new ApiProblem('SECURITY_SERVICE_UNAVAILABLE'); }
  @Get('empty') @HttpCode(204) empty() { return { hidden: true }; }
  @Get('file') file() { return new StreamableFile(Buffer.from([137, 80, 78, 71]), { type: 'image/png' }); }
  @Get('broken-file') brokenFile() {
    return new StreamableFile(new Readable({ read() { this.destroy(new Error('private-file-path')); } }), { type: 'image/png', length: 100 });
  }
  @Post('untyped') untyped(@Body() body: object) { return body; }
  @Get('context') async context() {
    const before = requestContext.getStore()?.requestId;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { before, after: requestContext.getStore()?.requestId };
  }
}
Reflect.defineMetadata('design:paramtypes', [InputDto], FixtureController.prototype, 'input');
Reflect.defineMetadata('design:paramtypes', [QueryDto], FixtureController.prototype, 'query');
Reflect.defineMetadata('design:paramtypes', [Object], FixtureController.prototype, 'untyped');

@Module({ controllers: [FixtureController] })
class FixtureModule {}

describe('global HTTP foundation', () => {
  let app: NestExpressApplication;
  let base: string;
  const lines: string[] = [];
  const logger = new AppLogger('info', (line, done) => { lines.push(line); done(); });
  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(FixtureModule, { bodyParser: false, logger: false });
    configureHttp(app, logger);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl() + '/api/v1';
  });
  afterAll(async () => { await app?.close(); });

  const post = (path: string, body: unknown) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  it('validates and transforms a DTO without trimming passwords or coercing JSON numbers', async () => {
    const good = await post('/fixture', { name: ' Clay ', password: ' secret ', items: [{ quantity: 1 }] });
    expect(await good.json()).toEqual({ success: true, data: { name: 'Clay', password: ' secret ', items: [{ quantity: 1 }] } });
    const bad = await post('/fixture', { name: 'Clay', password: ' secret ', items: [{ quantity: '1', owner_id: '1' }], role: 'admin' });
    const problem = await bad.json();
    expect(bad.status).toBe(400);
    expect(problem.errors.map((item: {field: string}) => item.field)).toEqual(['/items/0/quantity', '/items/0/owner_id', '/role']);
    expect(problem.tracking_id).toBe(bad.headers.get('x-request-id'));
  });

  it('converts only declared query values and rejects invalid, repeated and extra parameters', async () => {
    expect(await (await fetch(base + '/fixture?enabled=false&page=2')).json()).toEqual({ success: true, data: { page: 2, limit: 20, enabled: false } });
    for (const query of ['limit=101', 'enabled=0', 'page=', 'page=1&page=2', 'unknown=1']) {
      expect((await fetch(base + '/fixture?' + query)).status).toBe(400);
    }
  });

  it.each([
    ['business', 422, 'WORKSHOP_SUSPENDED'], ['unexpected', 500, 'INTERNAL_SERVER_ERROR'],
    ['limited', 429, 'RATE_LIMIT_EXCEEDED'], ['unavailable', 503, 'SECURITY_SERVICE_UNAVAILABLE'],
    ['missing', 404, 'RESOURCE_NOT_FOUND'],
  ])('normalizes %s and records exactly one correlated request log', async (path, status, code) => {
    const response = await fetch(base + '/fixture/' + path, { headers: { 'X-Request-ID': 'untrusted-id', Cookie: 'secret-cookie' } });
    const body = await response.json();
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(body).toMatchObject({ status, code, tracking_id: response.headers.get('x-request-id') });
    expect(body.tracking_id).toMatch(/^[0-9a-f-]{36}$/);
    const logs = lines.map(line => JSON.parse(line)).filter(log => log.request_id === body.tracking_id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status, code, event: 'http_request', outcome: 'completed' });
    expect(logs[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify({ body, logs })).not.toMatch(/private-password|private-phone|secret-cookie|untrusted-id|SELECT/);
    if (status === 429) expect(response.headers.get('retry-after')).toBe('5');
  });

  it('covers body parser and content-type failures before interceptors', async () => {
    for (const [body, contentType, status] of [
      ['{', 'application/json', 400], ['x', 'text/plain', 415],
      [JSON.stringify({ data: 'x'.repeat(1024 * 1024) }), 'application/json', 413],
    ] as const) {
      const response = await fetch(base + '/fixture', { method: 'POST', headers: { 'Content-Type': contentType }, body });
      const problem = await response.json();
      expect(response.status).toBe(status);
      expect(problem.tracking_id).toBe(response.headers.get('x-request-id'));
      expect(lines.map(line => JSON.parse(line)).filter(log => log.request_id === problem.tracking_id)).toHaveLength(1);
    }
  });

  it('preserves pagination, operation metadata, empty responses and file bytes', async () => {
    expect(await (await fetch(base + '/fixture/page')).json()).toEqual({ success: true, data: [], pagination: { page: 1, limit: 20, total_records: 0, total_pages: 0 } });
    expect(await (await fetch(base + '/fixture/operation')).json()).toMatchObject({ success: true, data: { id: '1' }, operation: { id: '2', replayed: false } });
    const empty = await fetch(base + '/fixture/empty');
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');
    const file = await fetch(base + '/fixture/file');
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it('fails closed for an endpoint missing its DTO schema', async () => {
    expect((await post('/fixture/untyped', { role: 'admin' })).status).toBe(500);
  });

  it('normalizes stream errors before headers are sent without exposing file paths', async () => {
    const response = await fetch(base + '/fixture/broken-file');
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const problem = await response.json();
    expect(problem.code).toBe('INTERNAL_SERVER_ERROR');
    expect(JSON.stringify(problem)).not.toContain('private-file-path');
    expect(lines.map(line => JSON.parse(line)).filter(log => log.request_id === problem.tracking_id)).toHaveLength(1);
  });

  it('isolates concurrent request contexts and omits query strings from logs', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, async () => {
      const response = await fetch(base + '/fixture/context?token=private-query-token');
      const { data } = await response.json();
      expect(data.before).toBe(response.headers.get('x-request-id'));
      expect(data.after).toBe(data.before);
      return data.before;
    }));
    expect(new Set(results).size).toBe(8);
    expect(lines.join('')).not.toMatch(/private-query-token|secret-cookie|"password"|SELECT/);
  });
});

describe('structured logger', () => {
  it('drops sensitive and arbitrary fields, escapes newlines and respects minimum level', () => {
    const lines: string[] = [];
    const logger = new AppLogger('warn', (line, done) => { lines.push(line); done(); });
    logger.event('info', 'ignored', 'Test');
    logger.event('warn', 'event', 'Test', { status: 400, password: 'private', body: { token: 'private' }, phone: 'private', message: 'private', outcome: 'line\nbreak' });
    expect(lines).toHaveLength(1);
    expect(lines[0].trim().split('\n')).toHaveLength(1);
    expect(lines[0]).not.toContain('private');
    expect(JSON.parse(lines[0])).toMatchObject({ status: 400, level: 'warn' });
  });

  it('bounds buffered logs, exposes sink failure and retries without throwing into business code', () => {
    let unavailable = true;
    const logger = new AppLogger('info', (_line, done) => { done(unavailable ? new Error('private sink error') : undefined); });
    for (let i = 0; i < 105; i++) logger.event('info', 'event', 'Test');
    expect(logger.getHealth()).toEqual({ healthy: false, queued: 100, dropped: 5 });
    unavailable = false;
    logger.flush();
    expect(logger.getHealth().queued).toBe(0);
  });
});
