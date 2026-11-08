import { SetMetadata } from '@nestjs/common';
import type { Role } from '../../application/types/contract-types';

export const ACCESS_POLICY = Symbol('ACCESS_POLICY');
export const SESSION_LEVELS = Symbol('SESSION_LEVELS');
export type SessionLevel = 'normal' | 'temp_password';
export type AccessPolicy = { kind: 'public' } | { kind: 'roles'; roles: readonly Role[] };

export const Public = () => SetMetadata(ACCESS_POLICY, { kind: 'public' } satisfies AccessPolicy);
export const Roles = (...roles: [Role, ...Role[]]) =>
  SetMetadata(ACCESS_POLICY, { kind: 'roles', roles: Object.freeze([...roles]) } satisfies AccessPolicy);
export const SessionLevels = (...levels: [SessionLevel, ...SessionLevel[]]) =>
  SetMetadata(SESSION_LEVELS, Object.freeze([...levels]));
