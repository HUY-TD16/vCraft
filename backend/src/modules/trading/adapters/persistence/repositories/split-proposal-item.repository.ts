import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type { ISplitProposalItemRepository } from '../../../application/ports/repositories/trading-repositories.port';
import { EntityId, type SplitProposalItem } from '../../../domain';
import { idToBigInt } from '../mappers/shared-persistence.mapper';
import { SplitProposalItemMapper } from '../mappers/split-proposal-item.mapper';

@Injectable()
export class PrismaSplitProposalItemRepository
  implements ISplitProposalItemRepository
{
  constructor(
    @Inject(PrismaTransactionRunner)
    private readonly txRunner: PrismaTransactionRunner,
  ) {}

  async createMany(
    items: readonly SplitProposalItem[],
    tx: TransactionContext,
  ): Promise<readonly SplitProposalItem[]> {
    const client = this.txRunner.getClient(tx);

    if (items.length === 0) {
      return [];
    }

    const sortedItems = [...items].sort((a, b) =>
      EntityId.compare(a.workshop_id, b.workshop_id),
    );

    const created: SplitProposalItem[] = [];
    for (const item of sortedItems) {
      const row = await client.splitProposalItem.create({
        data: SplitProposalItemMapper.toPrismaCreateInput(item),
      });
      created.push(SplitProposalItemMapper.toDomain(row));
    }

    return created;
  }

  async listByProposalId(
    proposalId: Id,
    tx: TransactionContext,
  ): Promise<readonly SplitProposalItem[]> {
    const client = this.txRunner.getClient(tx);
    const rows = await client.splitProposalItem.findMany({
      where: {
        proposal_id: idToBigInt(proposalId, 'split_proposal_item.proposal_id'),
      },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => SplitProposalItemMapper.toDomain(row));
  }
}
