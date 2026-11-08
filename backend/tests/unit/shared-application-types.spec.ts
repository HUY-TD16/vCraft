import type { ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { createPageResult, PAGINATION } from '../../src/common/application/types/pagination';
import { paginationQuery } from '../../src/common/http/pipes/global-validation.pipe';
import { HttpResult, ResponseEnvelopeInterceptor } from '../../src/common/http/interceptors/response-envelope.interceptor';
import type { AcceptanceOperationDto } from '../../src/modules/trading/public/dtos/acceptance.dto';

describe('shared pagination', () => {
  it('uses the same defaults and limits at the query boundary', () => {
    expect(paginationQuery.parse({})).toEqual({ page: PAGINATION.defaultPage, limit: PAGINATION.defaultLimit });
    expect(paginationQuery.parse({ page: '2', limit: '100' })).toEqual({ page: 2, limit: 100 });
    expect(paginationQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(paginationQuery.safeParse({ page: '9007199254740992' }).success).toBe(false);
  });

  it('computes page counts without clamping the requested page or inventing records', () => {
    expect(createPageResult([], 0, { page: 1, limit: 20 }).pagination.total_pages).toBe(0);
    expect(createPageResult([], 21, { page: 3, limit: 20 })).toEqual({
      data: [], pagination: { page: 3, limit: 20, total_records: 21, total_pages: 2 },
    });
    expect(createPageResult([], Number.MAX_SAFE_INTEGER, { page: 1, limit: 1 }).pagination.total_pages).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    [0, 20, 0], [1.5, 20, 0], [1, 0, 0], [1, 101, 0],
    [1, 20, -1], [1, 20, 1.5], [1, 20, Number.MAX_SAFE_INTEGER + 1],
  ])('rejects invalid internal pagination (%s, %s, %s)', (page, limit, total) => {
    expect(() => createPageResult([], total, { page, limit })).toThrow(RangeError);
  });

  it('rejects an oversized page instead of silently dropping data', () => {
    expect(() => createPageResult(['a', 'b'], 2, { page: 1, limit: 1 })).toThrow(RangeError);
    expect(() => createPageResult(['a'], 0, { page: 1, limit: 20 })).toThrow(RangeError);
  });

  it('maps the shared page result through the real response interceptor', async () => {
    const result = HttpResult.paginated([{ id: '1' }], 21, { page: 2, limit: 20 });
    const context = { switchToHttp: () => ({ getResponse: () => ({ statusCode: 200 }) }) } as ExecutionContext;
    expect(await firstValueFrom(new ResponseEnvelopeInterceptor().intercept(context, { handle: () => of(result) }))).toEqual({
      success: true, data: [{ id: '1' }], pagination: { page: 2, limit: 20, total_records: 21, total_pages: 2 },
    });
  });

  it('keeps the Trading current_state type while sharing operation metadata with HTTP', async () => {
    const operation: AcceptanceOperationDto = {
      id: '1', replayed: true, committed_at: '2026-11-08T00:00:00.000Z',
      current_state: { request: { id: '2', status: 'buyer_accepted', version: 2, cancelled_at: null } },
    };
    const result = new HttpResult({ request_id: '2' }, { operation });
    const context = { switchToHttp: () => ({ getResponse: () => ({ statusCode: 200 }) }) } as ExecutionContext;
    expect(await firstValueFrom(new ResponseEnvelopeInterceptor().intercept(context, { handle: () => of(result) })))
      .toEqual({ success: true, data: { request_id: '2' }, operation });
  });
});
