import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { AuthController } from '../../../src/modules/identity/adapters/http/controllers/auth.controller';
import { IdentityService } from '../../../src/modules/identity/application/services/identity.service';
import type { AuthenticatedActor } from '../../../src/common/application/types/contract-types';
import { BusinessRuleException } from '../../../src/common/domain/errors/business-rule.exception';

function createMockResponse() {
  const cookies: Record<string, { val: string; options: any }> = {};
  const clearedCookies: Record<string, any> = {};

  const res = {
    cookie: vi.fn((name: string, val: string, options: any) => {
      cookies[name] = { val, options };
      return res;
    }),
    clearCookie: vi.fn((name: string, options: any) => {
      clearedCookies[name] = options;
      return res;
    }),
  } as unknown as Response;

  return { res, cookies, clearedCookies };
}

describe('AuthController', () => {
  let controller: AuthController;
  let identityService: Partial<IdentityService>;

  beforeEach(() => {
    identityService = {
      resolveSession: vi.fn(),
      registerBuyer: vi.fn(),
      login: vi.fn(),
      getMe: vi.fn(),
      logout: vi.fn(),
      changePassword: vi.fn(),
      changeTempPassword: vi.fn(),
    };
    controller = new AuthController(
      identityService as IdentityService,
      { NODE_ENV: 'development' },
    );
  });

  describe('GET /auth/csrf', () => {
    it('returns existing session csrf token and session_level when session is valid', async () => {
      const mockActor: AuthenticatedActor = {
        accountId: '1',
        role: 'buyer',
        workshopId: null,
        authVersion: 1,
        sessionId: 's-1',
        sessionLevel: 'normal',
      };
      (identityService.resolveSession as any).mockResolvedValueOnce(mockActor);

      const req = {
        cookies: { 'vcraft-session': 'valid-session' },
      } as unknown as Request;
      const { res } = createMockResponse();

      const result = await controller.getCsrf(req, res);
      expect(result.session_level).toBe('normal');
      expect(typeof result.csrf_token).toBe('string');
      expect(result.csrf_token.length).toBe(64);
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('creates preauth cookie and returns preauth session_level for guest', async () => {
      const req = { cookies: {} } as unknown as Request;
      const { res } = createMockResponse();

      const result = await controller.getCsrf(req, res);
      expect(result.session_level).toBe('preauth');
      expect(typeof result.csrf_token).toBe('string');
      expect(res.cookie).toHaveBeenCalledWith(
        'vcraft-preauth',
        result.csrf_token,
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
        }),
      );
    });

    it('reuses existing preauth cookie for guest', async () => {
      const req = {
        cookies: { 'vcraft-preauth': 'existing-preauth-token' },
      } as unknown as Request;
      const { res } = createMockResponse();

      const result = await controller.getCsrf(req, res);
      expect(result.session_level).toBe('preauth');
      expect(result.csrf_token).toBe('existing-preauth-token');
      expect(res.cookie).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/register-buyer', () => {
    it('delegates to identityService.registerBuyer and returns created buyer', async () => {
      const dto = {
        username: 'buyer_test',
        password: 'Password123456!',
        password_confirmation: 'Password123456!',
        display_name: 'Test Buyer',
        phone: '0912345678',
      };
      const expected = {
        id: '101',
        username: 'buyer_test',
        display_name: 'Test Buyer',
        role: 'buyer' as const,
        created_at: new Date().toISOString(),
      };
      (identityService.registerBuyer as any).mockResolvedValueOnce(expected);

      const result = await controller.registerBuyer(dto);
      expect(result).toEqual(expected);
      expect(identityService.registerBuyer).toHaveBeenCalledWith(dto);
    });
  });

  describe('POST /auth/login', () => {
    it('logs in user, sets session cookie and clears preauth cookie', async () => {
      const dto = { username: 'buyer_test', password: 'Password123456!' };
      const loginResult = {
        user: {
          id: '101',
          username: 'buyer_test',
          role: 'buyer' as const,
          workshop_id: null,
          session_level: 'normal' as const,
        },
        sessionToken: 'test-session-token',
      };
      (identityService.login as any).mockResolvedValueOnce(loginResult);

      const { res } = createMockResponse();
      const result = await controller.login(dto, res);

      expect(result.user).toEqual(loginResult.user);
      expect(typeof result.csrf_token).toBe('string');
      expect(res.cookie).toHaveBeenCalledWith(
        'vcraft-session',
        'test-session-token',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: 12 * 60 * 60 * 1000,
        }),
      );
      expect(res.clearCookie).toHaveBeenCalledWith(
        'vcraft-preauth',
        expect.objectContaining({ path: '/' }),
      );
    });

    it('sets shorter maxAge cookie when session_level is temp_password', async () => {
      const dto = { username: 'artisan_temp', password: 'TempPassword123!' };
      const loginResult = {
        user: {
          id: '201',
          username: 'artisan_temp',
          role: 'artisan' as const,
          workshop_id: '301',
          session_level: 'temp_password' as const,
        },
        sessionToken: 'temp-session-token',
      };
      (identityService.login as any).mockResolvedValueOnce(loginResult);

      const { res } = createMockResponse();
      const result = await controller.login(dto, res);

      expect(result.user.session_level).toBe('temp_password');
      expect(res.cookie).toHaveBeenCalledWith(
        'vcraft-session',
        'temp-session-token',
        expect.objectContaining({
          maxAge: 15 * 60 * 1000,
        }),
      );
    });
  });

  describe('GET /auth/me', () => {
    it('returns actor profile from identityService', async () => {
      const actor: AuthenticatedActor = {
        accountId: '101',
        role: 'buyer',
        workshopId: null,
        authVersion: 1,
        sessionId: 's-1',
        sessionLevel: 'normal',
      };
      const meData = {
        id: '101',
        username: 'buyer_test',
        display_name: 'Test Buyer',
        role: 'buyer' as const,
        workshop_id: null,
        session_level: 'normal' as const,
      };
      (identityService.getMe as any).mockResolvedValueOnce(meData);

      const result = await controller.getMe(actor);
      expect(result).toEqual(meData);
      expect(identityService.getMe).toHaveBeenCalledWith(actor);
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes session and clears cookie', async () => {
      const req = {
        cookies: { 'vcraft-session': 'active-token' },
      } as unknown as Request;
      const { res } = createMockResponse();

      const result = await controller.logout(req, res);
      expect(result).toEqual({ logged_out: true });
      expect(identityService.logout).toHaveBeenCalledWith('active-token');
      expect(res.clearCookie).toHaveBeenCalledWith(
        'vcraft-session',
        expect.objectContaining({ path: '/' }),
      );
    });
  });

  describe('POST /auth/change-password', () => {
    it('changes password and clears session cookie', async () => {
      const actor: AuthenticatedActor = {
        accountId: '101',
        role: 'buyer',
        workshopId: null,
        authVersion: 1,
        sessionId: 's-1',
        sessionLevel: 'normal',
      };
      const dto = {
        current_password: 'OldPassword123!',
        new_password: 'NewPassword123!',
        new_password_confirmation: 'NewPassword123!',
      };
      const { res } = createMockResponse();

      const result = await controller.changePassword(actor, dto, res);
      expect(result).toEqual({ reauthentication_required: true });
      expect(identityService.changePassword).toHaveBeenCalledWith(actor, dto);
      expect(res.clearCookie).toHaveBeenCalledWith('vcraft-session', expect.anything());
    });
  });

  describe('POST /auth/change-temp-password', () => {
    it('changes temp password and clears session cookie', async () => {
      const actor: AuthenticatedActor = {
        accountId: '201',
        role: 'artisan',
        workshopId: '301',
        authVersion: 1,
        sessionId: 's-temp',
        sessionLevel: 'temp_password',
      };
      const dto = {
        current_temp_password: 'TempPassword123!',
        new_password: 'NewPassword123!',
        new_password_confirmation: 'NewPassword123!',
      };
      const { res } = createMockResponse();

      const result = await controller.changeTempPassword(actor, dto, res);
      expect(result).toEqual({ reauthentication_required: true });
      expect(identityService.changeTempPassword).toHaveBeenCalledWith(actor, dto);
      expect(res.clearCookie).toHaveBeenCalledWith('vcraft-session', expect.anything());
    });
  });
});
