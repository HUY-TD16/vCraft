declare const transactionContextBrand: unique symbol;

export type TransactionContext = { readonly [transactionContextBrand]: true };

export interface TransactionRunner {
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');
