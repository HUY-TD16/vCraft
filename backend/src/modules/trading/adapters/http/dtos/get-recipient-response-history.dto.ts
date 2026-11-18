import { z } from 'zod';
import {
  createZodDto,
  paginationQuery,
} from '../../../../../common/http/pipes/global-validation.pipe';

export const getRecipientResponseHistoryQuerySchema = paginationQuery;

export class GetRecipientResponseHistoryQueryDto extends createZodDto(
  getRecipientResponseHistoryQuerySchema,
) {}

/**
 * Strict 6-field `quote_snapshot` Swagger schema (`api-dtos.md` §2.3, `data-design.md` §2.23).
 */
export const quoteSnapshotDtoResponseSchema = z.strictObject({
  unit_price: z.int().min(1).max(999_999_999_999_999),
  max_quantity: z.int().min(1).max(2_147_483_647),
  bid_accept_deadline: z.string(),
  committed_delivery_at: z.string(),
  status: z.enum(['active', 'withdrawn', 'accepted']),
  version: z.int().min(1).max(2_147_483_647),
});

/**
 * Strict 8-field `RecipientEventDto` Swagger schema (`api-dtos.md` §2.3).
 * Excludes `quote_id` and `recipient_id`; `performed_by.display_name` is nullable (`api-dtos.md` §1, `data-design.md` §2.1).
 */
export const recipientEventDtoResponseSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]*$/),
  event_type: z.enum([
    'declined',
    'quote_submitted',
    'quote_updated',
    'quote_withdrawn',
    'quote_resubmitted',
    'quote_accepted',
  ]),
  prev_status: z.enum(['pending', 'declined', 'quoted', 'withdrawn']),
  new_status: z.enum(['pending', 'declined', 'quoted', 'withdrawn']),
  reason: z.string().nullable(),
  quote_snapshot: quoteSnapshotDtoResponseSchema.nullable(),
  performed_by: z.strictObject({
    id: z.string().regex(/^[1-9][0-9]*$/),
    display_name: z.string().nullable(),
  }),
  created_at: z.string(),
});
