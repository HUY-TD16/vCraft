import { describe, expect, it, vi } from 'vitest';
import { IdentityService } from '../../../src/modules/identity/application/services/identity.service';
import type { ISessionManager } from '../../../src/modules/identity/application/ports/session-manager.port';
import type { PrismaTransactionRunner } from '../../../src/infrastructure/database/transactions/prisma-transaction-runner';
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

  const client = {
    $queryRaw: vi.fn(),
    account: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    session: {
      findUnique: vi.fn(),
    },
    securityAuditLog: {
      create: vi.fn(),
    },
  };

  const runner = {
    getClient: vi.fn().mockReturnValue(client),
    run: vi.fn(),
  } as unknown as PrismaTransactionRunner;

  const service = new IdentityService(sessionManager, runner);
  const fakeTx = {} as TransactionContext;

  return { sessionManager, runner, client, service, fakeTx };
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
        auth_version: 2,
        is_revoked: false,
      });

      await expect(service.lockAndAssertAdmin(adminActor, fakeTx)).resolves.toBeUndefined();
      expect(client.$queryRaw).toHaveBeenCalled();
      expect(client.session.findUnique).toHaveBeenCalledWith({ where: { id: 'sess-admin' } });
    });

    it('throws SESSION_EXPIRED when locked account auth_version does not match actor', async () => {
      const { service, client, fakeTx } = createMocks();
      client.$queryRaw.mockResolvedValueOnce([
        { id: 99n, role: 'admin', auth_version: 3, is_login_locked: false },
      ]);

      await expect(service.lockAndAssertAdmin(adminActor, fakeTx))
        .rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    });

    it('throws SESSION_EXPIRED when account is login locked', async () => {
      const { service, client, fakeTx } = createMocks();
      client.$queryRaw.mockResolvedValueOnce([
        { id: 99n, role: 'admin', auth_version: 2, is_login_locked: true },
      ]);

      await expect(service.lockAndAssertAdmin(adminActor, fakeTx))
        .rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    });

    it('throws SESSION_EXPIRED when session is revoked in database', async () => {
      const { service, client, fakeTx } = createMocks();
      client.$queryRaw.mockResolvedValueOnce([
        { id: 99n, role: 'admin', auth_version: 2, is_login_locked: false },
      ]);
      client.session.findUnique.mockResolvedValueOnce({
        id: 'sess-admin',
        auth_version: 2,
        is_revoked: true,
      });

      await expect(service.lockAndAssertAdmin(adminActor, fakeTx))
        .rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    });
  });

  describe('createArtisan', () => {
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
});
