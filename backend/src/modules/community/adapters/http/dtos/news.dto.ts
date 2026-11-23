import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';
import { PaginationQuerySchema } from '../../../../../common/validators/common-schemas';
import {
  NEWS_POST_STATUSES,
  NEWS_POST_TYPES,
} from '../../../domain/entities/news-post.entity';

export const ListPublicNewsQuerySchema = PaginationQuerySchema.extend({
  post_type: z.enum(NEWS_POST_TYPES).optional(),
  sort_by: z.literal('created_at').default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export class ListPublicNewsQueryDto extends createZodDto(ListPublicNewsQuerySchema) {}

export const ListAdminNewsQuerySchema = PaginationQuerySchema.extend({
  status: z.enum(NEWS_POST_STATUSES).optional(),
  post_type: z.enum(NEWS_POST_TYPES).optional(),
  search: z.string().trim().optional(),
});

export class ListAdminNewsQueryDto extends createZodDto(ListAdminNewsQuerySchema) {}

export const NewsWriteSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1),
  post_type: z.enum(NEWS_POST_TYPES),
});

export class NewsWriteDto extends createZodDto(NewsWriteSchema) {}

export const ChangeNewsStatusSchema = z.strictObject({
  status: z.enum(NEWS_POST_STATUSES),
});

export class ChangeNewsStatusDto extends createZodDto(ChangeNewsStatusSchema) {}
