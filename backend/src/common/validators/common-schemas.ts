import { z } from 'zod';
import { PAGINATION } from '../application/types/pagination';

export const NumericIdSchema = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]*$/, 'ID phải là số nguyên dương');

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(PAGINATION.defaultPage),
  limit: z.coerce.number().int().min(1).max(PAGINATION.maxLimit).default(PAGINATION.defaultLimit),
});

export const MoneySchema = z.coerce
  .number()
  .int()
  .nonnegative('Số tiền không được âm');

export const VnPhoneSchema = z
  .string()
  .trim()
  .regex(/^0[0-9]{9,10}$/, 'Số điện thoại không hợp lệ');

export const SafeTextSchema = (min = 1, max = 255) =>
  z.string().trim().min(min).max(max);
