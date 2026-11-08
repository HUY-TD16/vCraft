import type { TransactionContext, TransactionRunner } from '../../../src/common/application/ports/transaction-runner';

export class MockTransactionRunner implements TransactionRunner {
  readonly contexts: TransactionContext[] = [];
  async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const context = Object.freeze({}) as TransactionContext;
    this.contexts.push(context);
    return work(context);
  }
}
