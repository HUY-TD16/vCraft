import { BusinessRuleException } from '../../../../common/domain/errors/business-rule.exception';

export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRmb3JkdW1teQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export const TEMP_PASSWORD_DURATION_MS = 24 * 60 * 60 * 1000;
export const TEMP_PASSWORD_DISCLOSURE_NOTE =
  'Mật khẩu tạm chỉ hiển thị MỘT LẦN DUY NHẤT. Hãy bàn giao an toàn ngoài hệ thống.';

export class AccountDomainRules {
  static normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
  }

  static isTempPasswordExpired(
    expiresAt: Date | null | undefined,
    now: Date = new Date(),
  ): boolean {
    return Boolean(expiresAt && now > expiresAt);
  }

  static assertValidSessionAccount<
    T extends { is_login_locked: boolean; auth_version: number; role: string },
  >(
    account: T | null,
    expectedAuthVersion: number,
    requiredRole?: string,
  ): asserts account is T {
    if (!account || account.is_login_locked || account.auth_version !== expectedAuthVersion) {
      throw new BusinessRuleException('SESSION_EXPIRED');
    }
    if (requiredRole && account.role !== requiredRole) {
      throw new BusinessRuleException('PERMISSION_DENIED');
    }
  }

  static assertPasswordConfirmationMatch(password: string, confirmation: string): void {
    if (password !== confirmation) {
      throw new BusinessRuleException('INVALID_INPUT', 'Mật khẩu xác nhận không khớp');
    }
  }

  static assertNewPasswordDifferent(
    currentPassword: string,
    newPassword: string,
    errorMessage: string,
  ): void {
    if (newPassword === currentPassword) {
      throw new BusinessRuleException('INVALID_INPUT', errorMessage);
    }
  }
}
