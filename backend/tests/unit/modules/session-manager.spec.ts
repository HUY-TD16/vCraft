import { describe, expect, it, vi } from 'vitest';
import { SessionManagerService } from '../../../src/modules/identity/application/services/session-manager.service';
import type { PrismaService } from '../../../src/infrastructure/database/prisma/prisma.service';
import { ServiceUnavailableException } from '../../../src/common/application/errors/service-unavailable.exception';

function createPrismaMock() {
  return {
    session: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  } as unknown as PrismaService;
}

describe('SessionManagerService', () => {
  it('creates random 256-bit token and persists its SHA-256 hash to database', async () => {
    const prisma = createPrismaMock();
    const fixedNow = new Date('2026-11-19T10:00:00.000Z');
    const service = new SessionManagerService(prisma, () => fixedNow);

    (prisma.session.create as unknown as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => ({
      id: data.id,
      account_id: data.account_id,
      session_hash: data.session_hash,
      auth_version: data.auth_version,
      level: data.level,
      created_at: data.created_at,
      last_active_at: data.last_active_at,
      expires_at: data.expires_at,
      is_revoked: data.is_revoked,
    }));

    const result = await service.createSession({
      accountId: '100',
      authVersion: 2,
      level: 'normal',
    });

    expect(result.token).toHaveLength(64);
    expect(result.session.accountId).toBe('100');
    expect(result.session.authVersion).toBe(2);
    expect(result.session.level).toBe('normal');
    expect(result.session.isRevoked).toBe(false);
    expect(result.session.createdAt).toEqual(fixedNow);
    expect(result.session.expiresAt).toEqual(new Date(fixedNow.getTime() + 12 * 60 * 60 * 1000));

    expect(prisma.session.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        account_id: 100n,
        auth_version: 2,
        level: 'normal',
        session_hash: service.hashToken(result.token),
        is_revoked: false,
      }),
    });
  });

  it('sets 15-minute expiration for temp_password session level', async () => {
    const prisma = createPrismaMock();
    const fixedNow = new Date('2026-11-19T10:00:00.000Z');
    const service = new SessionManagerService(prisma, () => fixedNow);

    (prisma.session.create as unknown as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => ({
      ...data,
    }));

    const result = await service.createSession({
      accountId: '200',
      authVersion: 1,
      level: 'temp_password',
    });

    expect(result.session.level).toBe('temp_password');
    expect(result.session.expiresAt).toEqual(new Date(fixedNow.getTime() + 15 * 60 * 1000));
  });

  it('resolves valid session, updates last_active_at, and builds AuthenticatedActor', async () => {
    const prisma = createPrismaMock();
    let currentTime = new Date('2026-11-19T10:00:00.000Z');
    const service = new SessionManagerService(prisma, () => currentTime);

    const token = 'a'.repeat(64);
    const sessionHash = service.hashToken(token);

    (prisma.session.findUnique as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'sess-1',
      account_id: 100n,
      session_hash: sessionHash,
      auth_version: 1,
      level: 'normal',
      created_at: new Date('2026-11-19T09:00:00.000Z'),
      last_active_at: new Date('2026-11-19T09:40:00.000Z'),
      expires_at: new Date('2026-11-19T21:00:00.000Z'),
      is_revoked: false,
      account: {
        id: 100n,
        role: 'artisan',
        auth_version: 1,
        is_login_locked: false,
        workshop: { id: 50n },
      },
    });

    const actor = await service.resolveSession(token);

    expect(actor).toEqual({
      accountId: '100',
      role: 'artisan',
      workshopId: '50',
      authVersion: 1,
      sessionId: 'sess-1',
      sessionLevel: 'normal',
    });

    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      data: { last_active_at: currentTime },
    });
  });

  it('rejects session if revoked, locked, or auth_version does not match account', async () => {
    const prisma = createPrismaMock();
    const service = new SessionManagerService(prisma);
    const token = 'b'.repeat(64);

    (prisma.session.findUnique as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      is_revoked: true,
      account: { is_login_locked: false, auth_version: 1 },
    });
    expect(await service.resolveSession(token)).toBeNull();

    (prisma.session.findUnique as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      is_revoked: false,
      account: { is_login_locked: true, auth_version: 1 },
    });
    expect(await service.resolveSession(token)).toBeNull();

    (prisma.session.findUnique as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      is_revoked: false,
      auth_version: 1,
      account: { is_login_locked: false, auth_version: 2 },
    });
    expect(await service.resolveSession(token)).toBeNull();
  });

  it('rejects session when exceeding 30-minute idle timeout for normal session', async () => {
    const prisma = createPrismaMock();
    const currentTime = new Date('2026-11-19T10:35:00.000Z');
    const service = new SessionManagerService(prisma, () => currentTime);
    const token = 'c'.repeat(64);

    (prisma.session.findUnique as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'sess-idle',
      is_revoked: false,
      auth_version: 1,
      level: 'normal',
      last_active_at: new Date('2026-11-19T10:00:00.000Z'),
      expires_at: new Date('2026-11-19T22:00:00.000Z'),
      account: { id: 10n, role: 'buyer', auth_version: 1, is_login_locked: false, workshop: null },
    });

    expect(await service.resolveSession(token)).toBeNull();
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it('revokes session by token and revokes all sessions for account', async () => {
    const prisma = createPrismaMock();
    const service = new SessionManagerService(prisma);
    const token = 'd'.repeat(64);

    (prisma.session.updateMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 1 });
    expect(await service.revokeSession(token)).toBe(true);

    (prisma.session.updateMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 3 });
    expect(await service.revokeAllForAccount('100')).toBe(3);
  });

  it('throws ServiceUnavailableException when database operations fail', async () => {
    const prisma = createPrismaMock();
    const service = new SessionManagerService(prisma);

    (prisma.session.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB failure'));
    await expect(service.createSession({ accountId: '1', authVersion: 1 }))
      .rejects.toThrow(ServiceUnavailableException);

    (prisma.session.findUnique as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB failure'));
    await expect(service.resolveSession('token'))
      .rejects.toThrow(ServiceUnavailableException);
  });
});
