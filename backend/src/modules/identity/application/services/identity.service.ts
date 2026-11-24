import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
  Instant,
  Role,
  SessionLevel,
  TrustedActor,
} from '../../../../common/application/types/contract-types';
import { BusinessRuleException } from '../../../../common/domain/errors/business-rule.exception';
import { PrismaTransactionRunner } from '../../../../infrastructure/database/transactions/prisma-transaction-runner';
import { SESSION_MANAGER, type ISessionManager } from '../ports/session-manager.port';
import { PASSWORD_HASHER, type IPasswordHasher } from '../ports/password-hasher.port';
import {
  IDENTITY_REPOSITORY,
  type IIdentityRepository,
} from '../ports/repositories/identity.repository.port';
import { generateTemporaryPassword } from '../../adapters/crypto/password-generator';
import type { IIdentityContract } from '../../public/contracts/identity.contract';
import { findOrThrow, toBigIntId } from '../../../../common/application/helpers/find-or-throw';
import {
  AccountDomainRules,
  DUMMY_PASSWORD_HASH,
  TEMP_PASSWORD_DURATION_MS,
} from '../../domain/entities/account.entity';
import {
  toCreatedArtisanDto,
  toLoginUserDto,
  toMeDto,
  toRegisteredBuyerDto,
  toResetPasswordDto,
} from '../../adapters/http/mappers/identity.mapper';

@Injectable()
export class IdentityService implements IIdentityContract {
  constructor(
    @Inject(SESSION_MANAGER) private readonly sessionManager: ISessionManager,
    @Inject(PrismaTransactionRunner) private readonly runner: PrismaTransactionRunner,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: IPasswordHasher,
    @Inject(IDENTITY_REPOSITORY) private readonly identityRepo: IIdentityRepository,
  ) {}

  private async prepareTempPassword(durationMs = TEMP_PASSWORD_DURATION_MS) {
    const tempPassword = generateTemporaryPassword(16);
    const passwordHash = await this.passwordHasher.hash(tempPassword);
    const expiresAt = new Date(Date.now() + durationMs);
    return { tempPassword, passwordHash, expiresAt };
  }

  private async applyPasswordUpdate(
    actor: AuthenticatedActor,
    currentPassword: string,
    newPassword: string,
    newPasswordConfirmation: string,
    eventType: string,
    isTemp = false,
  ): Promise<void> {
    AccountDomainRules.assertPasswordConfirmationMatch(newPassword, newPasswordConfirmation);
    AccountDomainRules.assertNewPasswordDifferent(
      currentPassword,
      newPassword,
      isTemp
        ? 'Mật khẩu mới phải khác mật khẩu tạm'
        : 'Mật khẩu mới phải khác mật khẩu hiện tại',
    );

    await this.runner.run(async tx => {
      const accountId = toBigIntId(actor.accountId);
      const account = await this.identityRepo.lockAccountById(accountId, tx);

      AccountDomainRules.assertValidSessionAccount(account, actor.authVersion);
      if (isTemp && AccountDomainRules.isTempPasswordExpired(account.temp_password_expires_at)) {
        throw new BusinessRuleException('SESSION_EXPIRED');
      }
      if (!(await this.passwordHasher.verify(account.password_hash, currentPassword))) {
        throw new BusinessRuleException('INVALID_CREDENTIALS');
      }

      const newHash = await this.passwordHasher.hash(newPassword);
      const nextVersion = account.auth_version + 1;

      await this.identityRepo.updatePasswordAndBumpVersion(
        {
          accountId,
          passwordHash: newHash,
          nextAuthVersion: nextVersion,
          clearTempPassword: isTemp,
        },
        tx,
      );

      await this.identityRepo.recordSecurityAudit(
        {
          actorId: accountId,
          targetAccountId: accountId,
          eventType,
          authVersionBefore: account.auth_version,
          authVersionAfter: nextVersion,
        },
        tx,
      );

      await this.sessionManager.revokeAllForAccount(actor.accountId);
    });
  }

  async resolveSession(sessionToken: string): Promise<AuthenticatedActor | null> {
    return this.sessionManager.resolveSession(sessionToken);
  }

