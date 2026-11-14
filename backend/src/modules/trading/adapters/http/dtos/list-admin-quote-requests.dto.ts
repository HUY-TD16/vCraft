import { z } from 'zod';
import {
  createZodDto,
  paginationQuery,
  queryBoolean,
} from '../../../../../common/http/pipes/global-validation.pipe';
import {
  COORDINATION_STATES,
  REQUEST_STATUSES,
  REQUEST_UNITS,
} from '../../../domain/value-objects/trading-enums';

export const ADMIN_QUOTE_REQUEST_STATUS_FILTER = [
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

export type AdminQuoteRequestStatusFilter =
  (typeof ADMIN_QUOTE_REQUEST_STATUS_FILTER)[number];

export const ADMIN_QUOTE_REQUEST_SORT_FIELDS = [
  'created_at',
  'updated_at',
  'bidding_deadline',
  'delivery_deadline',
  'quantity',
  'id',
] as const;

export type AdminQuoteRequestSortField =
  (typeof ADMIN_QUOTE_REQUEST_SORT_FIELDS)[number];

export const listAdminQuoteRequestsSchema = paginationQuery.extend({
  status: z.enum(ADMIN_QUOTE_REQUEST_STATUS_FILTER).optional(),
  cancelled: queryBoolean.optional(),
  buyer_id: z
    .string()
    .regex(/^[1-9]\d*$/, 'buyer_id must be a positive integer ID')
    .optional(),
  category_id: z
    .string()
    .regex(/^[1-9]\d*$/, 'category_id must be a positive integer ID')
    .optional(),
  sort_by: z.enum(ADMIN_QUOTE_REQUEST_SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  search: z.string().trim().max(100).optional(),
});

export class ListAdminQuoteRequestsQueryDto extends createZodDto(
  listAdminQuoteRequestsSchema,
) {}

/**
 * Strict Zod schema for BuyerRequestSummaryDto (api-dtos.md §2.2, BR-04, SEC-04).
 * Strictly excludes any recipient or delivery contact details.
 */
export const categoryRefDtoSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
});

export const buyerRequestSummarySchema = z.strictObject({
  id: z.string(),
  status: z.enum(REQUEST_STATUSES),
  version: z.number().int(),
  category: categoryRefDtoSchema.nullable(),
  quantity: z.number().int().nullable(),
  unit: z.enum(REQUEST_UNITS).nullable(),
  bidding_deadline: z.string().datetime().nullable(),
  delivery_deadline: z.string().datetime().nullable(),
  is_bidding_open: z.boolean(),
  cancelled_at: z.string().datetime().nullable(),
  split_requested_at: z.string().datetime().nullable(),
  coordination_state: z.enum(COORDINATION_STATES).nullable(),
  no_valid_quotes: z.boolean(),
  nearest_accept_deadline: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
});

export class BuyerRequestSummaryResponseDto extends createZodDto(
  buyerRequestSummarySchema,
) {}
