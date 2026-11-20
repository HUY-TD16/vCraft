import type { AuthenticatedActor, Id, SessionLevel } from '../../../../common/application/types/contract-types';

export const SESSION_MANAGER = Symbol('SESSION_MANAGER');

export interface CreateSessionInput {
  readonly accountId: Id;
  readonly authVersion: number;
  readonly level?: SessionLevel;
}

export interface SessionResult {
  readonly id: string;
  readonly accountId: Id;
  readonly authVersion: number;
  readonly level: SessionLevel;
  readonly createdAt: Date;
  readonly lastActiveAt: Date;
  readonly expiresAt: Date;
  readonly isRevoked: boolean;
}

export interface CreatedSession {
  readonly token: string;
  readonly session: SessionResult;
}

export interface ISessionManager {
  createSession(input: CreateSessionInput): Promise<CreatedSession>;
  resolveSession(token: string): Promise<AuthenticatedActor | null>;
  revokeSession(token: string): Promise<boolean>;
  revokeAllForAccount(accountId: Id): Promise<number>;
}
