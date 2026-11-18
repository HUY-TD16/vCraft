import { z } from 'zod';
import {
  createZodDto,
  paginationQuery,
} from '../../../../../common/http/pipes/global-validation.pipe';
import {
  DELIVERY_MODES,
  REQUEST_STATUSES,
  REQUEST_UNITS,
} from '../../../domain/value-objects/trading-enums';
import { recipientDtoResponseSchema } from './decline-quote-request.dto';
import { quoteDtoResponseSchema } from './submit-quote.dto';

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

export const invitedRequestDtoResponseSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]*$/),
  status: z.enum(REQUEST_STATUSES),
  version: z.int().min(1).max(2_147_483_647),
  category: z
    .strictObject({
      id: z.string().regex(/^[1-9][0-9]*$/),
      name: z.string(),
    })
    .nullable(),
  spec: z.string().nullable(),
  quantity: z.int().min(1).max(2_147_483_647).nullable(),
  unit: z.enum(REQUEST_UNITS).nullable(),
  unit_set_description: z.string().nullable(),
  delivery_mode: z.enum(DELIVERY_MODES).nullable(),
  delivery_region: z.string().nullable(),
  bidding_deadline: z.string().nullable(),
  delivery_deadline: z.string().nullable(),
  bidding_closed_at: z.string().nullable(),
  is_bidding_open: z.boolean(),
  cancelled_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  own_recipient: recipientDtoResponseSchema,
  own_quote: quoteDtoResponseSchema.nullable(),
  own_allocation_id: z.string().regex(/^[1-9][0-9]*$/).optional(),
  recipient_name: z.string().nullable().optional(),
  recipient_phone: z.string().nullable().optional(),
  delivery_address: z.string().nullable().optional(),
});
