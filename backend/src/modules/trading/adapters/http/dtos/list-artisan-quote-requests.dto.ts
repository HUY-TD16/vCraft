import { z } from 'zod';
import {
  createZodDto,
  paginationQuery,
} from '../../../../../common/http/pipes/global-validation.pipe';

export const ARTISAN_QUOTE_REQUEST_STATUS_FILTER = [
  'bidding',
  'accepted',
  'in_production',
  'delivered',
  'cancelled',
  'draft_request',
  'sent_to_artisans',
  'artisans_bidding',
  'buyer_accepted',
] as const;

export type ArtisanQuoteRequestStatusFilter =
  (typeof ARTISAN_QUOTE_REQUEST_STATUS_FILTER)[number];

export const ARTISAN_RESPONSE_STATUS_FILTER = [
  'pending',
  'quoted',
  'declined',
  'withdrawn',
] as const;

export type ArtisanResponseStatusFilter =
  (typeof ARTISAN_RESPONSE_STATUS_FILTER)[number];

export const ARTISAN_QUOTE_REQUEST_SORT_FIELDS = [
  'created_at',
  'bidding_deadline',
  'delivery_deadline',
  'quantity',
  'id',
] as const;

export type ArtisanQuoteRequestSortField =
  (typeof ARTISAN_QUOTE_REQUEST_SORT_FIELDS)[number];

export const listArtisanQuoteRequestsSchema = paginationQuery.extend({
  status: z.enum(ARTISAN_QUOTE_REQUEST_STATUS_FILTER).optional(),
  response_status: z.enum(ARTISAN_RESPONSE_STATUS_FILTER).optional(),
  sort_by: z.enum(ARTISAN_QUOTE_REQUEST_SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  search: z.string().trim().max(100).optional(),
});

export class ListArtisanQuoteRequestsQueryDto extends createZodDto(
  listArtisanQuoteRequestsSchema,
) {}
