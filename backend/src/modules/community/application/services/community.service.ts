import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedActor } from '../../../../common/application/types/contract-types';
import { findOrThrow, toBigIntId } from '../../../../common/application/helpers/find-or-throw';
import { toPrismaOffset } from '../../../../common/application/types/pagination';
import { HttpResult } from '../../../../common/http/interceptors/response-envelope.interceptor';
import { NewsPostRules, type NewsPostRecord } from '../../domain/entities/news-post.entity';
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

  private async getOrThrow(id: string): Promise<NewsPostRecord> {
    const newsId = toBigIntId(id);
    return findOrThrow(() => this.newsRepo.findById(newsId));
  }

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

    return HttpResult.paginated(items.map(toPublicNewsSummaryDto), totalRecords, query);
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

    return HttpResult.paginated(items.map(toAdminNewsDto), totalRecords, query);
  }

  async getAdminNewsDetail(id: string): Promise<AdminNewsDto> {
    const post = await this.getOrThrow(id);
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
    const existing = await this.getOrThrow(id);

    const updated = await this.newsRepo.update(existing.id, {
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
    const existing = await this.getOrThrow(id);

    if (existing.status === dto.status) {
      return toAdminNewsDto(existing);
    }

    const updated = await this.newsRepo.updateStatus(existing.id, {
      status: dto.status,
      publishedAt: NewsPostRules.resolvePublishedAt(dto.status, existing.published_at),
      updatedBy: toBigIntId(actor.accountId),
    });

    return toAdminNewsDto(updated);
  }

  async deleteNews(id: string): Promise<void> {
    const existing = await this.getOrThrow(id);
    NewsPostRules.assertCanDelete(existing.status);
    await this.newsRepo.deleteById(existing.id);
  }
}
