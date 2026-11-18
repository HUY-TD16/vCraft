import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../../../generated/prisma/client';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { PAGINATION } from '../../../../../common/application/types/pagination';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type {
  PersistedRecipientResponseRecord,
  RecipientEventDto,
} from '../../../application/dtos/trading-persistence.dtos';
import type {
  FindRecipientResponseEventsInput,
  FindRecipientResponseEventsResult,
  IRecipientResponseHistoryRepository,
} from '../../../application/ports/repositories/trading-repositories.port';
import {
  type QuoteSnapshotData,
  type RecipientResponseRecord,
  Version,
} from '../../../domain';
import { RecipientResponseHistoryMapper } from '../mappers/recipient-response-history.mapper';
import { idToBigInt } from '../mappers/shared-persistence.mapper';

@Injectable()
export class PrismaRecipientResponseHistoryRepository
  implements IRecipientResponseHistoryRepository
{
  constructor(
    @Inject(PrismaTransactionRunner)
    private readonly txRunner: PrismaTransactionRunner,
  ) {}

  async create(
    record: RecipientResponseRecord & { readonly id?: Id },
    tx: TransactionContext,
  ): Promise<PersistedRecipientResponseRecord> {
    const client = this.txRunner.getClient(tx);
    const createdRow = await client.recipientResponseHistory.create({
      data: RecipientResponseHistoryMapper.toPrismaCreateInput(
        record,
        Prisma.DbNull,
      ),
    });
    return RecipientResponseHistoryMapper.toDomain(createdRow);
  }

  async listByRecipientId(
    recipientId: Id,
    tx: TransactionContext,
  ): Promise<readonly PersistedRecipientResponseRecord[]> {
    const client = this.txRunner.getClient(tx);
    const rows = await client.recipientResponseHistory.findMany({
      where: {
        recipient_id: idToBigInt(
          recipientId,
          'recipient_response_history.recipient_id',
        ),
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => RecipientResponseHistoryMapper.toDomain(row));
  }

  async listEventsByRecipientId(
    recipientId: Id,
    tx: TransactionContext,
  ): Promise<readonly RecipientEventDto[]> {
    const client = this.txRunner.getClient(tx);
    const rows = await client.recipientResponseHistory.findMany({
      where: {
        recipient_id: idToBigInt(
          recipientId,
          'recipient_response_history.recipient_id',
        ),
      },
      include: {
        performedBy: {
          select: {
            id: true,
            display_name: true,
          },
        },
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });

    return rows.map((row) =>
      RecipientResponseHistoryMapper.fromPrismaWithActorToDto(row),
    );
  }

  async findEventsWithPagination(
    input: FindRecipientResponseEventsInput,
    tx?: TransactionContext,
  ): Promise<FindRecipientResponseEventsResult> {
    if (tx) {
      return this.executeFindEventsWithPagination(
        this.txRunner.getClient(tx),
        input,
      );
    }
    return this.txRunner.run(async (innerTx) => {
      return this.executeFindEventsWithPagination(
        this.txRunner.getClient(innerTx),
        input,
      );
    });
  }

  private async executeFindEventsWithPagination(
    client: Prisma.TransactionClient,
    input: FindRecipientResponseEventsInput,
  ): Promise<FindRecipientResponseEventsResult> {
    const recipientIdBigInt = idToBigInt(
      input.recipientId,
      'recipient_response_history.recipient_id',
    );
    const page =
      input.page && Number.isSafeInteger(input.page) && input.page > 0
        ? input.page
        : PAGINATION.defaultPage;
    const limit =
      input.limit && Number.isSafeInteger(input.limit) && input.limit > 0
        ? Math.min(input.limit, PAGINATION.maxLimit)
        : PAGINATION.defaultLimit;
    const skip = (page - 1) * limit;
    const take = limit;

    const where = {
      recipient_id: recipientIdBigInt,
    };

    const [totalRecords, rows] = await Promise.all([
      client.recipientResponseHistory.count({ where }),
      client.recipientResponseHistory.findMany({
        where,
        include: {
          performedBy: {
            select: {
              id: true,
              display_name: true,
            },
          },
        },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
    ]);

    return {
      rows: rows.map((row) =>
        RecipientResponseHistoryMapper.fromPrismaWithActorToDto(row),
      ),
      totalRecords,
    };
  }

  async findSnapshotByQuoteVersion(
    quoteId: Id,
    quoteVersion: number,
    tx: TransactionContext,
  ): Promise<QuoteSnapshotData | null> {
    const client = this.txRunner.getClient(tx);
    const validatedVersion = Version.of(quoteVersion, 'quote_version').value;

    const rows = await client.recipientResponseHistory.findMany({
      where: {
        quote_id: idToBigInt(quoteId, 'recipient_response_history.quote_id'),
      },
      orderBy: { id: 'desc' },
    });

    for (const row of rows) {
      if (row.quote_snapshot !== null && row.quote_snapshot !== undefined) {
        const snapshot =
          RecipientResponseHistoryMapper.toQuoteSnapshotDomain(
            row.quote_snapshot,
          );
        if (snapshot && snapshot.version === validatedVersion) {
          return snapshot;
        }
      }
    }

    return null;
  }
}
