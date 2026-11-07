export type Id = string;
export type Instant = string;
export type Role = 'buyer' | 'artisan' | 'admin';

export interface TrustedActor {
  accountId: Id;
  role: Role;
  workshopId: Id | null;
  authVersion: number;
  sessionId: string;
}
