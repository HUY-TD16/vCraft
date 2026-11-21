import { Inject, Injectable, Optional } from '@nestjs/common';
import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type { AuthenticatedActor, Id, Instant, Role, SessionLevel, TrustedActor } from '../../../../common/application/types/contract-types';
import { BusinessRuleException } from '../../../../common/domain/errors/business-rule.exception';
import { PrismaTransactionRunner } from '../../../../infrastructure/database/transactions/prisma-transaction-runner';
import { PrismaService } from '../../../../infrastructure/database/prisma/prisma.service';
import { Prisma } from '../../../../generated/prisma/client';
import { SESSION_MANAGER, type ISessionManager } from '../ports/session-manager.port';
import { PASSWORD_HASHER, type IPasswordHasher } from '../ports/password-hasher.port';
import { Argon2PasswordHasher } from '../../adapters/crypto/argon2-password-hasher';
import { generateTemporaryPassword } from '../../adapters/crypto/password-generator';
import type { IIdentityContract } from '../../public/contracts/identity.contract';

const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRmb3JkdW1teQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

@Injectable()
export class IdentityService implements IIdentityContract {
  constructor(
    @Inject(SESSION_MANAGER) private readonly sessionManager: ISessionManager,
    @Inject(PrismaTransactionRunner) private readonly runner: PrismaTransactionRunner,
    @Optional() @Inject(PASSWORD_HASHER) private readonly passwordHasher?: IPasswordHasher,
    @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService,
  ) { }

  private get hasher(): IPasswordHasher {
    return this.passwordHasher ?? new Argon2PasswordHasher();
  }

  private get dbClient() {
    return this.prisma ?? (this.runner as unknown as { prisma: PrismaService }).prisma;
  }

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

  async registerBuyer(input: {
    username: string;
    password: string;
    password_confirmation: string;
    display_name: string;
    phone?: string;
  }): Promise<{
    id: Id;
    username: string;
    display_name: string | null;
    role: Role;
    created_at: string;
  }> {
    if (input.password !== input.password_confirmation) {
      throw new BusinessRuleException('INVALID_INPUT', 'Mật khẩu xác nhận không khớp');
    }
    const username = input.username.trim().toLowerCase();
    const client = this.dbClient;

    const existing = await client.account.findUnique({
      where: { username },
    });
    if (existing) {
      throw new BusinessRuleException('USERNAME_TAKEN');
    }

    const passwordHash = await this.hasher.hash(input.password);
    const created = await client.account.create({
      data: {
        username,
        password_hash: passwordHash,
        display_name: input.display_name.trim(),
        phone: input.phone?.trim() || null,
        role: 'buyer',
        auth_version: 1,
        is_login_locked: false,
      },
    });

    return {
      id: String(created.id),
      username: created.username,
      display_name: created.display_name,
      role: created.role as Role,
      created_at: created.created_at.toISOString(),
    };
  }

  async login(input: {
    username: string;
    password: string;
  }): Promise<{
    user: {
      id: Id;
      username: string;
      role: Role;
      workshop_id: Id | null;
      session_level: SessionLevel;
    };
    sessionToken: string;
  }> {
    const username = input.username.trim().toLowerCase();
    const client = this.dbClient;

    const account = await client.account.findUnique({
      where: { username },
      include: {
        workshop: {
          select: { id: true },
        },
      },
    });

    if (!account || account.is_login_locked) {
      await this.hasher.verify(DUMMY_HASH, input.password);
      throw new BusinessRuleException('INVALID_CREDENTIALS');
    }

    const isValid = await this.hasher.verify(account.password_hash, input.password);
    if (!isValid) {
      throw new BusinessRuleException('INVALID_CREDENTIALS');
    }

    const isTemp = Boolean(account.temp_password_expires_at);
    if (isTemp && account.temp_password_expires_at) {
      if (new Date() > account.temp_password_expires_at) {
        throw new BusinessRuleException('INVALID_CREDENTIALS');
      }
    }

    const sessionLevel: SessionLevel = isTemp ? 'temp_password' : 'normal';
    const createdSession = await this.sessionManager.createSession({
      accountId: String(account.id),
      authVersion: account.auth_version,
      level: sessionLevel,
    });

    return {
      user: {
        id: String(account.id),
        username: account.username,
        role: account.role as Role,
        workshop_id: account.workshop ? String(account.workshop.id) : null,
        session_level: sessionLevel,
      },
      sessionToken: createdSession.token,
    };
  }

  async getMe(actor: AuthenticatedActor): Promise<{
    id: Id;
    username: string;
    display_name: string | null;
    role: Role;
    workshop_id: Id | null;
    session_level: SessionLevel;
  }> {
    const client = this.dbClient;
    const account = await client.account.findUnique({
      where: { id: BigInt(actor.accountId) },
      include: {
        workshop: {
          select: { id: true },
        },
      },
    });

    if (!account) {
      throw new BusinessRuleException('RESOURCE_NOT_FOUND');
    }

    return {
      id: String(account.id),
      username: account.username,
      display_name: account.display_name,
      role: account.role as Role,
      workshop_id: account.workshop ? String(account.workshop.id) : null,
      session_level: actor.sessionLevel,
    };
  }

