import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedActor } from '../../../../common/application/types/contract-types';
import { findOrThrow, toBigIntId } from '../../../../common/application/helpers/find-or-throw';
import { toPrismaOffset } from '../../../../common/application/types/pagination';
import { HttpResult } from '../../../../common/http/interceptors/response-envelope.interceptor';
import { NewsPostRules } from '../../domain/entities/news-post.entity';
import {
  NEWS_REPOSITORY,
  type INewsRepository,
} from '../ports/repositories/news.repository.port';
import type {
  ChangeNewsStatusDto,
  ListAdminNewsQueryDto,
  ListPublicNewsQueryDto,
  NewsWriteDto,
} from '../../adapters/http/dtos/news.dto';
import {
  toAdminNewsDto,
  toPublicNewsDto,
  toPublicNewsSummaryDto,
  type AdminNewsDto,
  type PublicNewsDto,
  type PublicNewsSummaryDto,
} from '../../adapters/http/mappers/news.mapper';

@Injectable()
export class CommunityService {
  constructor(
    @Inject(NEWS_REPOSITORY) private readonly newsRepo: INewsRepository,
  ) {}

  async listPublicNews(
    query: ListPublicNewsQueryDto,
  ): Promise<HttpResult<readonly PublicNewsSummaryDto[]>> {
    const { skip, take } = toPrismaOffset(query);
    const { items, totalRecords } = await this.newsRepo.findManyPublic({
      postType: query.post_type,
      order: query.order,
      skip,
      take,
    });

    return HttpResult.paginated(items.map(toPublicNewsSummaryDto), totalRecords, {
      page: query.page,
      limit: query.limit,
    });
  }

  async getPublicNewsDetail(id: string): Promise<PublicNewsDto> {
    const newsId = toBigIntId(id);
    const post = await findOrThrow(() => this.newsRepo.findPublicById(newsId));
    return toPublicNewsDto(post);
  }

  async listAdminNews(
    query: ListAdminNewsQueryDto,
  ): Promise<HttpResult<readonly AdminNewsDto[]>> {
    const { skip, take } = toPrismaOffset(query);
    const { items, totalRecords } = await this.newsRepo.findManyAdmin({
      status: query.status,
      postType: query.post_type,
      search: query.search,
      skip,
      take,
    });

    return HttpResult.paginated(items.map(toAdminNewsDto), totalRecords, {
      page: query.page,
      limit: query.limit,
    });
  }

  async getAdminNewsDetail(id: string): Promise<AdminNewsDto> {
    const newsId = toBigIntId(id);
    const post = await findOrThrow(() => this.newsRepo.findById(newsId));
    return toAdminNewsDto(post);
  }

  async createNews(actor: AuthenticatedActor, dto: NewsWriteDto): Promise<AdminNewsDto> {
    const created = await this.newsRepo.create({
      title: dto.title.trim(),
      content: dto.content.trim(),
      postType: dto.post_type,
      createdBy: toBigIntId(actor.accountId),
    });

    return toAdminNewsDto(created);
  }

  async updateNews(
    actor: AuthenticatedActor,
    id: string,
    dto: NewsWriteDto,
  ): Promise<AdminNewsDto> {
    const newsId = toBigIntId(id);
    await findOrThrow(() => this.newsRepo.findById(newsId));

    const updated = await this.newsRepo.update(newsId, {
      title: dto.title.trim(),
      content: dto.content.trim(),
      postType: dto.post_type,
      updatedBy: toBigIntId(actor.accountId),
    });

    return toAdminNewsDto(updated);
  }

  async changeNewsStatus(
    actor: AuthenticatedActor,
    id: string,
    dto: ChangeNewsStatusDto,
  ): Promise<AdminNewsDto> {
    const newsId = toBigIntId(id);
    const existing = await findOrThrow(() => this.newsRepo.findById(newsId));

    if (existing.status === dto.status) {
      return toAdminNewsDto(existing);
    }

    const updated = await this.newsRepo.updateStatus(newsId, {
      status: dto.status,
      publishedAt: NewsPostRules.resolvePublishedAt(dto.status),
      updatedBy: toBigIntId(actor.accountId),
    });

    return toAdminNewsDto(updated);
  }

  async deleteNews(id: string): Promise<void> {
    const newsId = toBigIntId(id);
    const existing = await findOrThrow(() => this.newsRepo.findById(newsId));
    NewsPostRules.assertCanDelete(existing.status);
    await this.newsRepo.deleteById(newsId);
  }
}
