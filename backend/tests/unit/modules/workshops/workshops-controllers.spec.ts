import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PublicWorkshopsController } from '../../../../src/modules/workshops/adapters/http/controllers/public-workshops.controller';
import { ArtisanWorkshopController } from '../../../../src/modules/workshops/adapters/http/controllers/artisan-workshop.controller';
import { AdminWorkshopsController } from '../../../../src/modules/workshops/adapters/http/controllers/admin-workshops.controller';
import { WorkshopService } from '../../../../src/modules/workshops/application/services/workshop.service';
import type { AuthenticatedActor } from '../../../../src/common/application/types/contract-types';

describe('Workshops Controllers', () => {
  let workshopService: Partial<WorkshopService>;

  const adminActor: AuthenticatedActor = {
    accountId: '99',
    role: 'admin',
    workshopId: null,
    authVersion: 1,
    sessionId: 'admin-sess',
    sessionLevel: 'normal',
  };

  const artisanActor: AuthenticatedActor = {
    accountId: '200',
    role: 'artisan',
    workshopId: '1',
    authVersion: 1,
    sessionId: 'artisan-sess',
    sessionLevel: 'normal',
  };

  beforeEach(() => {
    workshopService = {
      listPublicWorkshops: vi.fn(),
      getPublicWorkshopDetail: vi.fn(),
      getOwnWorkshop: vi.fn(),
      updateOwnWorkshop: vi.fn(),
      updateVisitors: vi.fn(),
      listAdminWorkshops: vi.fn(),
      getAdminWorkshop: vi.fn(),
      getWorkshopStatusHistory: vi.fn(),
      changeStatusByAdmin: vi.fn(),
    };
  });

  describe('PublicWorkshopsController', () => {
    it('GET /workshops delegates to listPublicWorkshops', async () => {
      const controller = new PublicWorkshopsController(workshopService as WorkshopService);
      const query = { page: 1, limit: 20 };
      const expected = { success: true, data: [], pagination: { page: 1, limit: 20, total_records: 0, total_pages: 0 } };
      (workshopService.listPublicWorkshops as any).mockResolvedValueOnce(expected);

      const result = await controller.listWorkshops(query as any);
      expect(result).toEqual(expected);
      expect(workshopService.listPublicWorkshops).toHaveBeenCalledWith(query);
    });

    it('GET /workshops/:id delegates to getPublicWorkshopDetail', async () => {
      const controller = new PublicWorkshopsController(workshopService as WorkshopService);
      const expected = { id: '1', name: 'Xưởng Gốm', is_profile_public: true };
      (workshopService.getPublicWorkshopDetail as any).mockResolvedValueOnce(expected);

      const result = await controller.getWorkshopDetail('1');
      expect(result).toEqual(expected);
      expect(workshopService.getPublicWorkshopDetail).toHaveBeenCalledWith('1');
    });
  });

  describe('ArtisanWorkshopController', () => {
    it('GET /artisan/workshop delegates to getOwnWorkshop', async () => {
      const controller = new ArtisanWorkshopController(workshopService as WorkshopService);
      const expected = { id: '1', name: 'Xưởng Của Tôi', status: 'active' };
      (workshopService.getOwnWorkshop as any).mockResolvedValueOnce(expected);

      const result = await controller.getOwnWorkshop(artisanActor);
      expect(result).toEqual(expected);
      expect(workshopService.getOwnWorkshop).toHaveBeenCalledWith(artisanActor);
    });

    it('PUT /artisan/workshop delegates to updateOwnWorkshop', async () => {
      const controller = new ArtisanWorkshopController(workshopService as WorkshopService);
      const dto = {
        name: 'Tên mới',
        image_ids: [],
        certificates: [],
      };
      const expected = { id: '1', name: 'Tên mới', status: 'active' };
      (workshopService.updateOwnWorkshop as any).mockResolvedValueOnce(expected);

      const result = await controller.updateOwnWorkshop(artisanActor, dto as any);
      expect(result).toEqual(expected);
      expect(workshopService.updateOwnWorkshop).toHaveBeenCalledWith(artisanActor, dto);
    });

    it('PATCH /artisan/workshop/visitors delegates to updateVisitors', async () => {
      const controller = new ArtisanWorkshopController(workshopService as WorkshopService);
      const dto = { accepting_visitors: true };
      const expected = { accepting_visitors: true };
      (workshopService.updateVisitors as any).mockResolvedValueOnce(expected);

      const result = await controller.updateVisitors(artisanActor, dto);
      expect(result).toEqual(expected);
      expect(workshopService.updateVisitors).toHaveBeenCalledWith(artisanActor, dto);
    });
  });

  describe('AdminWorkshopsController', () => {
    it('GET /admin/workshops delegates to listAdminWorkshops', async () => {
      const controller = new AdminWorkshopsController(workshopService as WorkshopService);
      const query = { page: 1, limit: 20 };
      const expected = { success: true, data: [] };
      (workshopService.listAdminWorkshops as any).mockResolvedValueOnce(expected);

      const result = await controller.listWorkshops(query as any);
      expect(result).toEqual(expected);
      expect(workshopService.listAdminWorkshops).toHaveBeenCalledWith(query);
    });

    it('GET /admin/workshops/:id delegates to getAdminWorkshop', async () => {
      const controller = new AdminWorkshopsController(workshopService as WorkshopService);
      const expected = { id: '1', name: 'Xưởng Admin' };
      (workshopService.getAdminWorkshop as any).mockResolvedValueOnce(expected);

      const result = await controller.getWorkshop('1');
      expect(result).toEqual(expected);
      expect(workshopService.getAdminWorkshop).toHaveBeenCalledWith('1');
    });

    it('GET /admin/workshops/:id/status-history delegates to getWorkshopStatusHistory', async () => {
      const controller = new AdminWorkshopsController(workshopService as WorkshopService);
      const query = { page: 1, limit: 10 };
      const expected = { success: true, data: [] };
      (workshopService.getWorkshopStatusHistory as any).mockResolvedValueOnce(expected);

      const result = await controller.getStatusHistory('1', query as any);
      expect(result).toEqual(expected);
      expect(workshopService.getWorkshopStatusHistory).toHaveBeenCalledWith('1', query);
    });

    it('PATCH /admin/workshops/:id/status delegates to changeStatusByAdmin', async () => {
      const controller = new AdminWorkshopsController(workshopService as WorkshopService);
      const dto = { status: 'suspended' as const, reason: 'Vi phạm quy định' };
      const expected = { id: '1', status: 'suspended' };
      (workshopService.changeStatusByAdmin as any).mockResolvedValueOnce(expected);

      const result = await controller.changeStatus('1', dto, adminActor);
      expect(result).toEqual(expected);
      expect(workshopService.changeStatusByAdmin).toHaveBeenCalledWith('1', dto, adminActor);
    });
  });
});
