import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AdminAccountsController } from '../../../src/modules/identity/adapters/http/controllers/admin-accounts.controller';
import { IdentityService } from '../../../src/modules/identity/application/services/identity.service';
import type { AuthenticatedActor } from '../../../src/common/application/types/contract-types';

describe('AdminAccountsController', () => {
  let controller: AdminAccountsController;
  let identityService: Partial<IdentityService>;

  const adminActor: AuthenticatedActor = {
    accountId: '99',
    role: 'admin',
    workshopId: null,
    authVersion: 1,
    sessionId: 'admin-sess',
    sessionLevel: 'normal',
  };

  beforeEach(() => {
    identityService = {
      createArtisanAccount: vi.fn(),
      resetPassword: vi.fn(),
    };
    controller = new AdminAccountsController(identityService as IdentityService);
  });

  describe('POST /admin/accounts/artisan', () => {
    it('delegates to identityService.createArtisanAccount and returns 201 result', async () => {
      const dto = {
        username: 'artisan_quang_vinh',
        workshop_name: 'Xưởng Gốm Quang Vinh Bát Tràng',
        address: 'Số 12, Thôn 1 Làng Cổ Bát Tràng',
      };
      const expected = {
        account_id: '2005',
        username: 'artisan_quang_vinh',
        workshop_id: '305',
        workshop_name: 'Xưởng Gốm Quang Vinh Bát Tràng',
        temporary_password: 'Random16CharsString!@',
        expires_at: '2026-11-22T10:00:00.000Z',
        note: 'Mật khẩu tạm chỉ hiển thị MỘT LẦN DUY NHẤT. Hãy bàn giao an toàn ngoài hệ thống.',
      };
      (identityService.createArtisanAccount as any).mockResolvedValueOnce(expected);

      const result = await controller.createArtisan(adminActor, dto);
      expect(result).toEqual(expected);
      expect(identityService.createArtisanAccount).toHaveBeenCalledWith(adminActor, dto);
    });
  });

  describe('POST /admin/accounts/:id/reset-password', () => {
    it('delegates to identityService.resetPassword and returns reset result', async () => {
      const dto = {
        admin_current_password: 'AdminPassword123!',
        reason: 'Chủ hộ mất quyền truy cập thiết bị cũ',
        verification_evidence: 'Biên bản xác minh giấy tờ hộ kinh doanh',
      };
      const expected = {
        account_id: '2005',
        temporary_password: 'NewTempPassword16!',
        expires_at: '2026-11-22T10:00:00.000Z',
        note: 'Mật khẩu tạm chỉ hiển thị MỘT LẦN DUY NHẤT. Hãy bàn giao an toàn ngoài hệ thống.',
      };
      (identityService.resetPassword as any).mockResolvedValueOnce(expected);

      const result = await controller.resetPassword(adminActor, '2005', dto);
      expect(result).toEqual(expected);
      expect(identityService.resetPassword).toHaveBeenCalledWith(adminActor, '2005', dto);
    });
  });
});
