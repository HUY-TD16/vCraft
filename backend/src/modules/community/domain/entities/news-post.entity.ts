import { BusinessRuleException } from '../../../../common/domain/errors/business-rule.exception';

export const NEWS_POST_TYPES = [
  'material',
  'power_schedule',
  'support_policy',
  'announcement',
] as const;

export type NewsPostType = (typeof NEWS_POST_TYPES)[number];

export const NEWS_POST_STATUSES = ['draft', 'published'] as const;

export type NewsPostStatus = (typeof NEWS_POST_STATUSES)[number];

export interface NewsPostRecord {
  id: bigint;
  created_by: bigint;
  updated_by: bigint | null;
  title: string;
  content: string;
  post_type: NewsPostType;
  status: NewsPostStatus;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export class NewsPostRules {
  static assertCanDelete(status: string): void {
    if (status !== 'draft') {
      throw new BusinessRuleException('INVALID_STATE', 'Only draft news posts can be deleted.');
    }
  }

  static resolvePublishedAt(
    nextStatus: NewsPostStatus,
    currentPublishedAt: Date | null = null,
    now: Date = new Date(),
  ): Date | null {
    return nextStatus === 'published' ? (currentPublishedAt ?? now) : null;
  }
}
