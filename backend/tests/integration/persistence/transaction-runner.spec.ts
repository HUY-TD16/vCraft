import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransactionContext } from '../../../src/common/application/ports/transaction-runner';
import { BusinessRuleException } from '../../../src/common/domain/errors/business-rule.exception';
import { createPgTestContext, type PgTestContext } from '../../support/pg-trading-harness';

const testUrl = process.env.VCRAFT_TEST_DATABASE_URL;

describe.skipIf(!testUrl)('PrismaTransactionRunner on PostgreSQL', () => {
  let ctx: PgTestContext;

  beforeAll(async () => {
    ctx = await createPgTestContext(testUrl!);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('rolls back provider writes and invalidates the context after a business error', async () => {
    const name = randomUUID();
    let saved!: TransactionContext;
    const error = new BusinessRuleException('WORKSHOP_SUSPENDED');
    await expect(
      ctx.txRunner.run(async (tx) => {
        saved = tx;
        await ctx.txRunner.getClient(tx).category.create({ data: { name } });
        expect(await ctx.txRunner.getClient(tx).category.findUnique({ where: { name } })).not.toBeNull();
        throw error;
      }),
    ).rejects.toBe(error);
    expect(await ctx.db.category.findUnique({ where: { name } })).toBeNull();
    expect(() => ctx.txRunner.getClient(saved)).toThrow('Invalid or expired transaction context');
  });

  it('commits successfully and rejects forged contexts and nested transactions', async () => {
    const name = randomUUID();
    let saved!: TransactionContext;
    try {
      await ctx.txRunner.run(async (tx) => {
        saved = tx;
        expect(() => ctx.txRunner.getClient({} as TransactionContext)).toThrow();
        await expect(ctx.txRunner.run(async () => undefined)).rejects.toThrow('Nested transactions');
        await ctx.txRunner.getClient(tx).category.create({ data: { name } });
      });
      expect(await ctx.db.category.findUnique({ where: { name } })).not.toBeNull();
      expect(() => ctx.txRunner.getClient(saved)).toThrow();
    } finally {
      await ctx.db.category.deleteMany({ where: { name } });
    }
  });
});
