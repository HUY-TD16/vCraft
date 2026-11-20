import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type { AuthenticatedActor, Id, Instant, TrustedActor } from '../../../../common/application/types/contract-types';
import { BusinessRuleException } from '../../../../common/domain/errors/business-rule.exception';
import { PrismaTransactionRunner } from '../../../../infrastructure/database/transactions/prisma-transaction-runner';
import { Prisma } from '../../../../generated/prisma/client';
import { SESSION_MANAGER, type ISessionManager } from '../ports/session-manager.port';
import type { IIdentityContract } from '../../public/contracts/identity.contract';

@Injectable()
export class IdentityService implements IIdentityContract {
  constructor(
    @Inject(SESSION_MANAGER) private readonly sessionManager: ISessionManager,
    @Inject(PrismaTransactionRunner) private readonly runner: PrismaTransactionRunner,
  ) {}

  async resolveSession(sessionToken: string): Promise<AuthenticatedActor | null> {
    return this.sessionManager.resolveSession(sessionToken);
  }

  async lockAndAssertAdmin(actor: TrustedActor, tx: TransactionContext): Promise<void> {
    if (!actor || !actor.accountId) {
      throw new BusinessRuleException('AUTHENTICATION_REQUIRED');
    }
    if (actor.role !== 'admin') {
      throw new BusinessRuleException('PERMISSION_DENIED');
    }

    const client = this.runner.getClient(tx);
    const accountId = BigInt(actor.accountId);

    const rows = typeof client.$queryRaw === 'function'
      ? await client.$queryRaw<Array<{
          id: bigint;
          role: string;
          auth_version: number;
          is_login_locked: boolean;
        }>>`SELECT id, role, auth_version, is_login_locked FROM "Account" WHERE id = ${accountId} FOR UPDATE`
      : [await client.account.findUnique({ where: { id: accountId } })];

    const account = rows[0];
    if (!account || account.is_login_locked || account.auth_version !== actor.authVersion) {
      throw new BusinessRuleException('SESSION_EXPIRED');
    }
    if (account.role !== 'admin') {
      throw new BusinessRuleException('PERMISSION_DENIED');
    }

    if (actor.sessionId) {
      const session = await client.session.findUnique({
        where: { id: actor.sessionId },
      });
      if (!session || session.is_revoked || session.auth_version !== account.auth_version) {
        throw new BusinessRuleException('SESSION_EXPIRED');
      }
    }
  }

  async createArtisan(
    input: {
      username: string;
      passwordHash: string;
      tempPasswordExpiresAt: Instant;
      actor: TrustedActor;
    },
    tx: TransactionContext,
  ): Promise<{ accountId: Id; username: string }> {
    if (!input.actor || input.actor.role !== 'admin') {
      throw new BusinessRuleException('PERMISSION_DENIED');
    }

    const username = input.username.trim().toLowerCase();
    const client = this.runner.getClient(tx);

    const existing = await client.account.findUnique({
      where: { username },
    });
    if (existing) {
      throw new BusinessRuleException('USERNAME_TAKEN');
    }

    try {
      const created = await client.account.create({
        data: {
          username,
          password_hash: input.passwordHash,
          role: 'artisan',
          auth_version: 1,
          is_login_locked: false,
          temp_password_expires_at: new Date(input.tempPasswordExpiresAt),
        },
      });

      await client.securityAuditLog.create({
        data: {
          actor_id: BigInt(input.actor.accountId),
          target_account_id: created.id,
          event_type: 'artisan_account_created',
          auth_version_before: null,
          auth_version_after: created.auth_version,
        },
      });

      return {
        accountId: String(created.id),
        username: created.username,
      };
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
}
