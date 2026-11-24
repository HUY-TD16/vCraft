import { describe, expect, it, vi } from 'vitest';
import { IdentityService } from '../../../src/modules/identity/application/services/identity.service';
import { PrismaIdentityRepository } from '../../../src/modules/identity/adapters/persistence/repositories/prisma-identity.repository';
import type { ISessionManager } from '../../../src/modules/identity/application/ports/session-manager.port';
import type { IPasswordHasher } from '../../../src/modules/identity/application/ports/password-hasher.port';
import type { PrismaTransactionRunner } from '../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import type { PrismaService } from '../../../src/infrastructure/database/prisma/prisma.service';
import type { TransactionContext } from '../../../src/common/application/ports/transaction-runner';
import type { AuthenticatedActor, TrustedActor } from '../../../src/common/application/types/contract-types';
import { BusinessRuleException } from '../../../src/common/domain/errors/business-rule.exception';

function createMocks() {
  const sessionManager: ISessionManager = {
    createSession: vi.fn(),
    resolveSession: vi.fn(),
    revokeSession: vi.fn(),
    revokeAllForAccount: vi.fn(),
  };

  const passwordHasher: IPasswordHasher = {
    hash: vi.fn().mockImplementation(async pwd => `hashed-${pwd}`),
    verify: vi.fn().mockImplementation(async (hash, plain) => hash === `hashed-${plain}`),
  };

  const accountsDb = new Map<bigint, any>();

  const client = {
    $queryRaw: vi.fn().mockImplementation(async (_strings: any, id: bigint) => {
      const row = accountsDb.get(id);
      return row ? [row] : [];
    }),
    account: {
      findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id?: bigint; username?: string } }) => {
        if (where.id) return accountsDb.get(where.id) ?? null;
        return null;
      }),
      create: vi.fn(),
      update: vi.fn(),
    },
    workshop: {
      create: vi.fn(),
    },
    session: {
      findUnique: vi.fn(),
    },
    securityAuditLog: {
      create: vi.fn(),
    },
  };

  const fakeTx = {} as TransactionContext;

  const runner = {
    getClient: vi.fn().mockReturnValue(client),
    run: vi.fn().mockImplementation(async work => work(fakeTx)),
  } as unknown as PrismaTransactionRunner;

  const prisma = client as unknown as PrismaService;
  const repo = new PrismaIdentityRepository(runner, prisma);

  const service = new IdentityService(sessionManager, runner, passwordHasher, repo);

  return { sessionManager, passwordHasher, runner, client, prisma, repo, service, fakeTx, accountsDb };
}

