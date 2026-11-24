import { describe, expect, it, vi } from 'vitest';
import { toPrismaOffset, PAGINATION } from '../../src/common/application/types/pagination';
import {
  NumericIdSchema,
  PaginationQuerySchema,
  MoneySchema,
  VnPhoneSchema,
  SafeTextSchema,
} from '../../src/common/validators/common-schemas';
import { findOrThrow, toBigIntId } from '../../src/common/application/helpers/find-or-throw';
import { assertOwnerOrAdmin } from '../../src/common/security/ownership';
import { logSecurityAudit } from '../../src/common/security/audit-logger';
import {
  getSessionCookieName,
  getPreauthCookieName,
  setSessionCookie,
  clearSessionCookie,
} from '../../src/common/http/helpers/cookie.helper';
import { BusinessRuleException } from '../../src/common/domain/errors/business-rule.exception';

describe('Common Helpers & Patterns', () => {
  describe('toPrismaOffset', () => {
    it('calculates skip and take correctly for standard inputs', () => {
      const result = toPrismaOffset({ page: 2, limit: 10 });
      expect(result).toEqual({ skip: 10, take: 10 });
    });

    it('falls back to default limit and page when invalid or zero', () => {
      const result = toPrismaOffset({ page: 0, limit: 0 });
      expect(result).toEqual({ skip: 0, take: PAGINATION.defaultLimit });
    });

    it('caps limit at maxLimit', () => {
      const result = toPrismaOffset({ page: 1, limit: 500 });
      expect(result).toEqual({ skip: 0, take: PAGINATION.maxLimit });
    });
  });

  describe('common-schemas', () => {
    it('validates NumericIdSchema correctly', () => {
      expect(NumericIdSchema.safeParse('123').success).toBe(true);
      expect(NumericIdSchema.safeParse('0').success).toBe(false);
      expect(NumericIdSchema.safeParse('-5').success).toBe(false);
      expect(NumericIdSchema.safeParse('abc').success).toBe(false);
      expect(NumericIdSchema.safeParse(' 456 ').success).toBe(true);
    });

    it('validates and applies defaults in PaginationQuerySchema', () => {
      const parsed = PaginationQuerySchema.parse({});
      expect(parsed).toEqual({ page: 1, limit: 20 });

      const custom = PaginationQuerySchema.parse({ page: '3', limit: '50' });
      expect(custom).toEqual({ page: 3, limit: 50 });
    });

    it('validates MoneySchema', () => {
      expect(MoneySchema.safeParse(0).success).toBe(true);
      expect(MoneySchema.safeParse(150000).success).toBe(true);
      expect(MoneySchema.safeParse(-100).success).toBe(false);
    });

    it('validates VnPhoneSchema', () => {
      expect(VnPhoneSchema.safeParse('0912345678').success).toBe(true);
      expect(VnPhoneSchema.safeParse('01234567890').success).toBe(true);
      expect(VnPhoneSchema.safeParse('1234567890').success).toBe(false);
      expect(VnPhoneSchema.safeParse('09123').success).toBe(false);
    });

    it('validates SafeTextSchema', () => {
      const schema = SafeTextSchema(2, 10);
      expect(schema.safeParse('ab').success).toBe(true);
      expect(schema.safeParse('a').success).toBe(false);
      expect(schema.safeParse('abcdefghijk').success).toBe(false);
    });
  });

  describe('findOrThrow & toBigIntId', () => {
    it('returns record when finder returns data', async () => {
      const record = await findOrThrow(async () => ({ id: '1', name: 'Gốm Bát Tràng' }));
      expect(record).toEqual({ id: '1', name: 'Gốm Bát Tràng' });
    });

    it('throws RESOURCE_NOT_FOUND when record is null', async () => {
      await expect(findOrThrow(async () => null)).rejects.toThrow(BusinessRuleException);
    });

    it('throws custom error code when provided', async () => {
      await expect(
        findOrThrow(async () => null, 'WORKSHOP_SUSPENDED'),
      ).rejects.toThrow(BusinessRuleException);
    });

    it('converts valid string to BigInt', () => {
      expect(toBigIntId('12345')).toBe(12345n);
      expect(toBigIntId(999n)).toBe(999n);
    });

    it('throws INVALID_INPUT for non-numeric or invalid string id', () => {
      expect(() => toBigIntId('0')).toThrow(BusinessRuleException);
      expect(() => toBigIntId('abc')).toThrow(BusinessRuleException);
      expect(() => toBigIntId('-12')).toThrow(BusinessRuleException);
    });
  });

  describe('assertOwnerOrAdmin', () => {
    const adminActor = {
      accountId: '1',
      role: 'admin' as const,
      workshopId: null,
      authVersion: 1,
      sessionId: 'sess_1',
      sessionLevel: 'normal' as const,
    };

    const artisanActor = {
      accountId: '2',
      role: 'artisan' as const,
      workshopId: '10',
      authVersion: 1,
      sessionId: 'sess_2',
      sessionLevel: 'normal' as const,
    };

    it('allows admin regardless of ownerAccountId', () => {
      expect(() => assertOwnerOrAdmin(adminActor, '999')).not.toThrow();
    });

    it('allows owner when accountId matches', () => {
      expect(() => assertOwnerOrAdmin(artisanActor, '2')).not.toThrow();
      expect(() => assertOwnerOrAdmin(artisanActor, 2n)).not.toThrow();
    });

    it('throws PERMISSION_DENIED when not owner and not admin', () => {
      expect(() => assertOwnerOrAdmin(artisanActor, '3')).toThrow(BusinessRuleException);
    });
  });

  describe('logSecurityAudit', () => {
    it('calls client.securityAuditLog.create with mapped fields', async () => {
      const createMock = vi.fn().mockResolvedValue({ id: 1n });
      const client = { securityAuditLog: { create: createMock } };

      await logSecurityAudit(client, {
        actorId: '1',
        targetAccountId: '2',
        eventType: 'test_event',
        authVersionBefore: 1,
        authVersionAfter: 2,
        reason: 'testing audit log',
      });

      expect(createMock).toHaveBeenCalledWith({
        data: {
          actor_id: 1n,
          target_account_id: 2n,
          event_type: 'test_event',
          auth_version_before: 1,
          auth_version_after: 2,
          reason: 'testing audit log',
          verification_evidence: null,
          ip_address: null,
        },
      });
    });
  });

  describe('cookie.helper', () => {
    it('returns development cookie names when NODE_ENV is development', () => {
      expect(getSessionCookieName('development')).toBe('vcraft-session');
      expect(getPreauthCookieName('development')).toBe('vcraft-preauth');
    });

    it('returns host-prefixed cookie names when NODE_ENV is production', () => {
      expect(getSessionCookieName('production')).toBe('__Host-vcraft-session');
      expect(getPreauthCookieName('production')).toBe('__Host-vcraft-preauth');
    });

    it('sets session cookie with correct params', () => {
      const cookieMock = vi.fn();
      const res = { cookie: cookieMock } as any;

      setSessionCookie(res, 'token123', 'normal', 'development');
      expect(cookieMock).toHaveBeenCalledWith('vcraft-session', 'token123', {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: false,
        maxAge: 12 * 60 * 60 * 1000,
      });
    });

    it('clears session cookie', () => {
      const clearCookieMock = vi.fn();
      const res = { clearCookie: clearCookieMock } as any;

      clearSessionCookie(res, 'development');
      expect(clearCookieMock).toHaveBeenCalledWith('vcraft-session', {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
      });
    });
  });
});