  async logout(sessionToken?: string): Promise<void> {
    if (sessionToken) {
      await this.sessionManager.revokeSession(sessionToken);
    }
  }

  async changePassword(
    actor: AuthenticatedActor,
    input: {
      current_password: string;
      new_password: string;
      new_password_confirmation: string;
    },
  ): Promise<void> {
    if (input.new_password !== input.new_password_confirmation) {
      throw new BusinessRuleException('INVALID_INPUT', 'Mật khẩu xác nhận không khớp');
    }
    if (input.new_password === input.current_password) {
      throw new BusinessRuleException('INVALID_INPUT', 'Mật khẩu mới phải khác mật khẩu hiện tại');
    }

    await this.runner.run(async tx => {
      const client = this.runner.getClient(tx);
      const accountId = BigInt(actor.accountId);

      const rows = typeof client.$queryRaw === 'function'
        ? await client.$queryRaw<Array<{
          id: bigint;
          password_hash: string;
          auth_version: number;
          is_login_locked: boolean;
        }>>`SELECT id, password_hash, auth_version, is_login_locked FROM "Account" WHERE id = ${accountId} FOR UPDATE`
        : [await client.account.findUnique({ where: { id: accountId } })];

      const account = rows[0];
      if (!account || account.is_login_locked || account.auth_version !== actor.authVersion) {
        throw new BusinessRuleException('SESSION_EXPIRED');
      }

      const valid = await this.hasher.verify(account.password_hash, input.current_password);
      if (!valid) {
        throw new BusinessRuleException('INVALID_CREDENTIALS');
      }

      const newHash = await this.hasher.hash(input.new_password);
      await client.account.update({
        where: { id: accountId },
        data: {
          password_hash: newHash,
          auth_version: account.auth_version + 1,
        },
      });

      await this.sessionManager.revokeAllForAccount(actor.accountId);
    });
  }

  async changeTempPassword(
    actor: AuthenticatedActor,
    input: {
      current_temp_password: string;
      new_password: string;
      new_password_confirmation: string;
    },
  ): Promise<void> {
    if (input.new_password !== input.new_password_confirmation) {
      throw new BusinessRuleException('INVALID_INPUT', 'Mật khẩu xác nhận không khớp');
    }
    if (input.new_password === input.current_temp_password) {
      throw new BusinessRuleException('INVALID_INPUT', 'Mật khẩu mới phải khác mật khẩu tạm');
    }

    await this.runner.run(async tx => {
      const client = this.runner.getClient(tx);
      const accountId = BigInt(actor.accountId);

      const rows = typeof client.$queryRaw === 'function'
        ? await client.$queryRaw<Array<{
          id: bigint;
          password_hash: string;
          auth_version: number;
          is_login_locked: boolean;
          temp_password_expires_at: Date | null;
        }>>`SELECT id, password_hash, auth_version, is_login_locked, temp_password_expires_at FROM "Account" WHERE id = ${accountId} FOR UPDATE`
        : [await client.account.findUnique({ where: { id: accountId } })];

      const account = rows[0];
      if (!account || account.is_login_locked || account.auth_version !== actor.authVersion) {
        throw new BusinessRuleException('SESSION_EXPIRED');
      }
      if (account.temp_password_expires_at && new Date() > account.temp_password_expires_at) {
        throw new BusinessRuleException('SESSION_EXPIRED');
      }

      const valid = await this.hasher.verify(account.password_hash, input.current_temp_password);
      if (!valid) {
        throw new BusinessRuleException('INVALID_CREDENTIALS');
      }

      const newHash = await this.hasher.hash(input.new_password);
      await client.account.update({
        where: { id: accountId },
        data: {
          password_hash: newHash,
          auth_version: account.auth_version + 1,
          temp_password_expires_at: null,
        },
      });

      await client.securityAuditLog.create({
        data: {
          actor_id: accountId,
          target_account_id: accountId,
          event_type: 'temp_password_changed',
          auth_version_before: account.auth_version,
          auth_version_after: account.auth_version + 1,
        },
      });

      await this.sessionManager.revokeAllForAccount(actor.accountId);
    });
  }

