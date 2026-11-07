import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import fixtures from '../../src/mocks/fixtures.json';
import { mockRequest } from '../../src/mocks/mock-api';

describe('frontend contract fixtures', () => {
  it('covers every endpoint in the handoff catalogue', () => {
    const document = readFileSync(new URL('../../../docs/contracts/frontend.md', import.meta.url), 'utf8');
    const routes = [...document.matchAll(/\| `(GET|POST|PUT|PATCH|DELETE) (\/api\/v1[^ `]+)` \|/g)];
    expect(routes.length).toBeGreaterThan(0);
    for (const [, method, path] of routes) {
      const pattern = new RegExp('^' + path.replace(/:[A-Za-z]+/g, '[^/]+') + '$');
      expect(fixtures.some(item => item.request.method === method
        && pattern.test(item.request.url.split('?')[0]) && item.response.status < 400), method + ' ' + path).toBe(true);
    }
  });
  it('returns the declared HTTP response for every scenario', async () => {
    expect(new Set(fixtures.map(item => item.name)).size).toBe(fixtures.length);
    for (const fixture of fixtures) {
      const response = await mockRequest(fixture.name);
      expect(response.status).toBe(fixture.response.status);
      if (response.status === 204) {
        expect(await response.text()).toBe('');
      } else if (response.headers.get('content-type') === 'image/png') {
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        const png = Buffer.from(bytes);
        let offset = 8;
        while (offset < png.length) {
          const size = png.readUInt32BE(offset);
          if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
            expect(inflateSync(png.subarray(offset + 8, offset + 8 + size)).length).toBe(5);
          }
          offset += size + 12;
        }
        expect(response.headers.get('cache-control')).toBe('no-store');
      } else {
        expect(await response.json()).toEqual(fixture.response.body);
      }
    }
  });

  it('omits contact details until an artisan has an allocation', async () => {
    const { data: invited } = await (await mockRequest('invited-request')).json();
    for (const field of ['recipient_name', 'recipient_phone', 'delivery_address', 'buyer_id']) {
      expect(invited).not.toHaveProperty(field);
    }
    const { data: allocated } = await (await mockRequest('allocated-request')).json();
    expect(allocated.own_allocation_id).toBe('12001');
    expect(allocated.recipient_name).toBeTruthy();
    const { data: quotes } = await (await mockRequest('own-quotes')).json();
    expect(quotes.every((quote: { workshop: { id: string } }) => quote.workshop.id === '301')).toBe(true);
  });

  it('keeps hidden workshop details out of the public trace', async () => {
    const { data } = await (await mockRequest('trace-suspended')).json();
    expect(Object.keys(data.workshop).sort()).toEqual(['is_profile_available', 'name', 'profile_url']);
    expect(data.workshop.profile_url).toBeNull();
    expect(data.workshop.is_profile_available).toBe(false);
  });

  it('preserves exact allocation amounts and distinguishes replay from current state', async () => {
    const { data: proposal } = await (await mockRequest('proposal')).json();
    let total = 0n;
    let quantity = 0;
    for (const item of proposal.items) {
      const amount = BigInt(item.quantity) * BigInt(item.unit_price);
      expect(item.line_total).toBe(amount.toString());
      total += amount;
      quantity += item.quantity;
    }
    expect(quantity).toBe(5000);
    expect(proposal.total_amount).toBe(total.toString());
    const { data, operation } = await (await mockRequest('accept-proposal-replay')).json();
    expect(data.request_status).toBe('buyer_accepted');
    expect(operation.current_state.request.status).toBe('in_production');
    expect(operation.replayed).toBe(true);
  });

  it('returns Problem Details and Retry-After without wrapping the error', async () => {
    for (const fixture of fixtures.filter(item => item.response.status >= 400)) {
      const response = await mockRequest(fixture.name);
      const problem = await response.json();
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(problem.status).toBe(response.status);
      expect(problem.type).toBe('urn:vcraft:problem:' + problem.code);
      expect(problem.tracking_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(problem).not.toHaveProperty('success');
      if (response.status === 429) expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    }
  });

  it('returns an independent body and rejects misspelled scenario names', async () => {
    const first = await (await mockRequest('buyer-request')).json();
    first.data.version = 99;
    expect((await (await mockRequest('buyer-request')).json()).data.version).toBe(3);
    await expect(mockRequest('not-a-fixture')).rejects.toThrow('Unknown mock scenario');
  });
});
