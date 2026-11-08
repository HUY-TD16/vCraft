import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../../src/infrastructure/database/prisma/prisma.service';
import type { PrismaTransactionRunner } from '../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import type { TransactionContext } from '../../../src/common/application/ports/transaction-runner';
import { BusinessRuleException } from '../../../src/common/domain/errors/business-rule.exception';

const testUrl = process.env.VCRAFT_TEST_DATABASE_URL;

describe.skipIf(!testUrl)('PrismaTransactionRunner on PostgreSQL', () => {
  let db: PrismaService;
  let runner: PrismaTransactionRunner;

  beforeAll(async () => {
    const { PrismaService } = await import('../../../src/infrastructure/database/prisma/prisma.service');
    const { PrismaTransactionRunner } = await import('../../../src/infrastructure/database/transactions/prisma-transaction-runner');
    db = new PrismaService({ DATABASE_URL: testUrl! });
    runner = new PrismaTransactionRunner(db);
  });

  afterAll(async () => { await db?.$disconnect(); });

  it('rolls back provider writes and invalidates the context after a business error', async () => {
    const name = randomUUID();
    let saved!: TransactionContext;
    const error = new BusinessRuleException('WORKSHOP_SUSPENDED');
    await expect(runner.run(async tx => {
      saved = tx;
      await runner.getClient(tx).category.create({ data: { name } });
      expect(await runner.getClient(tx).category.findUnique({ where: { name } })).not.toBeNull();
      throw error;
    })).rejects.toBe(error);
    expect(await db.category.findUnique({ where: { name } })).toBeNull();
    expect(() => runner.getClient(saved)).toThrow('Invalid or expired transaction context');
  });

  it('commits successfully and rejects forged contexts and nested transactions', async () => {
    const name = randomUUID();
    let saved!: TransactionContext;
    try {
      await runner.run(async tx => {
        saved = tx;
        expect(() => runner.getClient({} as TransactionContext)).toThrow();
        await expect(runner.run(async () => undefined)).rejects.toThrow('Nested transactions');
        await runner.getClient(tx).category.create({ data: { name } });
      });
      expect(await db.category.findUnique({ where: { name } })).not.toBeNull();
      expect(() => runner.getClient(saved)).toThrow();
    } finally {
      await db.category.deleteMany({ where: { name } });
    }
  });
});
