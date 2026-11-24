import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPgTestContext,
  createPgTradingStack,
  type PgTestContext,
} from '../../support/pg-trading-harness';

const testUrl = process.env.VCRAFT_TEST_DATABASE_URL;

describe.skipIf(!testUrl)('IdempotencyCleanupService on PostgreSQL (BR-27, 24h TTL)', () => {
  let ctx: PgTestContext;

  beforeAll(async () => {
    ctx = await createPgTestContext(testUrl!);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('deletes only IdempotencyRecord rows with expires_at < NOW() and retains active/boundary rows', async () => {
    const { createCleanupService } = await createPgTradingStack(ctx.db, ctx.txRunner);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const account = await ctx.db.account.create({
      data: { username: `idem_clean_${suffix}`, password_hash: 'hash', role: 'buyer', display_name: 'Cleanup Buyer', phone: '0901234567' },
    });

    const now = new Date('2026-11-21T12:00:00.000Z');
    const dayMs = 24 * 60 * 60 * 1000;
    const [expiredKey, boundaryKey, activeKey] = [randomUUID(), randomUUID(), randomUUID()];

    try {
      await ctx.db.idempotencyRecord.createMany({
        data: [
          {
            idempotency_key: expiredKey,
            request_fingerprint: 'a'.repeat(64),
            account_id: account.id,
            action: 'accept_quote',
            object_type: 'QuoteRequest',
            object_id: 1001n,
            result_snapshot: { status: 'buyer_accepted' },
            created_at: new Date(now.getTime() - dayMs - 1000),
            expires_at: new Date(now.getTime() - 1000),
          },
          {
            idempotency_key: boundaryKey,
            request_fingerprint: 'b'.repeat(64),
            account_id: account.id,
            action: 'confirm_delivery',
            object_type: 'QuoteRequest',
            object_id: 1002n,
            result_snapshot: { status: 'delivered' },
            created_at: new Date(now.getTime() - dayMs),
            expires_at: now,
          },
          {
            idempotency_key: activeKey,
            request_fingerprint: 'c'.repeat(64),
            account_id: account.id,
            action: 'handover',
            object_type: 'Allocation',
            object_id: 1003n,
            result_snapshot: { status: 'handed_over' },
            created_at: now,
            expires_at: new Date(now.getTime() + dayMs),
          },
        ],
      });

      const cleanup = createCleanupService(() => now);
      const first = await cleanup.cleanupExpiredRecords();
      expect(first.status).toBe('completed');
      expect(first.deletedCount).toBeGreaterThanOrEqual(1);

      const remaining = await ctx.db.idempotencyRecord.findMany({
        where: { account_id: account.id },
        orderBy: { object_id: 'asc' },
      });
      expect(remaining.map((r) => r.idempotency_key)).toEqual([boundaryKey, activeKey]);

      const second = await cleanup.cleanupExpiredRecords(now);
      expect(second.deletedCount).toBe(0);
    } finally {
      await ctx.db.idempotencyRecord.deleteMany({ where: { account_id: account.id } });
      await ctx.db.account.deleteMany({ where: { id: account.id } });
    }
  });
});
