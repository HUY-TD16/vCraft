import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { statusByCode } from '../filters/api-problem';
import { requestIdHeader } from './api-schemas';
import { problems } from '../filters/problem-details.filter';
import { PAGINATION } from '../../application/types/pagination';
import { deferSchemaDecorator } from './deferred-schema.decorators';

export function schemaFor(schema: z.ZodType, io: 'input' | 'output' = 'output'): SchemaObject {
  return z.toJSONSchema(schema, { target: 'openapi-3.0', io }) as SchemaObject;
}

export const ApiZodBody = (dto: { schema: z.ZodType }, openApiSchema?: SchemaObject) =>
  deferSchemaDecorator(() => ApiBody({ required: true, schema: openApiSchema ?? schemaFor(dto.schema, 'input') }));

export function ApiZodParameters(dto: { schema: z.ZodType }, location: 'query' | 'path' = 'query', openApiSchema?: SchemaObject) {
  return deferSchemaDecorator(() => {
    const schema = openApiSchema ?? schemaFor(dto.schema, 'input');
    return applyDecorators(...Object.entries(schema.properties ?? {}).map(([name, property]) => {
      if (!('$ref' in property) && property.type === 'string' && typeof property.default === 'number') {
        property.default = String(property.default);
      }
      const options = { name, required: location === 'path' || !!schema.required?.includes(name), schema: property };
      return location === 'path' ? ApiParam(options) : ApiQuery(options);
    }));
  });
}

export function ApiDataResponse(schema: z.ZodType, options: {
  status?: 200 | 201; paginated?: boolean; example?: unknown; operation?: z.ZodType;
  openApiSchema?: SchemaObject; operationSchema?: SchemaObject;
} = {}) {
  return deferSchemaDecorator(() => ApiResponse({
    status: options.status ?? 200, description: 'Thành công', headers: { 'X-Request-ID': requestIdHeader },
    content: { 'application/json': { schema: {
      type: 'object', required: ['success', 'data', ...(options.paginated ? ['pagination'] : []), ...(options.operation ? ['operation'] : [])],
      properties: {
        success: { type: 'boolean', enum: [true] },
        data: options.paginated
          ? { type: 'array', items: options.openApiSchema ?? schemaFor(schema) }
          : options.openApiSchema ?? schemaFor(schema),
        ...(options.paginated && { pagination: { $ref: '#/components/schemas/Pagination' } }),
        ...(options.operation && { operation: options.operationSchema ?? schemaFor(options.operation) }),
      },
    }, ...(options.example !== undefined && { example: options.example }) } },
  }));
}

export function ApiProblemResponses(...codes: (keyof typeof statusByCode)[]) {
  const statuses = [...new Set(codes.map(code => statusByCode[code]))];
  return applyDecorators(...statuses.map(status => ApiResponse({
    status, description: codes.filter(code => statusByCode[code] === status).join(', '),
    headers: { 'X-Request-ID': requestIdHeader, ...(status === 429 && {
      'Retry-After': { description: 'Số giây chờ trước khi thử lại.', schema: { type: 'integer', minimum: 0 } as SchemaObject },
    }) },
    content: { 'application/problem+json': {
      schema: { $ref: '#/components/schemas/ProblemDetails' },
      examples: Object.fromEntries(codes.filter(code => statusByCode[code] === status).map(code => [code, { value: {
        type: `urn:vcraft:problem:${code}`, title: problems[status][1], status,
        detail: problems[status][2], code, tracking_id: 'c7a8b9e0-1234-4567-89ab-cdef01234567',
        ...(code === 'INVALID_INPUT' && { errors: [{ field: '/quantity', message: 'Giá trị không đúng định dạng hoặc giới hạn cho phép.' }] }),
      } }])),
    } },
  })));
}

export const ApiEmptyResponse = () => ApiResponse({ status: 204, description: 'Thành công, không có body.', headers: { 'X-Request-ID': requestIdHeader } });
export const ApiIdempotencyKey = () => ApiHeader({ name: 'X-Idempotency-Key', required: true,
  description: 'Chỉ gắn vào mutation được yêu cầu tại API mục 1.4.', schema: { type: 'string', format: 'uuid' } });
export const ApiPaginationQuery = () => applyDecorators(
  ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, default: PAGINATION.defaultPage } }),
  ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: PAGINATION.maxLimit, default: PAGINATION.defaultLimit } }),
);
export const ApiImageResponse = () => ApiResponse({
  status: 200, description: 'Byte ảnh đã xử lý, không bọc JSON.',
  headers: { 'X-Request-ID': requestIdHeader, 'X-Content-Type-Options': { schema: { type: 'string', enum: ['nosniff'] } } },
  content: Object.fromEntries(['image/jpeg', 'image/png', 'image/webp'].map(mime => [mime, { schema: { type: 'string', format: 'binary' } }])),
});