  async createArtisanAccount(
    actor: AuthenticatedActor,
    input: {
      username: string;
      workshop_name: string;
      address?: string;
    },
  ): Promise<{
    account_id: Id;
    username: string;
    workshop_id: Id;
    workshop_name: string;
    temporary_password: string;
    expires_at: string;
    note: string;
  }> {
    if (actor.role !== 'admin') {
      throw new BusinessRuleException('PERMISSION_DENIED');
    }

    const username = input.username.trim().toLowerCase();
    const tempPassword = generateTemporaryPassword(16);
    const passwordHash = await this.hasher.hash(tempPassword);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    return this.runner.run(async tx => {
      await this.lockAndAssertAdmin(actor, tx);
      const client = this.runner.getClient(tx);

      const existing = await client.account.findUnique({
        where: { username },
      });
      if (existing) {
        throw new BusinessRuleException('USERNAME_TAKEN');
      }

      const account = await client.account.create({
        data: {
          username,
          password_hash: passwordHash,
          role: 'artisan',
          auth_version: 1,
          is_login_locked: false,
          temp_password_expires_at: expiresAt,
        },
      });

      const workshop = await client.workshop.create({
        data: {
          account_id: account.id,
          name: input.workshop_name.trim(),
          address: input.address?.trim() || null,
          status: 'active',
        },
      });

      await client.securityAuditLog.create({
        data: {
          actor_id: BigInt(actor.accountId),
          target_account_id: account.id,
          event_type: 'artisan_account_created',
          auth_version_before: null,
          auth_version_after: account.auth_version,
        },
      });

      return {
        account_id: String(account.id),
        username: account.username,
        workshop_id: String(workshop.id),
        workshop_name: workshop.name,
        temporary_password: tempPassword,
        expires_at: expiresAt.toISOString(),
        note: 'Mật khẩu tạm chỉ hiển thị MỘT LẦN DUY NHẤT. Hãy bàn giao an toàn ngoài hệ thống.',
      };
    });
  }

  async resetPassword(
    actor: AuthenticatedActor,
    targetAccountId: string,
    input: {
      admin_current_password: string;
      reason: string;
      verification_evidence: string;
    },
  ): Promise<{
    account_id: Id;
    temporary_password: string;
    expires_at: string;
    note: string;
  }> {
    if (actor.role !== 'admin') {
      throw new BusinessRuleException('PERMISSION_DENIED');
    }
    if (!/^[1-9][0-9]*$/.test(targetAccountId)) {
      throw new BusinessRuleException('INVALID_INPUT');
    }
    if (actor.accountId === targetAccountId) {
      throw new BusinessRuleException('PERMISSION_DENIED');
    }

    const tempPassword = generateTemporaryPassword(16);
    const passwordHash = await this.hasher.hash(tempPassword);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const targetIdBig = BigInt(targetAccountId);

    return this.runner.run(async tx => {
      const client = this.runner.getClient(tx);
      const adminId = BigInt(actor.accountId);

      const firstId = adminId < targetIdBig ? adminId : targetIdBig;
      const secondId = adminId < targetIdBig ? targetIdBig : adminId;

      const lockAccount = async (id: bigint) => {
        if (typeof client.$queryRaw === 'function') {
          const rows = await client.$queryRaw<Array<{
            id: bigint;
            role: string;
            password_hash: string;
            auth_version: number;
            is_login_locked: boolean;
          }>>`SELECT id, role, password_hash, auth_version, is_login_locked FROM "Account" WHERE id = ${id} FOR UPDATE`;
          return rows[0];
        }
        return client.account.findUnique({ where: { id } });
      };

      const firstRow = await lockAccount(firstId);
      const secondRow = await lockAccount(secondId);

      const admin = firstId === adminId ? firstRow : secondRow;
      const target = firstId === targetIdBig ? firstRow : secondRow;

      if (!admin || admin.is_login_locked || admin.auth_version !== actor.authVersion) {
        throw new BusinessRuleException('SESSION_EXPIRED');
      }
      if (admin.role !== 'admin') {
        throw new BusinessRuleException('PERMISSION_DENIED');
      }

      const validAdminPwd = await this.hasher.verify(admin.password_hash, input.admin_current_password);
      if (!validAdminPwd) {
        throw new BusinessRuleException('INVALID_CREDENTIALS');
      }

      if (!target) {
        throw new BusinessRuleException('RESOURCE_NOT_FOUND');
      }
      if (target.role === 'admin') {
        throw new BusinessRuleException('PERMISSION_DENIED');
      }

      await client.account.update({
        where: { id: targetIdBig },
        data: {
          password_hash: passwordHash,
          auth_version: target.auth_version + 1,
          temp_password_expires_at: expiresAt,
        },
      });

      await this.sessionManager.revokeAllForAccount(targetAccountId);

      await client.securityAuditLog.create({
        data: {
          actor_id: admin.id,
          target_account_id: target.id,
          event_type: 'password_reset_by_admin',
          reason: input.reason.trim(),
          verification_evidence: input.verification_evidence.trim(),
          auth_version_before: target.auth_version,
          auth_version_after: target.auth_version + 1,
        },
      });

      return {
        account_id: targetAccountId,
        temporary_password: tempPassword,
        expires_at: expiresAt.toISOString(),
        note: 'Mật khẩu tạm chỉ hiển thị MỘT LẦN DUY NHẤT. Hãy bàn giao an toàn ngoài hệ thống.',
      };
    });
  }
}
