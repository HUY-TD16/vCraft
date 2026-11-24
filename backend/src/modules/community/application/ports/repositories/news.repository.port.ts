import type {
  NewsPostRecord,
  NewsPostStatus,
  NewsPostType,
} from '../../../domain/entities/news-post.entity';

export const NEWS_REPOSITORY = Symbol('NEWS_REPOSITORY');

export interface INewsRepository {
  findManyPublic(params: {
    postType?: NewsPostType;
    order: 'asc' | 'desc';
    skip: number;
    take: number;
  }): Promise<{ items: NewsPostRecord[]; totalRecords: number }>;

  findPublicById(id: bigint): Promise<NewsPostRecord | null>;

  findManyAdmin(params: {
    status?: NewsPostStatus;
    postType?: NewsPostType;
    search?: string;
    skip: number;
    take: number;
  }): Promise<{ items: NewsPostRecord[]; totalRecords: number }>;

  findById(id: bigint): Promise<NewsPostRecord | null>;

  create(data: {
    title: string;
    content: string;
    postType: NewsPostType;
    createdBy: bigint;
  }): Promise<NewsPostRecord>;

  update(
    id: bigint,
    data: {
      title: string;
      content: string;
      postType: NewsPostType;
      updatedBy: bigint;
    },
  ): Promise<NewsPostRecord>;

  updateStatus(
    id: bigint,
    data: {
      status: NewsPostStatus;
      publishedAt: Date | null;
      updatedBy: bigint;
    },
  ): Promise<NewsPostRecord>;

  deleteById(id: bigint): Promise<void>;
}
