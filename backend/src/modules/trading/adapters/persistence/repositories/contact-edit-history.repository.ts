import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import type { Prisma } from '../../../../../generated/prisma/client';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type {
  ContactEventDto,
  PersistedContactEditRecord,
} from '../../../application/dtos/trading-persistence.dtos';
import type {
  FindContactEventsInput,
  FindContactEventsResult,
  IContactEditHistoryRepository,
} from '../../../application/ports/repositories/trading-repositories.port';
import type { ContactEditRecord } from '../../../domain';
import { ContactEditHistoryMapper } from '../mappers/contact-edit-history.mapper';
import { idToBigInt } from '../mappers/shared-persistence.mapper';

@Injectable()
export class PrismaContactEditHistoryRepository
  implements IContactEditHistoryRepository
{
  constructor(
    @Inject(PrismaTransactionRunner)
    private readonly txRunner: PrismaTransactionRunner,
  ) {}

  async create(
    record: ContactEditRecord & { readonly id?: Id },
    tx: TransactionContext,
  ): Promise<PersistedContactEditRecord> {
    const client = this.txRunner.getClient(tx);
    const createdRow = await client.contactEditHistory.create({
      data: ContactEditHistoryMapper.toPrismaCreateInput(record),
    });
    return ContactEditHistoryMapper.toDomain(createdRow);
  }

  async listByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly PersistedContactEditRecord[]> {
    const client = this.txRunner.getClient(tx);
    const rows = await client.contactEditHistory.findMany({
      where: {
        request_id: idToBigInt(requestId, 'contact_edit_history.request_id'),
      },
      orderBy: [{ edited_at: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => ContactEditHistoryMapper.toDomain(row));
  }

  async listEventsByRequestId(
    requestId: Id,
    tx: TransactionContext,
  ): Promise<readonly ContactEventDto[]> {
    const client = this.txRunner.getClient(tx);
    const rows = await client.contactEditHistory.findMany({
      where: {
        request_id: idToBigInt(requestId, 'contact_edit_history.request_id'),
      },
      include: {
        editedBy: {
          select: {
            id: true,
            display_name: true,
          },
        },
      },
      orderBy: [{ edited_at: 'asc' }, { id: 'asc' }],
    });

    return rows.map((row) =>
      ContactEditHistoryMapper.fromPrismaWithActorToDto(row),
    );
  }

  async findEventsWithPagination(
    input: FindContactEventsInput,
    tx?: TransactionContext,
  ): Promise<FindContactEventsResult> {
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
    input: FindContactEventsInput,
  ): Promise<FindContactEventsResult> {
    const requestIdBigInt = idToBigInt(
      input.requestId,
      'contact_edit_history.request_id',
    );
    const page = input.page && input.page > 0 ? input.page : 1;
    const limit = input.limit && input.limit > 0 ? input.limit : 20;
    const skip = (page - 1) * limit;
    const take = limit;

    const where = {
      request_id: requestIdBigInt,
    };

    const [totalRecords, rows] = await Promise.all([
      client.contactEditHistory.count({ where }),
      client.contactEditHistory.findMany({
        where,
        include: {
          editedBy: {
            select: {
              id: true,
              display_name: true,
            },
          },
        },
        orderBy: [{ edited_at: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
    ]);

    return {
      rows: rows.map((row) =>
        ContactEditHistoryMapper.fromPrismaWithActorToDto(row),
      ),
      totalRecords,
    };
  }
}
