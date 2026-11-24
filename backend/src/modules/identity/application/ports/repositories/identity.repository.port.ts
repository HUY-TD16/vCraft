import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';

export const IDENTITY_REPOSITORY = Symbol('IDENTITY_REPOSITORY');

export interface LockedAccountRecord {
  id: bigint;
  role: string;
  password_hash: string;
  auth_version: number;
  is_login_locked: boolean;
  temp_password_expires_at?: Date | null;
}

export interface AccountWithWorkshopRecord {
  id: bigint;
  username: string;
  display_name: string | null;
  role: string;
  password_hash: string;
  auth_version: number;
  is_login_locked: boolean;
  temp_password_expires_at?: Date | null;
  workshop?: { id: bigint } | null;
}

export interface IIdentityRepository {
  lockAccountById(id: bigint, tx: TransactionContext): Promise<LockedAccountRecord | null>;

  findSessionById(
    sessionId: string,
    tx: TransactionContext,
  ): Promise<{ id: string; is_revoked: boolean; auth_version: number } | null>;

  findAccountByUsername(
    username: string,
    tx?: TransactionContext,
  ): Promise<AccountWithWorkshopRecord | null>;

  findAccountByIdWithWorkshop(id: bigint): Promise<AccountWithWorkshopRecord | null>;

  createArtisanAccount(
    data: {
      username: string;
      passwordHash: string;
      tempPasswordExpiresAt: Date;
    },
    tx: TransactionContext,
  ): Promise<{ id: bigint; username: string; auth_version: number }>;

  createBuyerAccount(data: {
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
  }>;

  createInitialWorkshopForArtisan(
    data: {
      accountId: bigint;
      name: string;
      address: string | null;
    },
    tx: TransactionContext,
  ): Promise<{ id: bigint; name: string }>;

  updatePasswordAndBumpVersion(
    data: {
      accountId: bigint;
      passwordHash: string;
      nextAuthVersion: number;
      clearTempPassword?: boolean;
      tempPasswordExpiresAt?: Date;
    },
    tx: TransactionContext,
  ): Promise<void>;

  recordSecurityAudit(
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
  ): Promise<void>;
}
