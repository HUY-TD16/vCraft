import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../../../generated/prisma/client';
import { PrismaService } from '../../../../../infrastructure/database/prisma/prisma.service';
import type {
  NewsPostRecord,
  NewsPostStatus,
  NewsPostType,
} from '../../../domain/entities/news-post.entity';
import type { INewsRepository } from '../../../application/ports/repositories/news.repository.port';

@Injectable()
export class PrismaNewsRepository implements INewsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async paginate(
    where: Prisma.NewsPostWhereInput,
    skip: number,
    take: number,
    order: 'asc' | 'desc' = 'desc',
  ): Promise<{ items: NewsPostRecord[]; totalRecords: number }> {
    const [totalRecords, items] = await Promise.all([
      this.prisma.newsPost.count({ where }),
      this.prisma.newsPost.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: order },
      }),
    ]);

    return { items: items as NewsPostRecord[], totalRecords };
  }

  async findManyPublic(params: {
    postType?: NewsPostType;
    order: 'asc' | 'desc';
    skip: number;
    take: number;
  }): Promise<{ items: NewsPostRecord[]; totalRecords: number }> {
    return this.paginate(
      {
        status: 'published',
        ...(params.postType ? { post_type: params.postType } : {}),
      },
      params.skip,
      params.take,
      params.order,
    );
  }

  async findPublicById(id: bigint): Promise<NewsPostRecord | null> {
    return this.prisma.newsPost.findFirst({
      where: { id, status: 'published' },
    }) as Promise<NewsPostRecord | null>;
  }

  async findManyAdmin(params: {
    status?: NewsPostStatus;
    postType?: NewsPostType;
    search?: string;
    skip: number;
    take: number;
  }): Promise<{ items: NewsPostRecord[]; totalRecords: number }> {
    return this.paginate(
      {
        ...(params.status ? { status: params.status } : {}),
        ...(params.postType ? { post_type: params.postType } : {}),
        ...(params.search ? { title: { contains: params.search, mode: 'insensitive' } } : {}),
      },
      params.skip,
      params.take,
    );
  }

  async findById(id: bigint): Promise<NewsPostRecord | null> {
    return this.prisma.newsPost.findUnique({
      where: { id },
    }) as Promise<NewsPostRecord | null>;
  }

  async create(data: {
    title: string;
    content: string;
    postType: NewsPostType;
    createdBy: bigint;
  }): Promise<NewsPostRecord> {
    return this.prisma.newsPost.create({
      data: {
        title: data.title,
        content: data.content,
        post_type: data.postType,
        status: 'draft',
        created_by: data.createdBy,
      },
    }) as Promise<NewsPostRecord>;
  }

  async update(
    id: bigint,
    data: {
      title: string;
      content: string;
      postType: NewsPostType;
      updatedBy: bigint;
    },
  ): Promise<NewsPostRecord> {
    return this.prisma.newsPost.update({
      where: { id },
      data: {
        title: data.title,
        content: data.content,
        post_type: data.postType,
        updated_by: data.updatedBy,
      },
    }) as Promise<NewsPostRecord>;
  }

  async updateStatus(
    id: bigint,
    data: {
      status: NewsPostStatus;
      publishedAt: Date | null;
      updatedBy: bigint;
    },
  ): Promise<NewsPostRecord> {
    return this.prisma.newsPost.update({
      where: { id },
      data: {
        status: data.status,
        published_at: data.publishedAt,
        updated_by: data.updatedBy,
      },
    }) as Promise<NewsPostRecord>;
  }

  async deleteById(id: bigint): Promise<void> {
    await this.prisma.newsPost.delete({ where: { id } });
  }
}
