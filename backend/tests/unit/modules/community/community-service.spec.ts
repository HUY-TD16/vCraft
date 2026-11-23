import { describe, expect, it, vi } from 'vitest';
import { CommunityService } from '../../../../src/modules/community/application/services/community.service';
import type { INewsRepository } from '../../../../src/modules/community/application/ports/repositories/news.repository.port';
import type { NewsPostRecord } from '../../../../src/modules/community/domain/entities/news-post.entity';
import type { AuthenticatedActor } from '../../../../src/common/application/types/contract-types';
import { BusinessRuleException } from '../../../../src/common/domain/errors/business-rule.exception';
import {
  ChangeNewsStatusSchema,
  ListAdminNewsQuerySchema,
  ListPublicNewsQuerySchema,
  NewsWriteSchema,
} from '../../../../src/modules/community/adapters/http/dtos/news.dto';

function createMocks(seed: NewsPostRecord[] = []) {
  const store = new Map<bigint, NewsPostRecord>(seed.map(p => [p.id, { ...p }]));
  let nextId = seed.reduce((max, p) => (p.id > max ? p.id : max), 0n) + 1n;

  const repo: INewsRepository = {
    findManyPublic: vi.fn(async ({ postType, order, skip, take }) => {
      const filtered = Array.from(store.values())
        .filter(p => p.status === 'published' && (!postType || p.post_type === postType))
        .sort((a, b) =>
          order === 'asc'
            ? a.created_at.getTime() - b.created_at.getTime()
            : b.created_at.getTime() - a.created_at.getTime(),
        );
      return { items: filtered.slice(skip, skip + take), totalRecords: filtered.length };
    }),
    findPublicById: vi.fn(async id => {
      const post = store.get(id);
      return post && post.status === 'published' ? post : null;
    }),
    findManyAdmin: vi.fn(async ({ status, postType, search, skip, take }) => {
      const filtered = Array.from(store.values())
        .filter(
          p =>
            (!status || p.status === status) &&
            (!postType || p.post_type === postType) &&
            (!search || p.title.toLowerCase().includes(search.toLowerCase())),
        )
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      return { items: filtered.slice(skip, skip + take), totalRecords: filtered.length };
    }),
    findById: vi.fn(async id => store.get(id) ?? null),
    create: vi.fn(async data => {
      const now = new Date('2026-11-23T10:00:00.000Z');
      const created: NewsPostRecord = {
        id: nextId++,
        created_by: data.createdBy,
        updated_by: null,
        title: data.title,
        content: data.content,
        post_type: data.postType,
        status: 'draft',
        published_at: null,
        created_at: now,
        updated_at: now,
      };
      store.set(created.id, created);
      return created;
    }),
    update: vi.fn(async (id, data) => {
      const current = store.get(id)!;
      const updated: NewsPostRecord = {
        ...current,
        title: data.title,
        content: data.content,
        post_type: data.postType,
        updated_by: data.updatedBy,
        updated_at: new Date('2026-11-23T11:00:00.000Z'),
      };
      store.set(id, updated);
      return updated;
    }),
    updateStatus: vi.fn(async (id, data) => {
      const current = store.get(id)!;
      const updated: NewsPostRecord = {
        ...current,
        status: data.status,
        published_at: data.publishedAt,
        updated_by: data.updatedBy,
        updated_at: new Date('2026-11-23T12:00:00.000Z'),
      };
      store.set(id, updated);
      return updated;
    }),
    deleteById: vi.fn(async id => {
      store.delete(id);
    }),
  };

  return { service: new CommunityService(repo), repo, store };
}

const adminActor: AuthenticatedActor = {
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'admin-sess',
  sessionLevel: 'normal',
};

const publishedPost: NewsPostRecord = {
  id: 601n,
  created_by: 1n,
  updated_by: null,
  title: 'Lịch sinh hoạt làng nghề',
  content: 'Buổi gặp mặt chia sẻ kỹ thuật tạo hình.',
  post_type: 'announcement',
  status: 'published',
  published_at: new Date('2026-11-10T08:00:00.000Z'),
  created_at: new Date('2026-11-10T08:00:00.000Z'),
  updated_at: new Date('2026-11-10T08:00:00.000Z'),
};

const draftPost: NewsPostRecord = {
  id: 602n,
  created_by: 1n,
  updated_by: null,
  title: 'Lịch cắt điện tháng 12',
  content: 'Thông báo lịch bảo trì lưới điện.',
  post_type: 'power_schedule',
  status: 'draft',
  published_at: null,
  created_at: new Date('2026-11-12T08:00:00.000Z'),
  updated_at: new Date('2026-11-12T08:00:00.000Z'),
};

