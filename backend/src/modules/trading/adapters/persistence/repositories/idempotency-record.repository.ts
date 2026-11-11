import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../../../generated/prisma/client';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type {
  CreateIdempotencyRecordInput,
  IdempotencyScopeKey,
  PersistedIdempotencyRecord,
} from '../../../application/dtos/trading-persistence.dtos';
import type { IIdempotencyRecordRepository } from '../../../application/ports/repositories/trading-repositories.port';
import {
  TradingIdempotencyPolicy,
} from '../../../domain';
import { IdempotencyRecordMapper } from '../mappers/idempotency-record.mapper';
import { idToBigInt, parseInstantOrDate } from '../mappers/shared-persistence.mapper';

@Injectable()
export class PrismaIdempotencyRecordRepository
  implements IIdempotencyRecordRepository
{
  constructor(
    @Inject(PrismaTransactionRunner)
    private readonly txRunner: PrismaTransactionRunner,
  ) {}

  async findByScope<TSnapshot = unknown>(
    scope: IdempotencyScopeKey,
    tx: TransactionContext,
    snapshotParser?: (raw: unknown) => TSnapshot,
  ): Promise<PersistedIdempotencyRecord<TSnapshot> | null> {
    const client = this.txRunner.getClient(tx);
    const normalizedKey = IdempotencyRecordMapper.validateKey(
      scope.idempotency_key,
    );

    const row = await client.idempotencyRecord.findUnique({
      where: {
        account_id_action_object_type_object_id_idempotency_key: {
          account_id: idToBigInt(
            scope.account_id,
            'idempotency_record.account_id',
          ),
          action: scope.action.trim(),
          object_type: scope.object_type.trim(),
          object_id: idToBigInt(
            scope.object_id,
            'idempotency_record.object_id',
          ),
          idempotency_key: normalizedKey,
        },
      },
    });

    if (!row) {
      return null;
    }

    return IdempotencyRecordMapper.toDomain(row, snapshotParser);
  }

  async findAndVerifyReplay<TSnapshot = unknown>(
    input: IdempotencyScopeKey & {
      readonly request_fingerprint: string;
    },
    tx: TransactionContext,
    snapshotParser?: (raw: unknown) => TSnapshot,
  ): Promise<PersistedIdempotencyRecord<TSnapshot> | null> {
    const existing = await this.findByScope(input, tx, snapshotParser);
    if (!existing) {
      return null;
    }

    TradingIdempotencyPolicy.assertFingerprintMatches(
      existing.request_fingerprint,
      input.request_fingerprint,
    );

    return existing;
  }

  async save<TSnapshot = unknown>(
    input: CreateIdempotencyRecordInput<TSnapshot>,
    tx: TransactionContext,
    snapshotParser?: (raw: unknown) => TSnapshot,
  ): Promise<PersistedIdempotencyRecord<TSnapshot>> {
    const client = this.txRunner.getClient(tx);
    const data = IdempotencyRecordMapper.toPrismaCreateInput(input);

    try {
      const createdRow = await client.idempotencyRecord.create({
        data,
      });
      return IdempotencyRecordMapper.toDomain(createdRow, snapshotParser);
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.findByScope(
          {
            account_id: input.account_id,
            action: input.action,
            object_type: input.object_type,
            object_id: input.object_id,
            idempotency_key: input.idempotency_key,
          },
          tx,
          snapshotParser,
        );

        if (existing) {
          TradingIdempotencyPolicy.assertFingerprintMatches(
            existing.request_fingerprint,
            input.request_fingerprint,
          );
          return existing;
        }
      }
      throw error;
    }
  }

  async deleteExpiredBefore(
    cutoff: Date,
    tx: TransactionContext,
  ): Promise<number> {
    const client = this.txRunner.getClient(tx);
    const validatedCutoff = parseInstantOrDate(cutoff, 'cutoff');

    const result = await client.idempotencyRecord.deleteMany({
      where: {
        expires_at: {
          lt: validatedCutoff,
        },
      },
    });

    return result.count;
  }
}
