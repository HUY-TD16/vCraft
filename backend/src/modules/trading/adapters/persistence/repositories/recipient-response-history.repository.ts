import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../../../generated/prisma/client';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type {
  PersistedRecipientResponseRecord,
  RecipientEventDto,
} from '../../../application/dtos/trading-persistence.dtos';
import type { IRecipientResponseHistoryRepository } from '../../../application/ports/repositories/trading-repositories.port';
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
