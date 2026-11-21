import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../../src/infrastructure/database/prisma/prisma.service';
import type { PrismaTransactionRunner } from '../../../src/infrastructure/database/transactions/prisma-transaction-runner';

const testUrl = process.env.VCRAFT_TEST_DATABASE_URL;

describe.skipIf(!testUrl)(
  'Task 39: IdempotencyCleanupService on PostgreSQL test schema',
  () => {
    let db: PrismaService;
    let txRunner: PrismaTransactionRunner;

    beforeAll(async () => {
      const { PrismaService } = await import(
        '../../../src/infrastructure/database/prisma/prisma.service'
      );
      const { PrismaTransactionRunner } = await import(
        '../../../src/infrastructure/database/transactions/prisma-transaction-runner'
      );
      db = new PrismaService({ DATABASE_URL: testUrl! });
      txRunner = new PrismaTransactionRunner(db);
    });

    afterAll(async () => {
      await db?.$disconnect();
    });

    it('deletes only IdempotencyRecord rows with expires_at < NOW() and keeps active/boundary rows intact', async () => {
      const { PrismaIdempotencyRecordRepository } = await import(
        '../../../src/modules/trading/adapters/persistence/repositories/idempotency-record.repository'
      );
      const { IdempotencyCleanupService } = await import(
        '../../../src/modules/trading/application/services/idempotency-cleanup.service'
      );

      const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      const account = await db.account.create({
        data: {
          username: `idem_clean_${suffix}`,
          password_hash: 'hash',
          role: 'buyer',
          display_name: 'Cleanup Test Buyer',
          phone: '0901234567',
        },
      });

      const now = new Date('2026-11-21T12:00:00.000Z');
      const oneDayMs = 24 * 60 * 60 * 1000;

      const expiredKey1 = randomUUID();
      const expiredKey2 = randomUUID();
      const exactBoundaryKey = randomUUID();
      const activeKey = randomUUID();

      try {
        await db.idempotencyRecord.createMany({
          data: [
            {
              idempotency_key: expiredKey1,
              request_fingerprint: 'a'.repeat(64),
              account_id: account.id,
              action: 'accept_quote',
              object_type: 'QuoteRequest',
              object_id: 1001n,
              result_snapshot: { status: 'buyer_accepted' },
              created_at: new Date(now.getTime() - 2 * oneDayMs),
              expires_at: new Date(now.getTime() - oneDayMs),
            },
            {
              idempotency_key: expiredKey2,
              request_fingerprint: 'b'.repeat(64),
              account_id: account.id,
              action: 'cancel',
              object_type: 'QuoteRequest',
              object_id: 1002n,
              result_snapshot: { cancelled: true },
              created_at: new Date(now.getTime() - oneDayMs - 1000),
              expires_at: new Date(now.getTime() - 1000),
            },
            {
              idempotency_key: exactBoundaryKey,
              request_fingerprint: 'c'.repeat(64),
              account_id: account.id,
              action: 'confirm_delivery',
              object_type: 'QuoteRequest',
              object_id: 1003n,
              result_snapshot: { status: 'delivered' },
              created_at: new Date(now.getTime() - oneDayMs),
              expires_at: now,
            },
            {
              idempotency_key: activeKey,
              request_fingerprint: 'd'.repeat(64),
              account_id: account.id,
              action: 'handover',
              object_type: 'Allocation',
              object_id: 1004n,
              result_snapshot: { status: 'handed_over' },
              created_at: now,
              expires_at: new Date(now.getTime() + oneDayMs),
            },
          ],
        });

        const repository = new PrismaIdempotencyRecordRepository(txRunner);
        const cleanupService = new IdempotencyCleanupService(
          repository,
          txRunner,
          () => now,
        );

        const result = await cleanupService.cleanupExpiredRecords();

        expect(result.status).toBe('completed');
        expect(result.deletedCount).toBeGreaterThanOrEqual(2);

        const remaining = await db.idempotencyRecord.findMany({
          where: { account_id: account.id },
          orderBy: { object_id: 'asc' },
        });
        expect(remaining.map((r) => r.idempotency_key)).toEqual([
          exactBoundaryKey,
          activeKey,
        ]);

        // Second sweep at the same timestamp deletes 0 rows for this account
        const secondResult = await cleanupService.cleanupExpiredRecords(now);
        expect(secondResult.status).toBe('completed');
        expect(secondResult.deletedCount).toBe(0);

        // Account row remains untouched
        const persistedAccount = await db.account.findUnique({
          where: { id: account.id },
        });
        expect(persistedAccount).not.toBeNull();
      } finally {
        await db.idempotencyRecord.deleteMany({
          where: { account_id: account.id },
        });
        await db.account.deleteMany({
          where: { id: account.id },
        });
      }
    });
  },
);
