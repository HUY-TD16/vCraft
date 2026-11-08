import 'reflect-metadata';
import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Public, Roles } from '../../src/common/security/decorators/access-policy';
import { createZodDto, paginationQuery } from '../../src/common/http/pipes/global-validation.pipe';
import { createApiDocument, configureSwagger } from '../../src/common/http/swagger/configure-swagger';
import { ApiDataResponse, ApiEmptyResponse, ApiImageResponse, ApiPaginationQuery, ApiProblemResponses, ApiZodBody, ApiZodParameters } from '../../src/common/http/swagger/api-contract.decorators';

const item = z.strictObject({ id: z.string().regex(/^[1-9][0-9]*$/), name: z.string() });
class Input extends createZodDto(z.strictObject({ name: z.string().trim().min(1) })) {}
class List extends createZodDto(paginationQuery) {}
@Controller('fixture')
@Roles('artisan')
class FixtureController {
  @Get() @Public() @ApiZodParameters(List) @ApiDataResponse(item, { paginated: true })
  list(@Query() _query: List) {}
  @Post() @ApiZodBody(Input) @ApiDataResponse(item, { status: 201 })
  @ApiProblemResponses('INVALID_INPUT', 'AUTHENTICATION_REQUIRED', 'PERMISSION_DENIED', 'RATE_LIMIT_EXCEEDED', 'INTERNAL_SERVER_ERROR')
  create(@Body() _body: Input) {}
  @Get('empty') @ApiEmptyResponse() empty() {}
  @Get('image') @ApiImageResponse() image() {}
  @Get('pagination') @ApiPaginationQuery() pagination() {}
}
Reflect.defineMetadata('design:paramtypes', [Input], FixtureController.prototype, 'create');
Reflect.defineMetadata('design:paramtypes', [List], FixtureController.prototype, 'list');
@Module({ controllers: [FixtureController] })
class FixtureModule {}

describe('shared OpenAPI contract', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(FixtureModule, { logger: false });
    app.setGlobalPrefix('api/v1');
  });
  afterAll(async () => { await app.close(); });

  it('generates the real OpenAPI version and environment-specific cookie scheme', () => {
    const dev = createApiDocument(app, { NODE_ENV: 'development' });
    expect(dev.openapi).toBe('3.0.0');
    expect(dev.components?.securitySchemes?.session).toMatchObject({ type: 'apiKey', in: 'cookie', name: 'vcraft-session' });
    expect(createApiDocument(app, { NODE_ENV: 'production' }).components?.securitySchemes?.session).toMatchObject({ name: '__Host-vcraft-session' });
  });

  it('matches access metadata, includes CSRF for mutations and describes strict input DTOs', () => {
    const doc = createApiDocument(app, { NODE_ENV: 'development' });
    const route = doc.paths['/api/v1/fixture'];
    expect(route.get?.security).toEqual([]);
    expect(route.post?.security).toEqual([{ session: [] }]);
    expect(route.post).toHaveProperty('x-roles', ['artisan']);
    expect(route.post?.parameters).toContainEqual(expect.objectContaining({ name: 'X-CSRF-Token', in: 'header', required: true }));
    expect(route.post?.requestBody).toMatchObject({ content: { 'application/json': { schema: {
      additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1 } },
    } } } });
    expect(route.get?.parameters).toContainEqual(expect.objectContaining({ name: 'page', required: false, schema: expect.objectContaining({ type: 'string', pattern: '^\\d+$' }) }));
    expect(doc.paths['/api/v1/fixture/pagination'].get?.parameters).toContainEqual(expect.objectContaining({ name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }));
  });

  it('uses shared pagination and Problem Details including Retry-After and field errors', () => {
    const doc = createApiDocument(app, { NODE_ENV: 'development' });
    const route = doc.paths['/api/v1/fixture'];
    expect(route.get?.responses['200']).toMatchObject({ content: { 'application/json': { schema: {
      properties: { success: { enum: [true] }, data: { type: 'array' }, pagination: { $ref: '#/components/schemas/Pagination' } },
    } } } });
    expect(route.post?.responses['400']).toMatchObject({ content: { 'application/problem+json': {
      schema: { $ref: '#/components/schemas/ProblemDetails' }, examples: { INVALID_INPUT: { value: { status: 400, errors: [{ field: '/quantity', message: expect.any(String) }] } } },
    } } });
    expect(route.post?.responses['429']).toHaveProperty('headers.Retry-After');
    expect(doc.components?.schemas?.Pagination).toHaveProperty('properties.total_pages.minimum', 0);
    expect(doc.paths['/api/v1/fixture/empty'].get?.responses['204']).not.toHaveProperty('content');
    expect(doc.paths['/api/v1/fixture/image'].get?.responses['200']).toHaveProperty('content.image/png.schema.format', 'binary');
  });

  it('exposes documentation only in development and disables interactive mutation execution', () => {
    const setup = vi.spyOn(SwaggerModule, 'setup').mockImplementation(() => {});
    try {
      configureSwagger(app, { NODE_ENV: 'production' });
      configureSwagger(app, { NODE_ENV: 'test' });
      expect(setup).not.toHaveBeenCalled();
      configureSwagger(app, { NODE_ENV: 'development' });
      expect(setup).toHaveBeenCalledWith('api/docs', app, expect.any(Object), expect.objectContaining({
        jsonDocumentUrl: 'api/docs/openapi.json', swaggerOptions: { supportedSubmitMethods: [], persistAuthorization: false },
      }));
    } finally { setup.mockRestore(); }
  });
});