describe('CommunityService', () => {
  describe('Public endpoints', () => {
    it('listPublicNews returns only published summaries without content', async () => {
      const { service } = createMocks([publishedPost, draftPost]);
      const result = await service.listPublicNews({
        page: 1,
        limit: 20,
        sort_by: 'created_at',
        order: 'desc',
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual({
        id: '601',
        title: 'Lịch sinh hoạt làng nghề',
        post_type: 'announcement',
        status: 'published',
        published_at: '2026-11-10T08:00:00.000Z',
        created_at: '2026-11-10T08:00:00.000Z',
        updated_at: '2026-11-10T08:00:00.000Z',
      });
      expect('content' in result.data[0]).toBe(false);
      expect(result.metadata.pagination).toEqual({
        page: 1,
        limit: 20,
        total_records: 1,
        total_pages: 1,
      });
    });

    it('getPublicNewsDetail returns content for published post', async () => {
      const { service } = createMocks([publishedPost]);
      const dto = await service.getPublicNewsDetail('601');

      expect(dto.id).toBe('601');
      expect(dto.content).toBe('Buổi gặp mặt chia sẻ kỹ thuật tạo hình.');
    });

    it.each([
      ['draft post', '602', 'RESOURCE_NOT_FOUND'],
      ['missing post', '999', 'RESOURCE_NOT_FOUND'],
      ['invalid id', 'abc', 'INVALID_INPUT'],
    ])('getPublicNewsDetail rejects %s with %s', async (_, id, code) => {
      const { service } = createMocks([publishedPost, draftPost]);
      await expect(service.getPublicNewsDetail(id)).rejects.toMatchObject({ code });
    });
  });

  describe('Admin endpoints', () => {
    it('listAdminNews returns drafts and published posts with created_by/updated_by', async () => {
      const { service } = createMocks([publishedPost, draftPost]);
      const result = await service.listAdminNews({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toMatchObject({
        id: '602',
        status: 'draft',
        created_by: '1',
        updated_by: null,
      });
    });

    it('getAdminNewsDetail returns draft post and throws 404 when missing', async () => {
      const { service } = createMocks([draftPost]);
      const dto = await service.getAdminNewsDetail('602');
      expect(dto.id).toBe('602');
      expect(dto.status).toBe('draft');

      await expect(service.getAdminNewsDetail('999')).rejects.toThrow(BusinessRuleException);
      await expect(service.getAdminNewsDetail('999')).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
      });
    });

    it('createNews creates draft with created_by and null published_at/updated_by', async () => {
      const { service } = createMocks();
      const dto = await service.createNews(adminActor, {
        title: '  Tin nguyên vật liệu  ',
        content: '  Giá đất sét trắng ổn định.  ',
        post_type: 'material',
      });

      expect(dto).toMatchObject({
        title: 'Tin nguyên vật liệu',
        content: 'Giá đất sét trắng ổn định.',
        post_type: 'material',
        status: 'draft',
        published_at: null,
        created_by: '1',
        updated_by: null,
      });
    });

    it('updateNews preserves status and updates updated_by', async () => {
      const { service } = createMocks([publishedPost]);
      const dto = await service.updateNews(
        { ...adminActor, accountId: '9' },
        '601',
        {
          title: 'Tiêu đề mới',
          content: 'Nội dung mới',
          post_type: 'support_policy',
        },
      );

      expect(dto).toMatchObject({
        id: '601',
        title: 'Tiêu đề mới',
        content: 'Nội dung mới',
        post_type: 'support_policy',
        status: 'published',
        updated_by: '9',
      });
    });

    it('changeNewsStatus publishes draft, reverts published to draft, and no-ops when unchanged', async () => {
      const { service, repo } = createMocks([draftPost]);

      const published = await service.changeNewsStatus(adminActor, '602', { status: 'published' });
      expect(published.status).toBe('published');
      expect(published.published_at).not.toBeNull();
      expect(published.updated_by).toBe('1');

      const unchanged = await service.changeNewsStatus(adminActor, '602', { status: 'published' });
      expect(unchanged.published_at).toBe(published.published_at);
      expect(repo.updateStatus).toHaveBeenCalledTimes(1);

      const reverted = await service.changeNewsStatus(adminActor, '602', { status: 'draft' });
      expect(reverted.status).toBe('draft');
      expect(reverted.published_at).toBeNull();
    });

    it('deleteNews deletes draft post and rejects published or missing post', async () => {
      const { service, store } = createMocks([publishedPost, draftPost]);

      await service.deleteNews('602');
      expect(store.has(602n)).toBe(false);

      await expect(service.deleteNews('601')).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await expect(service.deleteNews('999')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });
  });

  describe('DTO schemas', () => {
    it('enforces strictObject and valid enums on News DTOs', () => {
      expect(
        ListPublicNewsQuerySchema.safeParse({ page: '1', limit: '20', post_type: 'announcement' })
          .success,
      ).toBe(true);
      expect(ListPublicNewsQuerySchema.safeParse({ unknown_key: '1' }).success).toBe(false);
      expect(
        ListAdminNewsQuerySchema.safeParse({ status: 'draft', search: 'điện' }).success,
      ).toBe(true);
      expect(
        NewsWriteSchema.safeParse({ title: 'T', content: 'C', post_type: 'material', extra: 1 })
          .success,
      ).toBe(false);
      expect(ChangeNewsStatusSchema.safeParse({ status: 'archived' }).success).toBe(false);
    });
  });
});