describe('IdentityService', () => {
  describe('resolveSession', () => {
    it('delegates to sessionManager and returns AuthenticatedActor when valid', async () => {
      const { service, sessionManager } = createMocks();
      const mockActor: AuthenticatedActor = {
        accountId: '1',
        role: 'buyer',
        workshopId: null,
        authVersion: 1,
        sessionId: 'sess-1',
        sessionLevel: 'normal',
      };
      (sessionManager.resolveSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockActor);

      const result = await service.resolveSession('valid-token');
      expect(result).toEqual(mockActor);
      expect(sessionManager.resolveSession).toHaveBeenCalledWith('valid-token');
    });

    it('returns null when sessionManager returns null', async () => {
      const { service, sessionManager } = createMocks();
      (sessionManager.resolveSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.resolveSession('expired-token');
      expect(result).toBeNull();
    });
  });

  describe('lockAndAssertAdmin', () => {
    const adminActor: TrustedActor = {
      accountId: '99',
      role: 'admin',
      workshopId: null,
      authVersion: 2,
      sessionId: 'sess-admin',
    };

    it('throws AUTHENTICATION_REQUIRED when actor is missing', async () => {
      const { service, fakeTx } = createMocks();
      await expect(service.lockAndAssertAdmin(null as unknown as TrustedActor, fakeTx))
        .rejects.toThrow(BusinessRuleException);
      await expect(service.lockAndAssertAdmin(null as unknown as TrustedActor, fakeTx))
        .rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    });

    it('throws PERMISSION_DENIED when actor role is not admin', async () => {
      const { service, fakeTx } = createMocks();
      const nonAdmin: TrustedActor = { ...adminActor, role: 'artisan' };
      await expect(service.lockAndAssertAdmin(nonAdmin, fakeTx))
        .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });

    it('locks account record with FOR UPDATE and verifies auth_version and session', async () => {
      const { service, client, fakeTx } = createMocks();
      client.$queryRaw.mockResolvedValueOnce([
        { id: 99n, role: 'admin', auth_version: 2, is_login_locked: false },
      ]);
      client.session.findUnique.mockResolvedValueOnce({
        id: 'sess-admin',
        is_revoked: false,
        auth_version: 2,
      });

      await expect(service.lockAndAssertAdmin(adminActor, fakeTx)).resolves.toBeUndefined();
      expect(client.$queryRaw).toHaveBeenCalled();
      expect(client.session.findUnique).toHaveBeenCalledWith({ where: { id: 'sess-admin' } });
    });

    it('throws SESSION_EXPIRED when locked account has mismatched auth_version', async () => {
      const { service, client, fakeTx } = createMocks();
      client.$queryRaw.mockResolvedValueOnce([
        { id: 99n, role: 'admin', auth_version: 3, is_login_locked: false },
      ]);

      await expect(service.lockAndAssertAdmin(adminActor, fakeTx))
        .rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    });

    it('throws SESSION_EXPIRED when session is revoked', async () => {
      const { service, client, fakeTx } = createMocks();
      client.$queryRaw.mockResolvedValueOnce([
        { id: 99n, role: 'admin', auth_version: 2, is_login_locked: false },
      ]);
      client.session.findUnique.mockResolvedValueOnce({
        id: 'sess-admin',
        is_revoked: true,
        auth_version: 2,
      });

      await expect(service.lockAndAssertAdmin(adminActor, fakeTx))
        .rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    });
  });

  describe('createArtisan (contract method)', () => {
    const adminActor: TrustedActor = {
      accountId: '99',
      role: 'admin',
      workshopId: null,
      authVersion: 1,
      sessionId: 'sess-admin',
    };

    const input = {
      username: 'GomBatTrang ',
      passwordHash: 'hashed-secret',
      tempPasswordExpiresAt: '2026-11-21T10:00:00.000Z',
      actor: adminActor,
    };

    it('throws PERMISSION_DENIED when actor is not admin', async () => {
      const { service, fakeTx } = createMocks();
      const buyerActor: TrustedActor = { ...adminActor, role: 'buyer' };
      await expect(service.createArtisan({ ...input, actor: buyerActor }, fakeTx))
        .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });

    it('throws USERNAME_TAKEN when username already exists in database', async () => {
      const { service, client, fakeTx } = createMocks();
      client.account.findUnique.mockResolvedValueOnce({ id: 10n, username: 'gombattrang' });

      await expect(service.createArtisan(input, fakeTx))
        .rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
      expect(client.account.create).not.toHaveBeenCalled();
    });

    it('creates artisan account and records SecurityAuditLog in the same transaction', async () => {
      const { service, client, fakeTx } = createMocks();
      client.account.findUnique.mockResolvedValueOnce(null);
      client.account.create.mockResolvedValueOnce({
        id: 50n,
        username: 'gombattrang',
        auth_version: 1,
      });
      client.securityAuditLog.create.mockResolvedValueOnce({ id: 1n });

      const result = await service.createArtisan(input, fakeTx);

      expect(result).toEqual({ accountId: '50', username: 'gombattrang' });
      expect(client.account.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          username: 'gombattrang',
          password_hash: 'hashed-secret',
          role: 'artisan',
          auth_version: 1,
          is_login_locked: false,
        }),
      });

      expect(client.securityAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor_id: 99n,
          target_account_id: 50n,
          event_type: 'artisan_account_created',
          auth_version_before: null,
          auth_version_after: 1,
        }),
      });
    });

    it('handles unique constraint race condition error P2002 by throwing USERNAME_TAKEN', async () => {
      const { service, client, fakeTx } = createMocks();
      client.account.findUnique.mockResolvedValueOnce(null);
      client.account.create.mockRejectedValueOnce({ code: 'P2002' });

      await expect(service.createArtisan(input, fakeTx))
        .rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
    });
  });

  describe('registerBuyer', () => {
    it('creates a new buyer account and returns its representation', async () => {
      const { service, client } = createMocks();
      client.account.findUnique.mockResolvedValueOnce(null);
      const now = new Date();
      client.account.create.mockResolvedValueOnce({
        id: 1001n,
        username: 'buyer_an_nam',
        display_name: 'An Nam Corp',
        role: 'buyer',
        created_at: now,
      });

      const result = await service.registerBuyer({
        username: 'Buyer_An_Nam ',
        password: 'Password123456!',
        password_confirmation: 'Password123456!',
        display_name: ' An Nam Corp ',
        phone: '0912345678',
      });

      expect(result).toEqual({
        id: '1001',
        username: 'buyer_an_nam',
        display_name: 'An Nam Corp',
        role: 'buyer',
        created_at: now.toISOString(),
      });
      expect(client.account.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          username: 'buyer_an_nam',
          display_name: 'An Nam Corp',
          phone: '0912345678',
          role: 'buyer',
          auth_version: 1,
        }),
      });
    });

    it('throws INVALID_INPUT when password and password_confirmation do not match', async () => {
      const { service } = createMocks();
      await expect(
        service.registerBuyer({
          username: 'buyer_test',
          password: 'Password123456!',
          password_confirmation: 'DifferentPassword123!',
          display_name: 'Test',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('throws USERNAME_TAKEN when username already exists', async () => {
      const { service, client } = createMocks();
      client.account.findUnique.mockResolvedValueOnce({ id: 1n, username: 'existing_buyer' });

      await expect(
        service.registerBuyer({
          username: 'existing_buyer',
          password: 'Password123456!',
          password_confirmation: 'Password123456!',
          display_name: 'Test',
        }),
      ).rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
    });
  });

  describe('login', () => {
    it('returns normal session when credentials match and no temp password exists', async () => {
      const { service, client, sessionManager } = createMocks();
      client.account.findUnique.mockResolvedValueOnce({
        id: 2001n,
        username: 'buyer_test',
        password_hash: 'hashed-CorrectPassword123!',
        role: 'buyer',
        auth_version: 1,
        is_login_locked: false,
        temp_password_expires_at: null,
        workshop: null,
      });
      (sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        token: 'sess-token-123',
        session: { id: 's-1', level: 'normal' },
      });

      const result = await service.login({
        username: 'buyer_test',
        password: 'CorrectPassword123!',
      });

      expect(result.user).toEqual({
        id: '2001',
        username: 'buyer_test',
        role: 'buyer',
        workshop_id: null,
        session_level: 'normal',
      });
      expect(result.sessionToken).toBe('sess-token-123');
      expect(sessionManager.createSession).toHaveBeenCalledWith({
        accountId: '2001',
        authVersion: 1,
        level: 'normal',
      });
    });

    it('returns temp_password session when temp_password_expires_at is active', async () => {
      const { service, client, sessionManager } = createMocks();
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      client.account.findUnique.mockResolvedValueOnce({
        id: 3001n,
        username: 'artisan_temp',
        password_hash: 'hashed-TempPassword123!',
        role: 'artisan',
        auth_version: 1,
        is_login_locked: false,
        temp_password_expires_at: future,
        workshop: { id: 501n },
      });
      (sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        token: 'temp-token-456',
        session: { id: 's-2', level: 'temp_password' },
      });

      const result = await service.login({
        username: 'artisan_temp',
        password: 'TempPassword123!',
      });

      expect(result.user.session_level).toBe('temp_password');
      expect(result.user.workshop_id).toBe('501');
      expect(sessionManager.createSession).toHaveBeenCalledWith({
        accountId: '3001',
        authVersion: 1,
        level: 'temp_password',
      });
    });

    it('throws INVALID_CREDENTIALS when account does not exist', async () => {
      const { service, client } = createMocks();
      client.account.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.login({ username: 'unknown_user', password: 'SomePassword123!' }),
      ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    });

    it('throws INVALID_CREDENTIALS when password does not match', async () => {
      const { service, client } = createMocks();
      client.account.findUnique.mockResolvedValueOnce({
        id: 1n,
        username: 'user1',
        password_hash: 'hashed-RealPassword123!',
        role: 'buyer',
        auth_version: 1,
        is_login_locked: false,
        temp_password_expires_at: null,
      });

      await expect(
        service.login({ username: 'user1', password: 'WrongPassword!' }),
      ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    });

    it('throws INVALID_CREDENTIALS when temp password has expired', async () => {
      const { service, client } = createMocks();
      const past = new Date(Date.now() - 1000);
      client.account.findUnique.mockResolvedValueOnce({
        id: 1n,
        username: 'artisan_expired',
        password_hash: 'hashed-TempPassword123!',
        role: 'artisan',
        auth_version: 1,
        is_login_locked: false,
        temp_password_expires_at: past,
        workshop: null,
      });

      await expect(
        service.login({ username: 'artisan_expired', password: 'TempPassword123!' }),
      ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    });

    it('throws INVALID_CREDENTIALS when account is locked', async () => {
      const { service, client } = createMocks();
      client.account.findUnique.mockResolvedValueOnce({
        id: 1n,
        username: 'locked_user',
        password_hash: 'hashed-Password123!',
        role: 'buyer',
        auth_version: 1,
        is_login_locked: true,
        temp_password_expires_at: null,
      });

      await expect(
        service.login({ username: 'locked_user', password: 'Password123!' }),
      ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    });
  });

  describe('getMe', () => {
    it('returns current actor details', async () => {
      const { service, client } = createMocks();
      client.account.findUnique.mockResolvedValueOnce({
        id: 101n,
        username: 'artisan_me',
        display_name: 'Artisan Me',
        role: 'artisan',
        workshop: { id: 202n },
      });

      const actor: AuthenticatedActor = {
        accountId: '101',
        role: 'artisan',
        workshopId: '202',
        authVersion: 1,
        sessionId: 's-1',
        sessionLevel: 'normal',
      };

      const result = await service.getMe(actor);
      expect(result).toEqual({
        id: '101',
        username: 'artisan_me',
        display_name: 'Artisan Me',
        role: 'artisan',
        workshop_id: '202',
        session_level: 'normal',
      });
    });

    it('throws RESOURCE_NOT_FOUND if account does not exist', async () => {
      const { service, client } = createMocks();
      client.account.findUnique.mockResolvedValueOnce(null);

      const actor: AuthenticatedActor = {
        accountId: '999',
        role: 'buyer',
        workshopId: null,
        authVersion: 1,
        sessionId: 's-1',
        sessionLevel: 'normal',
      };

      await expect(service.getMe(actor)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });
  });

  describe('logout', () => {
    it('revokes session in sessionManager', async () => {
      const { service, sessionManager } = createMocks();
      await service.logout('some-token');
      expect(sessionManager.revokeSession).toHaveBeenCalledWith('some-token');
    });
  });

  describe('changePassword', () => {
    const actor: AuthenticatedActor = {
      accountId: '101',
      role: 'buyer',
      workshopId: null,
      authVersion: 1,
      sessionId: 's-1',
      sessionLevel: 'normal',
    };

    it('updates password, increments auth_version, and revokes all sessions', async () => {
      const { service, client, sessionManager } = createMocks();
      client.$queryRaw.mockResolvedValueOnce([
        { id: 101n, password_hash: 'hashed-OldPassword123!', auth_version: 1, is_login_locked: false },
      ]);

      await service.changePassword(actor, {
        current_password: 'OldPassword123!',
        new_password: 'NewPassword123!',
        new_password_confirmation: 'NewPassword123!',
      });

      expect(client.account.update).toHaveBeenCalledWith({
        where: { id: 101n },
        data: {
          password_hash: 'hashed-NewPassword123!',
          auth_version: 2,
        },
      });
      expect(sessionManager.revokeAllForAccount).toHaveBeenCalledWith('101');
    });

    it('throws INVALID_INPUT when new password equals current password', async () => {
      const { service } = createMocks();
      await expect(
        service.changePassword(actor, {
          current_password: 'Password123!',
          new_password: 'Password123!',
          new_password_confirmation: 'Password123!',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('throws INVALID_CREDENTIALS when current password does not verify', async () => {
      const { service, client } = createMocks();
      client.$queryRaw.mockResolvedValueOnce([
        { id: 101n, password_hash: 'hashed-RealPassword123!', auth_version: 1, is_login_locked: false },
      ]);

      await expect(
        service.changePassword(actor, {
          current_password: 'WrongCurrentPassword!',
          new_password: 'NewPassword123!',
          new_password_confirmation: 'NewPassword123!',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    });
  });

  describe('changeTempPassword', () => {
    const actor: AuthenticatedActor = {
      accountId: '201',
      role: 'artisan',
      workshopId: '301',
      authVersion: 1,
      sessionId: 's-temp',
      sessionLevel: 'temp_password',
    };

    it('updates password, removes temp expiry, increments auth_version and logs audit', async () => {
      const { service, client, sessionManager } = createMocks();
      const future = new Date(Date.now() + 10 * 60 * 1000);
      client.$queryRaw.mockResolvedValueOnce([
        {
          id: 201n,
          password_hash: 'hashed-TempPassword123!',
          auth_version: 1,
          is_login_locked: false,
          temp_password_expires_at: future,
        },
      ]);

      await service.changeTempPassword(actor, {
        current_temp_password: 'TempPassword123!',
        new_password: 'NewSecurePassword123!',
        new_password_confirmation: 'NewSecurePassword123!',
      });

      expect(client.account.update).toHaveBeenCalledWith({
        where: { id: 201n },
        data: {
          password_hash: 'hashed-NewSecurePassword123!',
          auth_version: 2,
          temp_password_expires_at: null,
        },
      });
      expect(client.securityAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor_id: 201n,
          target_account_id: 201n,
          event_type: 'temp_password_changed',
          auth_version_before: 1,
          auth_version_after: 2,
        }),
      });
      expect(sessionManager.revokeAllForAccount).toHaveBeenCalledWith('201');
    });

    it('throws SESSION_EXPIRED when temp password has expired', async () => {
      const { service, client } = createMocks();
      const past = new Date(Date.now() - 1000);
      client.$queryRaw.mockResolvedValueOnce([
        {
          id: 201n,
          password_hash: 'hashed-TempPassword123!',
          auth_version: 1,
          is_login_locked: false,
          temp_password_expires_at: past,
        },
      ]);

      await expect(
        service.changeTempPassword(actor, {
          current_temp_password: 'TempPassword123!',
          new_password: 'NewSecurePassword123!',
          new_password_confirmation: 'NewSecurePassword123!',
        }),
      ).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    });
  });

  describe('createArtisanAccount (admin)', () => {
    const adminActor: AuthenticatedActor = {
      accountId: '99',
      role: 'admin',
      workshopId: null,
      authVersion: 1,
      sessionId: 'admin-sess',
      sessionLevel: 'normal',
    };

    it('creates artisan account & workshop and returns temporary password', async () => {
      const { service, client } = createMocks();
      client.$queryRaw.mockResolvedValueOnce([
        { id: 99n, role: 'admin', auth_version: 1, is_login_locked: false },
      ]);
      client.session.findUnique.mockResolvedValueOnce({
        id: 'admin-sess',
        is_revoked: false,
        auth_version: 1,
      });
      client.account.findUnique.mockResolvedValueOnce(null);
      client.account.create.mockResolvedValueOnce({
        id: 2005n,
        username: 'artisan_quang_vinh',
        auth_version: 1,
      });
      client.workshop.create.mockResolvedValueOnce({
        id: 305n,
        name: 'Xưởng Gốm Quang Vinh',
      });

      const result = await service.createArtisanAccount(adminActor, {
        username: 'artisan_quang_vinh',
        workshop_name: 'Xưởng Gốm Quang Vinh',
        address: 'Thôn 1 Bát Tràng',
      });

      expect(result.account_id).toBe('2005');
      expect(result.workshop_id).toBe('305');
      expect(result.username).toBe('artisan_quang_vinh');
      expect(typeof result.temporary_password).toBe('string');
      expect(result.temporary_password.length).toBeGreaterThanOrEqual(16);
      expect(client.workshop.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          account_id: 2005n,
          name: 'Xưởng Gốm Quang Vinh',
          status: 'active',
        }),
      });
    });

    it('throws PERMISSION_DENIED when caller is not admin', async () => {
      const { service } = createMocks();
      const buyerActor: AuthenticatedActor = {
        accountId: '1',
        role: 'buyer',
        workshopId: null,
        authVersion: 1,
        sessionId: 's-1',
        sessionLevel: 'normal',
      };

      await expect(
        service.createArtisanAccount(buyerActor, {
          username: 'artisan_test',
          workshop_name: 'Test Workshop',
        }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });
  });

  describe('resetPassword (admin)', () => {
    const adminActor: AuthenticatedActor = {
      accountId: '99',
      role: 'admin',
      workshopId: null,
      authVersion: 1,
      sessionId: 'admin-sess',
      sessionLevel: 'normal',
    };

    it('verifies admin password, resets target password, revokes target sessions and writes audit log', async () => {
      const { service, client, sessionManager, accountsDb } = createMocks();
      accountsDb.set(99n, { id: 99n, role: 'admin', password_hash: 'hashed-AdminPass123!', auth_version: 1, is_login_locked: false });
      accountsDb.set(2005n, { id: 2005n, role: 'artisan', auth_version: 2, is_login_locked: false });

      const result = await service.resetPassword(adminActor, '2005', {
        admin_current_password: 'AdminPass123!',
        reason: 'Lost device',
        verification_evidence: 'Direct verification',
      });

      expect(result.account_id).toBe('2005');
      expect(typeof result.temporary_password).toBe('string');
      expect(result.temporary_password.length).toBeGreaterThanOrEqual(16);
      expect(client.account.update).toHaveBeenCalledWith({
        where: { id: 2005n },
        data: expect.objectContaining({
          auth_version: 3,
        }),
      });
      expect(sessionManager.revokeAllForAccount).toHaveBeenCalledWith('2005');
      expect(client.securityAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor_id: 99n,
          target_account_id: 2005n,
          event_type: 'password_reset_by_admin',
          reason: 'Lost device',
          verification_evidence: 'Direct verification',
          auth_version_before: 2,
          auth_version_after: 3,
        }),
      });
    });

    it('throws PERMISSION_DENIED when target account is another admin', async () => {
      const { service, accountsDb } = createMocks();
      accountsDb.set(99n, { id: 99n, role: 'admin', password_hash: 'hashed-AdminPass123!', auth_version: 1, is_login_locked: false });
      accountsDb.set(88n, { id: 88n, role: 'admin', auth_version: 1, is_login_locked: false });

      await expect(
        service.resetPassword(adminActor, '88', {
          admin_current_password: 'AdminPass123!',
          reason: 'Attempt reset admin',
          verification_evidence: 'None',
        }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });

    it('throws INVALID_CREDENTIALS when admin password is wrong', async () => {
      const { service, accountsDb } = createMocks();
      accountsDb.set(99n, { id: 99n, role: 'admin', password_hash: 'hashed-AdminPass123!', auth_version: 1, is_login_locked: false });
      accountsDb.set(2005n, { id: 2005n, role: 'artisan', auth_version: 1, is_login_locked: false });

      await expect(
        service.resetPassword(adminActor, '2005', {
          admin_current_password: 'WrongAdminPassword',
          reason: 'Testing',
          verification_evidence: 'Testing',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    });

    it('throws RESOURCE_NOT_FOUND when target account does not exist', async () => {
      const { service, accountsDb } = createMocks();
      accountsDb.set(99n, { id: 99n, role: 'admin', password_hash: 'hashed-AdminPass123!', auth_version: 1, is_login_locked: false });

      await expect(
        service.resetPassword(adminActor, '404', {
          admin_current_password: 'AdminPass123!',
          reason: 'Testing',
          verification_evidence: 'Testing',
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('throws PERMISSION_DENIED when admin attempts self-reset', async () => {
      const { service } = createMocks();
      await expect(
        service.resetPassword(adminActor, '99', {
          admin_current_password: 'AdminPass123!',
          reason: 'Self reset',
          verification_evidence: 'Self',
        }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });
  });
});
