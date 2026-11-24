import 'reflect-metadata';
import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { ApplicationConfig } from '@nestjs/core/application-config';
import { NestFactory, Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { AppModule } from '../../src/bootstrap/app.module';
import { IDENTITY_CONTRACT } from '../../src/modules/identity/public/contracts/identity.contract';
import { IdentityService } from '../../src/modules/identity/application/services/identity.service';
import { PrismaService } from '../../src/infrastructure/database/prisma/prisma.service';
import { AuthenticationGuard } from '../../src/common/security/guards/authentication.guard';
import { RolesGuard } from '../../src/common/security/guards/roles.guard';
import { Roles } from '../../src/common/security/decorators/access-policy';
import { authenticatedActors } from '../../src/common/security/guards/authenticated-request';

describe('AppModule composition', () => {
  it('wires IdentityModule into SecurityModule and provides IdentityService as IDENTITY_CONTRACT', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:password@localhost:5432/test');
    vi.stubEnv('SESSION_SECRET', 'test_secret_change_in_production_32_chars');
    vi.stubEnv('NODE_ENV', 'development');
    const connectSpy = vi.spyOn(PrismaService.prototype, 'onModuleInit').mockResolvedValue();
    const disconnectSpy = vi.spyOn(PrismaService.prototype, 'onModuleDestroy').mockResolvedValue();

    try {
      const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
      try {
        const contract = app.get(IDENTITY_CONTRACT);
        expect(contract).toBeInstanceOf(IdentityService);
        expect(contract).toBe(app.get(IdentityService));
      } finally {
        await app.close();
      }
    } finally {
      connectSpy.mockRestore();
      disconnectSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('allows AuthenticationGuard to resolve sessions via the registered IdentityService', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:password@localhost:5432/test');
    vi.stubEnv('SESSION_SECRET', 'test_secret_change_in_production_32_chars');
    vi.stubEnv('NODE_ENV', 'development');
    const connectSpy = vi.spyOn(PrismaService.prototype, 'onModuleInit').mockResolvedValue();
    const disconnectSpy = vi.spyOn(PrismaService.prototype, 'onModuleDestroy').mockResolvedValue();

    try {
      const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
      try {
        const identityService = app.get(IdentityService);
        const authGuard = app.get(AuthenticationGuard);
        expect(authGuard).toBeDefined();

        const resolveSpy = vi.spyOn(identityService, 'resolveSession').mockResolvedValue({
          accountId: '1',
          role: 'buyer',
          workshopId: null,
          authVersion: 1,
          sessionId: 'sess-1',
          sessionLevel: 'normal',
        });

        const request = {
          cookies: { 'vcraft-session': 'test-token' },
          path: '/api/v1/buyer/profile',
          method: 'GET',
        };
        const context = {
          switchToHttp: () => ({ getRequest: () => request }),
          getHandler: () => () => {},
          getClass: () => class {},
        } as unknown as ExecutionContext;

        expect(await authGuard.canActivate(context)).toBe(true);
        expect(resolveSpy).toHaveBeenCalledWith('test-token');
      } finally {
        await app.close();
      }
    } finally {
      connectSpy.mockRestore();
      disconnectSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('passes a valid session cookie through private routes without 503 SECURITY_SERVICE_UNAVAILABLE', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:password@localhost:5432/test');
    vi.stubEnv('SESSION_SECRET', 'test_secret_change_in_production_32_chars');
    vi.stubEnv('NODE_ENV', 'development');
    const connectSpy = vi.spyOn(PrismaService.prototype, 'onModuleInit').mockResolvedValue();
    const disconnectSpy = vi.spyOn(PrismaService.prototype, 'onModuleDestroy').mockResolvedValue();

    @Roles('artisan')
    class PrivateArtisanController {
      @Get('dashboard')
      dashboard() {
        return { data: 'artisan-dashboard' };
      }
    }

    try {
      const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
      try {
        const identityService = app.get(IdentityService);
        const guards = app.get(ApplicationConfig).getGlobalGuards();
        const authGuard = guards.find(g => g instanceof AuthenticationGuard) as AuthenticationGuard;
        const rolesGuard = guards.find(g => g instanceof RolesGuard) as RolesGuard;

        expect(authGuard).toBeDefined();
        expect(rolesGuard).toBeDefined();

        const validActor = {
          accountId: '42',
          role: 'artisan' as const,
          workshopId: '10',
          authVersion: 1,
          sessionId: 'sess-valid',
          sessionLevel: 'normal' as const,
        };
        const resolveSpy = vi.spyOn(identityService, 'resolveSession').mockResolvedValue(validActor);

        const request = {
          cookies: { 'vcraft-session': 'valid-session-token' },
          path: '/api/v1/artisan/dashboard',
          method: 'GET',
        } as unknown as Request;

        const context = {
          switchToHttp: () => ({ getRequest: () => request }),
          getHandler: () => PrivateArtisanController.prototype.dashboard,
          getClass: () => PrivateArtisanController,
        } as unknown as ExecutionContext;

        const authPassed = await authGuard.canActivate(context);
        expect(authPassed).toBe(true);
        expect(resolveSpy).toHaveBeenCalledWith('valid-session-token');

        const rolesPassed = await rolesGuard.canActivate(context);
        expect(rolesPassed).toBe(true);

        expect(authenticatedActors.get(request)).toEqual(validActor);
      } finally {
        await app.close();
      }
    } finally {
      connectSpy.mockRestore();
      disconnectSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('confirms 503 occurred before wiring IdentityModule when identity provider was missing', async () => {
    const emptySecurity = new AuthenticationGuard(new Reflector(), { NODE_ENV: 'development' });
    const request = {
      cookies: { 'vcraft-session': 'valid-session-token' },
      path: '/api/v1/artisan/dashboard',
      method: 'GET',
    } as unknown as Request;
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => () => {},
      getClass: () => class {},
    } as unknown as ExecutionContext;

    await expect(emptySecurity.canActivate(context)).rejects.toMatchObject({
      code: 'SECURITY_SERVICE_UNAVAILABLE',
    });
  });
});
