import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { PrismaService } from '../../../../infrastructure/database/prisma/prisma.service';
import { ServiceUnavailableException } from '../../../../common/application/errors/service-unavailable.exception';
import type { AuthenticatedActor, Id, Role, SessionLevel } from '../../../../common/application/types/contract-types';
import type {
  CreateSessionInput,
  CreatedSession,
  ISessionManager,
} from '../ports/session-manager.port';

const NORMAL_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const NORMAL_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const TEMP_PASSWORD_MAX_AGE_MS = 15 * 60 * 1000;

@Injectable()
export class SessionManagerService implements ISessionManager {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly nowProvider: () => Date = () => new Date(),
  ) {}

  generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async createSession(input: CreateSessionInput): Promise<CreatedSession> {
    try {
      const token = this.generateToken();
      const sessionHash = this.hashToken(token);
      const now = this.nowProvider();
      const level: SessionLevel = input.level ?? 'normal';
      const maxAge = level === 'temp_password' ? TEMP_PASSWORD_MAX_AGE_MS : NORMAL_MAX_AGE_MS;
      const expiresAt = new Date(now.getTime() + maxAge);
      const sessionId = randomUUID();

      const created = await this.prisma.session.create({
        data: {
          id: sessionId,
          account_id: BigInt(input.accountId),
          session_hash: sessionHash,
          auth_version: input.authVersion,
          level,
          created_at: now,
          last_active_at: now,
          expires_at: expiresAt,
          is_revoked: false,
        },
      });

      return {
        token,
        session: {
          id: created.id,
          accountId: String(created.account_id),
          authVersion: created.auth_version,
          level: created.level as SessionLevel,
          createdAt: created.created_at,
          lastActiveAt: created.last_active_at,
          expiresAt: created.expires_at,
          isRevoked: created.is_revoked,
        },
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('SECURITY_SERVICE_UNAVAILABLE');
    }
  }

  async resolveSession(token: string): Promise<AuthenticatedActor | null> {
    if (!token || typeof token !== 'string') return null;

    const sessionHash = this.hashToken(token);
    try {
      const record = await this.prisma.session.findUnique({
        where: { session_hash: sessionHash },
        include: {
          account: {
            include: {
              workshop: {
                select: { id: true },
              },
            },
          },
        },
      });

      if (!record) return null;
      if (record.is_revoked) return null;
      if (record.account.is_login_locked) return null;
      if (record.account.auth_version !== record.auth_version) return null;

      const now = this.nowProvider();
      if (now.getTime() >= record.expires_at.getTime()) return null;

      if (record.level === 'normal') {
        const idleElapsed = now.getTime() - record.last_active_at.getTime();
        if (idleElapsed > NORMAL_IDLE_TIMEOUT_MS) return null;
      }

      await this.prisma.session.update({
        where: { id: record.id },
        data: { last_active_at: now },
      });

      return {
        accountId: String(record.account.id),
        role: record.account.role as Role,
        workshopId: record.account.workshop ? String(record.account.workshop.id) : null,
        authVersion: record.account.auth_version,
        sessionId: record.id,
        sessionLevel: record.level as SessionLevel,
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('SECURITY_SERVICE_UNAVAILABLE');
    }
  }

  async revokeSession(token: string): Promise<boolean> {
    if (!token || typeof token !== 'string') return false;
    const sessionHash = this.hashToken(token);
    try {
      const result = await this.prisma.session.updateMany({
        where: { session_hash: sessionHash, is_revoked: false },
        data: { is_revoked: true },
      });
      return result.count > 0;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('SECURITY_SERVICE_UNAVAILABLE');
    }
  }

  async revokeAllForAccount(accountId: Id): Promise<number> {
    try {
      const result = await this.prisma.session.updateMany({
        where: { account_id: BigInt(accountId), is_revoked: false },
        data: { is_revoked: true },
      });
      return result.count;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('SECURITY_SERVICE_UNAVAILABLE');
    }
  }
}