  async lockAndAssertAdmin(actor: TrustedActor, tx: TransactionContext): Promise<void> {
    if (!actor?.accountId) throw new BusinessRuleException('AUTHENTICATION_REQUIRED');
    if (actor.role !== 'admin') throw new BusinessRuleException('PERMISSION_DENIED');

    const account = await this.identityRepo.lockAccountById(toBigIntId(actor.accountId), tx);
    AccountDomainRules.assertValidSessionAccount(account, actor.authVersion, 'admin');

    if (actor.sessionId) {
      const session = await this.identityRepo.findSessionById(actor.sessionId, tx);
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

    const username = AccountDomainRules.normalizeUsername(input.username);

    if (await this.identityRepo.findAccountByUsername(username, tx)) {
      throw new BusinessRuleException('USERNAME_TAKEN');
    }

    const created = await this.identityRepo.createArtisanAccount(
      {
        username,
        passwordHash: input.passwordHash,
        tempPasswordExpiresAt: new Date(input.tempPasswordExpiresAt),
      },
      tx,
    );

    await this.identityRepo.recordSecurityAudit(
      {
        actorId: input.actor.accountId,
        targetAccountId: created.id,
        eventType: 'artisan_account_created',
        authVersionAfter: created.auth_version,
      },
      tx,
    );

    return { accountId: String(created.id), username: created.username };
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
    AccountDomainRules.assertPasswordConfirmationMatch(input.password, input.password_confirmation);
    const username = AccountDomainRules.normalizeUsername(input.username);

    if (await this.identityRepo.findAccountByUsername(username)) {
      throw new BusinessRuleException('USERNAME_TAKEN');
    }

    const passwordHash = await this.passwordHasher.hash(input.password);
    const created = await this.identityRepo.createBuyerAccount({
      username,
      passwordHash,
      displayName: input.display_name.trim(),
      phone: input.phone?.trim() || null,
    });

    return toRegisteredBuyerDto(created);
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
    const username = AccountDomainRules.normalizeUsername(input.username);
    const account = await this.identityRepo.findAccountByUsername(username);

    if (!account || account.is_login_locked) {
      await this.passwordHasher.verify(DUMMY_PASSWORD_HASH, input.password);
      throw new BusinessRuleException('INVALID_CREDENTIALS');
    }

    if (!(await this.passwordHasher.verify(account.password_hash, input.password))) {
      throw new BusinessRuleException('INVALID_CREDENTIALS');
    }

    const isTemp = Boolean(account.temp_password_expires_at);
    if (isTemp && AccountDomainRules.isTempPasswordExpired(account.temp_password_expires_at)) {
      throw new BusinessRuleException('INVALID_CREDENTIALS');
    }

    const sessionLevel: SessionLevel = isTemp ? 'temp_password' : 'normal';
    const createdSession = await this.sessionManager.createSession({
      accountId: String(account.id),
      authVersion: account.auth_version,
      level: sessionLevel,
    });

    return {
      user: toLoginUserDto(account, sessionLevel),
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
    const account = await findOrThrow(
      () => this.identityRepo.findAccountByIdWithWorkshop(toBigIntId(actor.accountId)),
      'RESOURCE_NOT_FOUND',
    );

    return toMeDto(account, actor.sessionLevel);
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
    await this.applyPasswordUpdate(
      actor,
      input.current_password,
      input.new_password,
      input.new_password_confirmation,
      'password_changed',
      false,
    );
  }

  async changeTempPassword(
    actor: AuthenticatedActor,
    input: {
      current_temp_password: string;
      new_password: string;
      new_password_confirmation: string;
    },
  ): Promise<void> {
    await this.applyPasswordUpdate(
      actor,
      input.current_temp_password,
      input.new_password,
      input.new_password_confirmation,
      'temp_password_changed',
      true,
    );
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
    if (actor.role !== 'admin') throw new BusinessRuleException('PERMISSION_DENIED');

    const username = AccountDomainRules.normalizeUsername(input.username);
    const { tempPassword, passwordHash, expiresAt } = await this.prepareTempPassword();

    return this.runner.run(async tx => {
      await this.lockAndAssertAdmin(actor, tx);

      const artisan = await this.createArtisan(
        {
          username,
          passwordHash,
          tempPasswordExpiresAt: expiresAt.toISOString(),
          actor: { accountId: actor.accountId, role: actor.role } as TrustedActor,
        },
        tx,
      );

      const workshop = await this.identityRepo.createInitialWorkshopForArtisan(
        {
          accountId: toBigIntId(artisan.accountId),
          name: input.workshop_name.trim(),
          address: input.address?.trim() || null,
        },
        tx,
      );

      return toCreatedArtisanDto(artisan, workshop, tempPassword, expiresAt);
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
    if (actor.role !== 'admin') throw new BusinessRuleException('PERMISSION_DENIED');
    const targetIdBig = toBigIntId(targetAccountId);
    if (actor.accountId === targetAccountId) throw new BusinessRuleException('PERMISSION_DENIED');

    const { tempPassword, passwordHash, expiresAt } = await this.prepareTempPassword();

    return this.runner.run(async tx => {
      const adminId = toBigIntId(actor.accountId);

      const firstId = adminId < targetIdBig ? adminId : targetIdBig;
      const secondId = adminId < targetIdBig ? targetIdBig : adminId;

      const firstRow = await this.identityRepo.lockAccountById(firstId, tx);
      const secondRow = await this.identityRepo.lockAccountById(secondId, tx);

      const admin = firstId === adminId ? firstRow : secondRow;
      const target = firstId === targetIdBig ? firstRow : secondRow;

      AccountDomainRules.assertValidSessionAccount(admin, actor.authVersion, 'admin');

      if (!(await this.passwordHasher.verify(admin.password_hash, input.admin_current_password))) {
        throw new BusinessRuleException('INVALID_CREDENTIALS');
      }

      if (!target) throw new BusinessRuleException('RESOURCE_NOT_FOUND');
      if (target.role === 'admin') throw new BusinessRuleException('PERMISSION_DENIED');

      const nextVersion = target.auth_version + 1;
      await this.identityRepo.updatePasswordAndBumpVersion(
        {
          accountId: targetIdBig,
          passwordHash,
          nextAuthVersion: nextVersion,
          tempPasswordExpiresAt: expiresAt,
        },
        tx,
      );

      await this.sessionManager.revokeAllForAccount(targetAccountId);

      await this.identityRepo.recordSecurityAudit(
        {
          actorId: admin.id,
          targetAccountId: target.id,
          eventType: 'password_reset_by_admin',
          reason: input.reason.trim(),
          verificationEvidence: input.verification_evidence.trim(),
          authVersionBefore: target.auth_version,
          authVersionAfter: nextVersion,
        },
        tx,
      );

      return toResetPasswordDto(targetAccountId, tempPassword, expiresAt);
    });
  }
}
