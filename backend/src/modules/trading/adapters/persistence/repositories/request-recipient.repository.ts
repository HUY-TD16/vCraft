import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../../../generated/prisma/client';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type { IRequestRecipientRepository } from '../../../application/ports/repositories/trading-repositories.port';
import {
  ConcurrencyConflictError,
  EntityId,
  type RecipientResponseRecord,
  type RequestRecipient,
  TRADING_INVARIANTS,
} from '../../../domain';
import { RecipientResponseHistoryMapper } from '../mappers/recipient-response-history.mapper';
import { RequestRecipientMapper } from '../mappers/request-recipient.mapper';
import { idToBigInt } from '../mappers/shared-persistence.mapper';

@Injectable()
export class PrismaRequestRecipientRepository
  implements IRequestRecipientRepository
{
  constructor(
    @Inject(PrismaTransactionRunner)
    private readonly txRunner: PrismaTransactionRunner,
  ) {}

  async createMany(
    recipients: readonly {
      readonly id?: Id;
      readonly request_id: Id;
      readonly workshop_id: Id;
      readonly sent_at: Date;
    }[],
    tx: TransactionContext,
  ): Promise<readonly RequestRecipient[]> {
    const client = this.txRunner.getClient(tx);

    if (recipients.length === 0) {
      return [];
    }

    const sortedInputs = [...recipients].sort((a, b) =>
      EntityId.compare(a.workshop_id, b.workshop_id),
    );

    const created: RequestRecipient[] = [];
    for (const item of sortedInputs) {
      const row = await client.requestRecipient.create({
        data: RequestRecipientMapper.toPrismaCreateInput({
          id: item.id,
          request_id: item.request_id,
          workshop_id: item.workshop_id,
          response_status: 'pending',
          sent_at: item.sent_at,
          version: 1,
        }),
      });
      created.push(RequestRecipientMapper.toDomain(row));
    }

    return created;
  }

  async update(
    input: {
      readonly recipient: RequestRecipient;
      readonly expectedVersion?: number;
      readonly history?: RecipientResponseRecord;
    },
    tx: TransactionContext,
  ): Promise<RequestRecipient> {
    const client = this.txRunner.getClient(tx);
    const recipientIdBigInt = idToBigInt(
      input.recipient.id,
      'request_recipient.id',
    );
    const expectedVersion =
      input.expectedVersion ?? input.recipient.version - 1;

    if (expectedVersion < 1) {
      throw new ConcurrencyConflictError(
        `Invalid expectedVersion (${expectedVersion}) when updating RequestRecipient ${input.recipient.id}.`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'RequestRecipient',
        },
      );
    }

    const updateResult = await client.requestRecipient.updateMany({
      where: {
        id: recipientIdBigInt,
        version: expectedVersion,
      },
      data: RequestRecipientMapper.toPrismaUpdateInput(input.recipient),
    });

    if (updateResult.count !== 1) {
      throw new ConcurrencyConflictError(
        `RequestRecipient ${input.recipient.id} version conflict (expected version ${expectedVersion}).`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'RequestRecipient',
        },
      );
    }

    if (input.history) {
      await client.recipientResponseHistory.create({
        data: RecipientResponseHistoryMapper.toPrismaCreateInput(
          input.history,
          Prisma.DbNull,
        ),
      });
    }

    const updatedRow = await client.requestRecipient.findUnique({
      where: { id: recipientIdBigInt },
    });

    if (!updatedRow) {
      throw new ConcurrencyConflictError(
        `RequestRecipient ${input.recipient.id} was not found after update.`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'RequestRecipient',
        },
      );
    }

    return RequestRecipientMapper.toDomain(updatedRow);
  }

  async findById(
    recipientId: Id,
    tx: TransactionContext,
  ): Promise<RequestRecipient | null> {
    const client = this.txRunner.getClient(tx);
    const row = await client.requestRecipient.findUnique({
      where: { id: idToBigInt(recipientId, 'request_recipient.id') },
    });
    return row ? RequestRecipientMapper.toDomain(row) : null;
  }

  async findByRequestAndWorkshop(
    requestId: Id,
    workshopId: Id,
    tx: TransactionContext,
  ): Promise<RequestRecipient | null> {
    const client = this.txRunner.getClient(tx);
    const row = await client.requestRecipient.findUnique({
      where: {
        request_id_workshop_id: {
          request_id: idToBigInt(requestId, 'request_recipient.request_id'),
          workshop_id: idToBigInt(workshopId, 'request_recipient.workshop_id'),
        },
      },
    });
    return row ? RequestRecipientMapper.toDomain(row) : null;
  }

  async listByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly RequestRecipient[]> {
    const client = this.txRunner.getClient(tx);
    const rows = await client.requestRecipient.findMany({
      where: {
        request_id: idToBigInt(requestId, 'request_recipient.request_id'),
      },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => RequestRecipientMapper.toDomain(row));
  }

  async lockById(
    recipientId: Id,
    tx: TransactionContext,
  ): Promise<RequestRecipient | null> {
    const client = this.txRunner.getClient(tx);
    const idBigInt = idToBigInt(recipientId, 'request_recipient.id');

    const lockedRows = await client.$queryRaw<Array<{ id: bigint }>>(
      Prisma.sql`SELECT "id" FROM "RequestRecipient" WHERE "id" = ${idBigInt} FOR UPDATE`,
    );

    if (lockedRows.length === 0) {
      return null;
    }

    const row = await client.requestRecipient.findUnique({
      where: { id: idBigInt },
    });
    return row ? RequestRecipientMapper.toDomain(row) : null;
  }

  async lockByRequestAndWorkshop(
    requestId: Id,
    workshopId: Id,
    tx: TransactionContext,
  ): Promise<RequestRecipient | null> {
    const client = this.txRunner.getClient(tx);
    const reqBigInt = idToBigInt(requestId, 'request_recipient.request_id');
    const wsBigInt = idToBigInt(workshopId, 'request_recipient.workshop_id');

    const lockedRows = await client.$queryRaw<Array<{ id: bigint }>>(
      Prisma.sql`SELECT "id" FROM "RequestRecipient" WHERE "request_id" = ${reqBigInt} AND "workshop_id" = ${wsBigInt} ORDER BY "id" ASC FOR UPDATE`,
    );

    if (lockedRows.length === 0) {
      return null;
    }

    const row = await client.requestRecipient.findUnique({
      where: { id: lockedRows[0].id },
    });
    return row ? RequestRecipientMapper.toDomain(row) : null;
  }

  async lockByIds(
    recipientIds: readonly Id[],
    tx: TransactionContext,
  ): Promise<readonly RequestRecipient[]> {
    const client = this.txRunner.getClient(tx);
    const uniqueSortedIds = EntityId.sortAscending(
      Array.from(new Set(recipientIds)),
    );

    if (uniqueSortedIds.length === 0) {
      return [];
    }

    const idBigInts = uniqueSortedIds.map((id) =>
      idToBigInt(id, 'request_recipient.id'),
    );

    const lockedRows = await client.$queryRaw<Array<{ id: bigint }>>(
      Prisma.sql`SELECT "id" FROM "RequestRecipient" WHERE "id" IN (${Prisma.join(idBigInts)}) ORDER BY "id" ASC FOR UPDATE`,
    );

    if (lockedRows.length === 0) {
      return [];
    }

    const rows = await client.requestRecipient.findMany({
      where: { id: { in: lockedRows.map((r) => r.id) } },
      orderBy: { id: 'asc' },
    });

    return rows.map((row) => RequestRecipientMapper.toDomain(row));
  }
}
