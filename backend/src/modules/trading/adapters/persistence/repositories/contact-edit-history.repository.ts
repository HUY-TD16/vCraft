import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type {
  ContactEventDto,
  PersistedContactEditRecord,
} from '../../../application/dtos/trading-persistence.dtos';
import type { IContactEditHistoryRepository } from '../../../application/ports/repositories/trading-repositories.port';
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
}
