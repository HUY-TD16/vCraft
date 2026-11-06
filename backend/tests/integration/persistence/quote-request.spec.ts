import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../src/infrastructure/database/prisma/prisma.service';

const testUrl = process.env.VCRAFT_TEST_DATABASE_URL;

describe.skipIf(!testUrl)('QuoteRequest on a migrated PostgreSQL test schema', () => {
  let db: PrismaService;

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', testUrl!);
    const { PrismaService } = await import('../../../src/infrastructure/database/prisma/prisma.service');
    db = new PrismaService();
  });

  afterAll(async () => {
    await db?.$disconnect();
    vi.unstubAllEnvs();
  });

  it('uses the configured schema for model queries', async () => {
    const schema = new URL(testUrl!).searchParams.get('schema');
    expect(schema).toBeTruthy();
    expect(schema).not.toBe('public');
    const rollback = new Error('rollback fixture');
    await expect(db.$transaction(async tx => {
      const name = randomUUID();
      await tx.category.create({ data: { name } });
      await tx.$queryRaw`SELECT set_config('search_path', quote_ident(${schema}::text), true)`;
      const rows = await tx.$queryRaw`SELECT name FROM "Category" WHERE name = ${name}`;
      expect(rows).toEqual([{ name }]);
      throw rollback;
    })).rejects.toBe(rollback);
  });

  it.each(['spec', 'recipient_name', 'recipient_phone', 'unit_set_description', 'delivery_region', 'delivery_address'])(
    'rejects whitespace-only %s when sending a draft',
    async field => {
      await expect(db.$transaction(async tx => {
        const name = randomUUID();
        const buyer = await tx.account.create({ data: {
          username: name.replaceAll('-', ''), password_hash: 'test', role: 'buyer', display_name: 'Buyer', phone: '123',
        } });
        const category = await tx.category.create({ data: { name } });
        const draft = await tx.quoteRequest.create({ data: {
          buyer_id: buyer.id, category_id: category.id, status: 'draft_request', spec: 'Cup',
          quantity: 1, unit: 'set', unit_set_description: 'Two cups', delivery_mode: 'at_buyer_address',
          delivery_region: 'HN', delivery_address: 'Test address', recipient_name: 'Buyer', recipient_phone: '123',
          bidding_deadline: new Date('2030-01-01Z'), delivery_deadline: new Date('2030-01-03Z'),
          [field]: ' \t\n',
        } });
        await tx.quoteRequest.update({ where: { id: draft.id }, data: { status: 'sent_to_artisans' } });
        throw new Error('expected sending to fail');
      })).rejects.toThrow(/QuoteRequest_sent_fields_check/);
    },
  );
});
