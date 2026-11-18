import { describe, expect, it } from 'vitest';
import type {
  AcceptanceInput,
  ITradingContract,
} from '../../src/modules/trading/public/contracts/trading.contract';
import type { TransactionRunner } from '../../src/common/application/ports/transaction-runner';
import { BusinessRuleException } from '../../src/common/domain/errors/business-rule.exception';

export interface TradingContractFixture {
  contract: ITradingContract;
  runner: TransactionRunner;
  validInput: AcceptanceInput & { idempotencyKey: string };
  invalidQuoteInput: AcceptanceInput & { idempotencyKey: string };
  dispose(): Promise<void>;
}

export function tradingContractSuite(
  name: string,
  setup: () => Promise<TradingContractFixture>,
): void {
  describe(name, () => {
    it('executes prepareAcceptance, findAcceptanceReplay, and accept adhering to ITradingContract invariants', async () => {
      const fixture = await setup();
      try {
        await fixture.runner.run(async (tx) => {
          const replayBefore = await fixture.contract.findAcceptanceReplay(
            fixture.validInput,
            tx,
          );
          expect(replayBefore).toBeNull();

          const prepared = await fixture.contract.prepareAcceptance(
            fixture.validInput,
            tx,
          );
          expect(prepared).toBeDefined();
          expect(Array.isArray(prepared.workshopIds)).toBe(true);
          expect(prepared.workshopIds.length).toBeGreaterThan(0);

          const missingQuote = fixture.contract.prepareAcceptance(
            fixture.invalidQuoteInput,
            tx,
          );
          await expect(missingQuote).rejects.toBeInstanceOf(BusinessRuleException);
          await expect(missingQuote).rejects.toMatchObject({
            code: 'RESOURCE_NOT_FOUND',
          });

          const acceptResult = await fixture.contract.accept(
            fixture.validInput,
            tx,
          );
          expect(acceptResult).toBeDefined();
          expect(acceptResult.data.request_status).toBe('buyer_accepted');
          expect(acceptResult.data.allocations.length).toBe(1);
          expect(acceptResult.operation.replayed).toBe(false);

          const replayAfter = await fixture.contract.findAcceptanceReplay(
            fixture.validInput,
            tx,
          );
          expect(replayAfter).not.toBeNull();
          expect(replayAfter?.operation.replayed).toBe(true);
          expect(replayAfter?.data).toEqual(acceptResult.data);
        });
      } finally {
        await fixture.dispose();
      }
    });
  });
}
