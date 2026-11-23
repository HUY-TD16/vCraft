import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicNewsController } from '../../../../src/modules/community/adapters/http/controllers/public-news.controller';
import { AdminNewsController } from '../../../../src/modules/community/adapters/http/controllers/admin-news.controller';
import { CommunityService } from '../../../../src/modules/community/application/services/community.service';
import type { AuthenticatedActor } from '../../../../src/common/application/types/contract-types';

describe('Community Controllers', () => {
  let communityService: Partial<CommunityService>;
  let publicController: PublicNewsController;
  let adminController: AdminNewsController;

  const adminActor: AuthenticatedActor = {
    accountId: '1',
    role: 'admin',
    workshopId: null,
    authVersion: 1,
    sessionId: 'admin-sess',
    sessionLevel: 'normal',
  };

  beforeEach(() => {
    communityService = {
      listPublicNews: vi.fn(),
      getPublicNewsDetail: vi.fn(),
      listAdminNews: vi.fn(),
      getAdminNewsDetail: vi.fn(),
      createNews: vi.fn(),
      updateNews: vi.fn(),
      changeNewsStatus: vi.fn(),
      deleteNews: vi.fn(),
    };
    publicController = new PublicNewsController(communityService as CommunityService);
    adminController = new AdminNewsController(communityService as CommunityService);
  });

  describe('PublicNewsController', () => {
    it('GET /news delegates to listPublicNews', async () => {
      const query = { page: 1, limit: 20, sort_by: 'created_at' as const, order: 'desc' as const };
      const expected = { data: [], metadata: { pagination: { page: 1, limit: 20, total_records: 0, total_pages: 0 } } };
      (communityService.listPublicNews as any).mockResolvedValueOnce(expected);

      const result = await publicController.listNews(query as any);
      expect(result).toEqual(expected);
      expect(communityService.listPublicNews).toHaveBeenCalledWith(query);
    });

    it('GET /news/:id delegates to getPublicNewsDetail', async () => {
      const expected = { id: '601', title: 'Tin tức', content: 'Nội dung' };
      (communityService.getPublicNewsDetail as any).mockResolvedValueOnce(expected);

      const result = await publicController.getNewsDetail('601');
      expect(result).toEqual(expected);
      expect(communityService.getPublicNewsDetail).toHaveBeenCalledWith('601');
    });
  });

  describe('AdminNewsController', () => {
    it('GET /admin/news delegates to listAdminNews', async () => {
      const query = { page: 1, limit: 20 };
      const expected = { data: [] };
      (communityService.listAdminNews as any).mockResolvedValueOnce(expected);

      const result = await adminController.listNews(query as any);
      expect(result).toEqual(expected);
      expect(communityService.listAdminNews).toHaveBeenCalledWith(query);
    });

    it('GET /admin/news/:id delegates to getAdminNewsDetail', async () => {
      const expected = { id: '601', status: 'draft' };
      (communityService.getAdminNewsDetail as any).mockResolvedValueOnce(expected);

      const result = await adminController.getNewsDetail('601');
      expect(result).toEqual(expected);
      expect(communityService.getAdminNewsDetail).toHaveBeenCalledWith('601');
    });

    it('POST /admin/news delegates to createNews', async () => {
      const dto = { title: 'Tin mới', content: 'Nội dung', post_type: 'announcement' as const };
      const expected = { id: '603', ...dto, status: 'draft' };
      (communityService.createNews as any).mockResolvedValueOnce(expected);

      const result = await adminController.createNews(adminActor, dto);
      expect(result).toEqual(expected);
      expect(communityService.createNews).toHaveBeenCalledWith(adminActor, dto);
    });

    it('PUT /admin/news/:id delegates to updateNews', async () => {
      const dto = { title: 'Sửa tin', content: 'Nội dung mới', post_type: 'material' as const };
      const expected = { id: '601', ...dto, status: 'draft' };
      (communityService.updateNews as any).mockResolvedValueOnce(expected);

      const result = await adminController.updateNews(adminActor, '601', dto);
      expect(result).toEqual(expected);
      expect(communityService.updateNews).toHaveBeenCalledWith(adminActor, '601', dto);
    });

    it('PATCH /admin/news/:id/status delegates to changeNewsStatus', async () => {
      const dto = { status: 'published' as const };
      const expected = { id: '601', status: 'published' };
      (communityService.changeNewsStatus as any).mockResolvedValueOnce(expected);

      const result = await adminController.changeNewsStatus(adminActor, '601', dto);
      expect(result).toEqual(expected);
      expect(communityService.changeNewsStatus).toHaveBeenCalledWith(adminActor, '601', dto);
    });

    it('DELETE /admin/news/:id delegates to deleteNews', async () => {
      (communityService.deleteNews as any).mockResolvedValueOnce(undefined);

      await adminController.deleteNews('602');
      expect(communityService.deleteNews).toHaveBeenCalledWith('602');
    });
  });
});
