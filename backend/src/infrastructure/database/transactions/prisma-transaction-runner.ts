import { Inject, Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { TransactionContext, TransactionRunner } from '../../../common/application/ports/transaction-runner';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrismaTransactionRunner implements TransactionRunner {
  private readonly scope = new AsyncLocalStorage<TransactionContext>();
  private readonly clients = new WeakMap<TransactionContext, { client: Prisma.TransactionClient; expiresAt: number }>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  getClient(context: TransactionContext): Prisma.TransactionClient {
    const entry = this.clients.get(context);
    if (!entry || this.scope.getStore() !== context || Date.now() >= entry.expiresAt) {
      throw new Error('Invalid or expired transaction context');
    }
    return entry.client;
  }

  async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    if (this.scope.getStore()) throw new Error('Nested transactions are not supported');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(async client => {
          const context = Object.freeze({}) as TransactionContext;
          this.clients.set(context, { client, expiresAt: Date.now() + 5_000 });
          try {
            return await this.scope.run(context, () => work(context));
          } finally {
            this.clients.delete(context);
          }
        }, { maxWait: 2_000, timeout: 5_000 });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || attempt >= 2) {
          throw error;
        }
        const retryable = error.code === 'P2034' ||
          (error.code === 'P2010' && (error.meta?.code === '40001' || error.meta?.code === '40P01'));
        if (!retryable) throw error;
        await delay(25 * (attempt + 1));
      }
    }
  }
}
