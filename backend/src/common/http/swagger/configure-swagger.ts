import type { INestApplication } from '@nestjs/common';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import type { AppConfig } from '../../config/app-config';
import { ACCESS_POLICY, SESSION_LEVELS, type AccessPolicy, type SessionLevel } from '../../security/decorators/access-policy';
import { paginationSchema, problemSchema, requestIdHeader } from './api-schemas';

export function createApiDocument(app: INestApplication, config: Pick<AppConfig, 'NODE_ENV'>): OpenAPIObject {
  const cookieName = config.NODE_ENV === 'development' ? 'vcraft-session' : '__Host-vcraft-session';
  const document = SwaggerModule.createDocument(app, new DocumentBuilder()
    .setTitle('vCraft API').setVersion('1')
    .setDescription('Hợp đồng của controller đã đăng ký. Phiên qua cookie HttpOnly; không dùng Bearer token. Swagger không thay kiểm tra quyền phía máy chủ.')
    .addCookieAuth(cookieName, { type: 'apiKey', in: 'cookie', description: 'Cookie do server cấp khi đăng nhập; không nhập token thủ công.' }, 'session')
    .build(), { operationIdFactory: (controller, method) => `${controller}_${method}` });
  document.components ??= {};
  document.components.schemas = { ...document.components.schemas, ProblemDetails: problemSchema, Pagination: paginationSchema };
  const policies = new Map<string, { access?: AccessPolicy; levels: readonly SessionLevel[] }>();
  const reflector = new Reflector();
  const scanner = new MetadataScanner();
  for (const module of app.get(ModulesContainer).values()) {
    for (const { metatype } of module.controllers.values()) {
      if (!metatype) continue;
      for (const method of scanner.getAllMethodNames(metatype.prototype)) {
        const targets = [metatype.prototype[method], metatype];
        policies.set(`${metatype.name}_${method}`, {
          access: reflector.getAllAndOverride<AccessPolicy>(ACCESS_POLICY, targets),
          levels: reflector.getAllAndOverride<readonly SessionLevel[]>(SESSION_LEVELS, targets) ?? ['normal'],
        });
      }
    }
  }
  for (const path of Object.values(document.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const) {
      const operation = path[method];
      if (!operation) continue;
      const policy = policies.get(operation.operationId ?? '');
      if (!policy) throw new Error('Swagger operationId must use the shared controller_method convention');
      operation.security = policy?.access?.kind === 'public' ? [] : [{ session: [] }];
      Object.assign(operation, {
        'x-roles': policy?.access?.kind === 'roles' ? policy.access.roles : [],
        'x-access-policy': policy?.access?.kind ?? 'denied',
        'x-session-levels': policy?.levels ?? ['normal'],
      });
      if (['post', 'put', 'patch', 'delete'].includes(method)) {
        operation.parameters ??= [];
        if (!operation.parameters.some(param => 'name' in param && param.in === 'header' && param.name.toLowerCase() === 'x-csrf-token')) {
          operation.parameters.push({ name: 'X-CSRF-Token', in: 'header', required: true,
            description: 'Token lấy từ /api/v1/auth/csrf, đúng phiên hoặc preauth. Đây là yêu cầu hợp đồng; Swagger không triển khai CSRF guard.', schema: { type: 'string' } });
        }
      }
      for (const response of Object.values(operation.responses)) {
        if (response && !('$ref' in response)) response.headers = { 'X-Request-ID': requestIdHeader, ...response.headers };
      }
    }
  }
  return document;
}

export function configureSwagger(app: INestApplication, config: Pick<AppConfig, 'NODE_ENV'>): void {
  if (config.NODE_ENV !== 'development') return;
  SwaggerModule.setup('api/docs', app, createApiDocument(app, config), {
    jsonDocumentUrl: 'api/docs/openapi.json', raw: ['json'],
    swaggerOptions: { supportedSubmitMethods: [], persistAuthorization: false },
    customSiteTitle: 'vCraft API',
  });
}
