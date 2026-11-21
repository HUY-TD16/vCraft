import { z } from 'zod';
import {
  createZodDto,
  paginationQuery,
  queryBoolean,
} from '../../../../../common/http/pipes/global-validation.pipe';

export const BUYER_QUOTE_REQUEST_STATUS_FILTER = [
  'draft',
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

export type BuyerQuoteRequestStatusFilter =
  (typeof BUYER_QUOTE_REQUEST_STATUS_FILTER)[number];

export const BUYER_QUOTE_REQUEST_SORT_FIELDS = [
  'created_at',
  'updated_at',
  'bidding_deadline',
  'delivery_deadline',
  'quantity',
  'id',
] as const;

export type BuyerQuoteRequestSortField =
  (typeof BUYER_QUOTE_REQUEST_SORT_FIELDS)[number];

export const listBuyerQuoteRequestsSchema = paginationQuery.extend({
  status: z.enum(BUYER_QUOTE_REQUEST_STATUS_FILTER).optional(),
  sort_by: z.enum(BUYER_QUOTE_REQUEST_SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  search: z.string().trim().max(100).optional(),
  cancelled: queryBoolean.optional(),
});

export class ListBuyerQuoteRequestsQueryDto extends createZodDto(
  listBuyerQuoteRequestsSchema,
) {}
