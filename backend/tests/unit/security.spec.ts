import 'reflect-metadata';
import { Module, type ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { NestFactory, Reflector } from '@nestjs/core';
import { ApplicationConfig } from '@nestjs/core/application-config';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { AuthenticationGuard } from '../../src/common/security/guards/authentication.guard';
import { RolesGuard } from '../../src/common/security/guards/roles.guard';
import { authenticatedActors, type AuthenticatedActor } from '../../src/common/security/guards/authenticated-request';
import { Public, Roles, SessionLevels } from '../../src/common/security/decorators/access-policy';
import { CurrentActor } from '../../src/common/security/decorators/current-actor.decorator';
import { ApiProblem } from '../../src/common/http/filters/api-problem';
import { ServiceUnavailableException } from '../../src/common/application/errors/service-unavailable.exception';
import { MockIdentityContract } from '../support/mocks/identity.mock';
import { SecurityModule } from '../../src/common/security/security.module';
import { IDENTITY_CONTRACT } from '../../src/modules/identity/public/contracts/identity.contract';

@Roles('artisan')
class Routes {
  normal() {}
  @Public() public() {}
  @Roles('admin') admin() {}
  @Roles('buyer', 'artisan', 'admin') @SessionLevels('normal', 'temp_password') logout() {}
  @Roles('buyer', 'artisan', 'admin') @SessionLevels('temp_password') changeTemp() {}
  current(@CurrentActor() _actor: AuthenticatedActor) {}
}
class Undeclared { route() {} }
@Public()
class PublicRoutes { @Roles('admin') protected() {} }

const actor: AuthenticatedActor = {
  accountId: '1', role: 'artisan', workshopId: '2', authVersion: 1,
  sessionId: '3', sessionLevel: 'normal',
};

function fixture(method = 'normal', requestOptions: Partial<Request> = {}, controller: { prototype: object } = Routes) {
  const request = { cookies: { 'vcraft-session': 'opaque-token' }, method: 'GET', path: '/api/v1/artisan/products',
    ...requestOptions } as Request;
  const context = {
    getHandler: () => (controller.prototype as unknown as Record<string, Function>)[method],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
  const identity = new MockIdentityContract();
  identity.resolveSession.mockResolvedValue(actor);
  const auth = new AuthenticationGuard(new Reflector(), { NODE_ENV: 'development' }, identity);
  const roles = new RolesGuard(new Reflector());
  return { context, request, identity, auth, roles };
}

describe('authentication and role guards', () => {
  it('registers global guards in authentication-first order and resolves the imported Identity provider', async () => {
    const identity = new MockIdentityContract();
    identity.resolveSession.mockResolvedValue(actor);
    @Module({ providers: [{ provide: IDENTITY_CONTRACT, useValue: identity }], exports: [IDENTITY_CONTRACT] })
    class IdentityFixtureModule {}
    @Module({ imports: [SecurityModule.register([IdentityFixtureModule])] })
    class SecurityFixtureModule {}
    vi.stubEnv('DATABASE_URL', 'postgresql://user:password@localhost:5432/test');
    vi.stubEnv('SESSION_SECRET', 'test_secret_change_in_production_32_chars');
    vi.stubEnv('NODE_ENV', 'development');
    try {
      const app = await NestFactory.createApplicationContext(SecurityFixtureModule, { logger: false, abortOnError: false });
      try {
        const guards = app.get(ApplicationConfig).getGlobalGuards();
        expect(guards.map(guard => guard.constructor)).toEqual([AuthenticationGuard, RolesGuard]);
        const f = fixture();
        expect(await guards[0].canActivate(f.context)).toBe(true);
        expect(guards[1].canActivate(f.context)).toBe(true);
        expect(identity.resolveSession).toHaveBeenCalledWith('opaque-token');
      } finally { await app.close(); }
    } finally { vi.unstubAllEnvs(); }
  });

  it('resolves only the session cookie and attaches an immutable trusted actor', async () => {
    const f = fixture('normal', { body: { role: 'admin', accountId: '999' } });
    expect(await f.auth.canActivate(f.context)).toBe(true);
    expect(f.identity.resolveSession).toHaveBeenCalledWith('opaque-token');
    expect(authenticatedActors.get(f.request)).toEqual(actor);
    expect(Object.isFrozen(authenticatedActors.get(f.request))).toBe(true);
    expect(f.roles.canActivate(f.context)).toBe(true);
    f.identity.resolveSession.mockResolvedValue(null);
    await expect(f.auth.canActivate(f.context)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(authenticatedActors.has(f.request)).toBe(false);
  });

  it('distinguishes missing, invalid and expired sessions from insufficient permissions', async () => {
    for (const token of [undefined, '', {}, 123]) {
      const f = fixture('normal', { cookies: { 'vcraft-session': token }, headers: { authorization: 'Bearer forged' } });
      await expect(f.auth.canActivate(f.context)).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
      expect(f.identity.resolveSession).not.toHaveBeenCalled();
    }
    const f = fixture('admin');
    await f.auth.canActivate(f.context);
    expect(() => f.roles.canActivate(f.context)).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    f.identity.resolveSession.mockRejectedValue(new ApiProblem('SESSION_EXPIRED'));
    await expect(f.auth.canActivate(f.context)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it('only uses the secure cookie outside development', async () => {
    const f = fixture();
    const guard = new AuthenticationGuard(new Reflector(), { NODE_ENV: 'production' }, f.identity);
    await expect(guard.canActivate(f.context)).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    f.request.cookies['__Host-vcraft-session'] = 'secure-token';
    await guard.canActivate(f.context);
    expect(f.identity.resolveSession).toHaveBeenCalledWith('secure-token');
  });

  it('lets explicit public routes through without touching the session store', async () => {
    const f = fixture('public', { cookies: {} });
    expect(await f.auth.canActivate(f.context)).toBe(true);
    expect(f.roles.canActivate(f.context)).toBe(true);
    expect(f.identity.resolveSession).not.toHaveBeenCalled();
    const protectedRoute = fixture('protected', { cookies: {} }, PublicRoutes);
    await expect(protectedRoute.auth.canActivate(protectedRoute.context)).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });

  it('denies undeclared access and never grants Admin an implicit bypass', async () => {
    const f = fixture('route', {}, Undeclared);
    f.identity.resolveSession.mockResolvedValue({ ...actor, role: 'admin' });
    await f.auth.canActivate(f.context);
    expect(() => f.roles.canActivate(f.context)).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    const artisanRoute = fixture();
    artisanRoute.identity.resolveSession.mockResolvedValue({ ...actor, role: 'admin' });
    await artisanRoute.auth.canActivate(artisanRoute.context);
    expect(() => artisanRoute.roles.canActivate(artisanRoute.context)).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
  });

  it('fails closed when Identity is unavailable and propagates store errors', async () => {
    const f = fixture();
    await expect(new AuthenticationGuard(new Reflector(), { NODE_ENV: 'development' }).canActivate(f.context))
      .rejects.toMatchObject({ code: 'SECURITY_SERVICE_UNAVAILABLE' });
    f.identity.resolveSession.mockRejectedValue(new ServiceUnavailableException('SECURITY_SERVICE_UNAVAILABLE'));
    await expect(f.auth.canActivate(f.context)).rejects.toMatchObject({ code: 'SECURITY_SERVICE_UNAVAILABLE' });
    f.identity.resolveSession.mockRejectedValue(new Error('private-database-error'));
    await expect(f.auth.canActivate(f.context)).rejects.toThrow('private-database-error');
    expect(authenticatedActors.has(f.request)).toBe(false);
  });

  it('restricts temporary sessions to explicitly permitted auth operations', async () => {
    for (const path of ['/api/v1/auth/me', '/api/v1/artisan/products']) {
      const f = fixture('logout', { path });
      f.identity.resolveSession.mockResolvedValue({ ...actor, sessionLevel: 'temp_password' });
      await expect(f.auth.canActivate(f.context)).rejects.toMatchObject({ code: 'TEMP_PASSWORD_RESTRICTED' });
    }
    const f = fixture('logout', { method: 'POST', path: '/api/v1/auth/logout/' });
    f.identity.resolveSession.mockResolvedValue({ ...actor, sessionLevel: 'temp_password' });
    expect(await f.auth.canActivate(f.context)).toBe(true);
    expect(f.roles.canActivate(f.context)).toBe(true);
    const change = fixture('changeTemp', { method: 'POST', path: '/api/v1/auth/change-temp-password' });
    await expect(change.auth.canActivate(change.context)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('CurrentActor returns only guard-produced context and rejects forged request.user', async () => {
    const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, Routes, 'current');
    const decorator = Object.values(metadata)[0] as { factory: (data: unknown, context: ExecutionContext) => unknown };
    const f = fixture();
    Object.assign(f.request, { user: { role: 'admin' } });
    expect(() => decorator.factory(undefined, f.context)).toThrow(expect.objectContaining({ code: 'AUTHENTICATION_REQUIRED' }));
    await f.auth.canActivate(f.context);
    expect(decorator.factory(undefined, f.context)).toEqual(actor);
  });
});
