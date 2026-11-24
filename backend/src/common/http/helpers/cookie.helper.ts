import type { Response } from 'express';
import type { SessionLevel } from '../../application/types/contract-types';

export function isDevelopmentEnv(nodeEnv?: string): boolean {
  return (nodeEnv ?? process.env.NODE_ENV) === 'development';
}

export function getSessionCookieName(nodeEnv?: string): string {
  return isDevelopmentEnv(nodeEnv) ? 'vcraft-session' : '__Host-vcraft-session';
}

export function getPreauthCookieName(nodeEnv?: string): string {
  return isDevelopmentEnv(nodeEnv) ? 'vcraft-preauth' : '__Host-vcraft-preauth';
}

export function setSessionCookie(
  res: Response,
  token: string,
  level: SessionLevel,
  nodeEnv?: string,
): void {
  const isDev = isDevelopmentEnv(nodeEnv);
  const maxAge = level === 'temp_password' ? 15 * 60 * 1000 : 12 * 60 * 60 * 1000;
  res.cookie(getSessionCookieName(nodeEnv), token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: !isDev,
    maxAge,
  });
}

export function clearSessionCookie(res: Response, nodeEnv?: string): void {
  res.clearCookie(getSessionCookieName(nodeEnv), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: !isDevelopmentEnv(nodeEnv),
  });
}
