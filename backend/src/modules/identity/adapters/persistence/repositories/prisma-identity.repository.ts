import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '../../../../../generated/prisma/client';
import { PrismaService } from '../../../../../infrastructure/database/prisma/prisma.service';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import { BusinessRuleException } from '../../../../../common/domain/errors/business-rule.exception';
import { logSecurityAudit } from '../../../../../common/security/audit-logger';
import type {
  AccountWithWorkshopRecord,
  IIdentityRepository,
  LockedAccountRecord,
} from '../../../application/ports/repositories/identity.repository.port';

@Injectable()
export class PrismaIdentityRepository implements IIdentityRepository {
  constructor(
    @Inject(PrismaTransactionRunner) private readonly runner: PrismaTransactionRunner,
    @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService,
  ) {}

  private client(tx?: TransactionContext) {
    if (tx) return this.runner.getClient(tx);
    return this.prisma ?? (this.runner as unknown as { prisma: PrismaService }).prisma;
  }

  async lockAccountById(
    id: bigint,
    tx: TransactionContext,
  ): Promise<LockedAccountRecord | null> {
    const db = this.client(tx);
    if (typeof db.$queryRaw === 'function') {
      const rows = await db.$queryRaw<LockedAccountRecord[]>`
        SELECT id, role, password_hash, auth_version, is_login_locked, temp_password_expires_at FROM "Account" WHERE id = ${id} FOR UPDATE
      `;
      return rows[0] ?? null;
    }
    return db.account.findUnique({ where: { id } }) as Promise<LockedAccountRecord | null>;
  }

  async findSessionById(
    sessionId: string,
    tx: TransactionContext,
  ): Promise<{ id: string; is_revoked: boolean; auth_version: number } | null> {
    return this.client(tx).session.findUnique({ where: { id: sessionId } });
  }

  async findAccountByUsername(
    username: string,
    tx?: TransactionContext,
  ): Promise<AccountWithWorkshopRecord | null> {
    return this.client(tx).account.findUnique({
      where: { username },
      include: { workshop: { select: { id: true } } },
    }) as Promise<AccountWithWorkshopRecord | null>;
  }

  async findAccountByIdWithWorkshop(id: bigint): Promise<AccountWithWorkshopRecord | null> {
    return this.client().account.findUnique({
      where: { id },
      include: { workshop: { select: { id: true } } },
    }) as Promise<AccountWithWorkshopRecord | null>;
  }

  async createArtisanAccount(
    data: {
      username: string;
      passwordHash: string;
      tempPasswordExpiresAt: Date;
    },
    tx: TransactionContext,
  ): Promise<{ id: bigint; username: string; auth_version: number }> {
    try {
      const created = await this.client(tx).account.create({
        data: {
          username: data.username,
          password_hash: data.passwordHash,
          role: 'artisan',
          auth_version: 1,
          is_login_locked: false,
          temp_password_expires_at: data.tempPasswordExpiresAt,
        },
      });
      return { id: created.id, username: created.username, auth_version: created.auth_version };
    } catch (error) {
      if (
        (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') ||
        (error as { code?: string })?.code === 'P2002'
      ) {
        throw new BusinessRuleException('USERNAME_TAKEN');
      }
      throw error;
    }
  }

  async createBuyerAccount(data: {
    username: string;
    passwordHash: string;
    displayName: string;
    phone: string | null;
  }): Promise<{
    id: bigint;
    username: string;
    display_name: string | null;
    role: string;
    created_at: Date;
  }> {
    return this.client().account.create({
      data: {
        username: data.username,
        password_hash: data.passwordHash,
        display_name: data.displayName,
        phone: data.phone,
        role: 'buyer',
        auth_version: 1,
        is_login_locked: false,
      },
    });
  }

  async createInitialWorkshopForArtisan(
    data: {
      accountId: bigint;
      name: string;
      address: string | null;
    },
    tx: TransactionContext,
  ): Promise<{ id: bigint; name: string }> {
    const workshop = await this.client(tx).workshop.create({
      data: {
        account_id: data.accountId,
        name: data.name,
        address: data.address,
        status: 'active',
      },
    });
    return { id: workshop.id, name: workshop.name };
  }

  async updatePasswordAndBumpVersion(
    data: {
      accountId: bigint;
      passwordHash: string;
      nextAuthVersion: number;
      clearTempPassword?: boolean;
      tempPasswordExpiresAt?: Date;
    },
    tx: TransactionContext,
  ): Promise<void> {
    await this.client(tx).account.update({
      where: { id: data.accountId },
      data: {
        password_hash: data.passwordHash,
        auth_version: data.nextAuthVersion,
        ...(data.clearTempPassword ? { temp_password_expires_at: null } : {}),
        ...(data.tempPasswordExpiresAt !== undefined
          ? { temp_password_expires_at: data.tempPasswordExpiresAt }
          : {}),
      },
    });
  }

  async recordSecurityAudit(
    data: {
      actorId: string | bigint;
      targetAccountId: string | bigint;
      eventType: string;
      reason?: string;
      verificationEvidence?: string;
      authVersionBefore?: number;
      authVersionAfter: number;
    },
    tx: TransactionContext,
  ): Promise<void> {
    await logSecurityAudit(this.client(tx), data);
  }
}
