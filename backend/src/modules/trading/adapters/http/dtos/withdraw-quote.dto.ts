import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';
import { MAX_WITHDRAW_REASON_LENGTH } from '../../../domain/entities/quote.entity';

export const withdrawQuoteSchema = z.strictObject({
  expected_recipient_version: z.int().min(1).max(2_147_483_647),
  expected_quote_version: z.int().min(1).max(2_147_483_647),
  withdraw_reason: z.string().trim().min(1).max(MAX_WITHDRAW_REASON_LENGTH),
});

export class WithdrawQuoteDto extends createZodDto(withdrawQuoteSchema) {}

import { recipientAndQuoteOperationResponseSchema } from './trading-openapi-response.schemas';
export const withdrawQuoteOperationResponseSchema = recipientAndQuoteOperationResponseSchema;
