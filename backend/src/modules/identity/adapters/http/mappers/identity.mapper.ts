import type { Id, Role, SessionLevel } from '../../../../../common/application/types/contract-types';
import { TEMP_PASSWORD_DISCLOSURE_NOTE } from '../../../domain/entities/account.entity';

export function toRegisteredBuyerDto(created: {
  id: bigint | string;
  username: string;
  display_name: string | null;
  role: string;
  created_at: Date;
}) {
  return {
    id: String(created.id) as Id,
    username: created.username,
    display_name: created.display_name,
    role: created.role as Role,
    created_at: created.created_at.toISOString(),
  };
}

export function toLoginUserDto(
  account: {
    id: bigint | string;
    username: string;
    role: string;
    workshop?: { id: bigint | string } | null;
  },
  sessionLevel: SessionLevel,
) {
  return {
    id: String(account.id) as Id,
    username: account.username,
    role: account.role as Role,
    workshop_id: account.workshop ? (String(account.workshop.id) as Id) : null,
    session_level: sessionLevel,
  };
}

export function toMeDto(
  account: {
    id: bigint | string;
    username: string;
    display_name: string | null;
    role: string;
    workshop?: { id: bigint | string } | null;
  },
  sessionLevel: SessionLevel,
) {
  return {
    ...toLoginUserDto(account, sessionLevel),
    display_name: account.display_name,
  };
}

export function toCreatedArtisanDto(
  artisan: { accountId: Id; username: string },
  workshop: { id: bigint | string; name: string },
  tempPassword: string,
  expiresAt: Date,
) {
  return {
    account_id: artisan.accountId,
    username: artisan.username,
    workshop_id: String(workshop.id) as Id,
    workshop_name: workshop.name,
    temporary_password: tempPassword,
    expires_at: expiresAt.toISOString(),
    note: TEMP_PASSWORD_DISCLOSURE_NOTE,
  };
}

export function toResetPasswordDto(
  targetAccountId: Id,
  tempPassword: string,
  expiresAt: Date,
) {
  return {
    account_id: targetAccountId,
    temporary_password: tempPassword,
    expires_at: expiresAt.toISOString(),
    note: TEMP_PASSWORD_DISCLOSURE_NOTE,
  };
}
