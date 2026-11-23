import type { Id } from '../../../../../common/application/types/contract-types';
import type {
  NewsPostRecord,
  NewsPostStatus,
  NewsPostType,
} from '../../../domain/entities/news-post.entity';

export interface PublicNewsSummaryDto {
  id: Id;
  title: string;
  post_type: NewsPostType;
  status: NewsPostStatus;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicNewsDto extends PublicNewsSummaryDto {
  content: string;
}

export interface AdminNewsDto extends PublicNewsDto {
  created_by: Id;
  updated_by: Id | null;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export function toPublicNewsSummaryDto(post: NewsPostRecord): PublicNewsSummaryDto {
  return {
    id: String(post.id),
    title: post.title,
    post_type: post.post_type,
    status: post.status,
    published_at: post.published_at ? toIsoString(post.published_at) : null,
    created_at: toIsoString(post.created_at),
    updated_at: toIsoString(post.updated_at),
  };
}

export function toPublicNewsDto(post: NewsPostRecord): PublicNewsDto {
  return {
    ...toPublicNewsSummaryDto(post),
    content: post.content,
  };
}

export function toAdminNewsDto(post: NewsPostRecord): AdminNewsDto {
  return {
    ...toPublicNewsDto(post),
    created_by: String(post.created_by),
    updated_by: post.updated_by !== null ? String(post.updated_by) : null,
  };
}
