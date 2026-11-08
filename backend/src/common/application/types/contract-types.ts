export type Id = string;
export type Instant = string;
export type Role = 'buyer' | 'artisan' | 'admin';
export type SessionLevel = 'normal' | 'temp_password';

export interface TrustedActor {
  readonly accountId: Id;
  readonly role: Role;
  readonly workshopId: Id | null;
  readonly authVersion: number;
  readonly sessionId: string;
}

export interface AuthenticatedActor extends TrustedActor {
  readonly sessionLevel: SessionLevel;
}
