import { Inject, Injectable, Optional } from '@nestjs/common';
import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type { Id, TrustedActor } from '../../../../common/application/types/contract-types';
import { BusinessRuleException } from '../../../../common/domain/errors/business-rule.exception';
import { WorkshopSuspended } from '../../domain/errors/workshop-suspended';
import { PrismaTransactionRunner } from '../../../../infrastructure/database/transactions/prisma-transaction-runner';
import { PrismaService } from '../../../../infrastructure/database/prisma/prisma.service';
import { Prisma } from '../../../../generated/prisma/client';
import { toBigIntId } from '../../../../common/application/helpers/find-or-throw';
import type {
  IWorkshopContract,
  WorkshopStatus,
  WorkshopSummaryDto,
} from '../../public/contracts/workshop.contract';

@Injectable()
export class WorkshopService implements IWorkshopContract {
  constructor(
    @Inject(PrismaTransactionRunner) private readonly runner: PrismaTransactionRunner,
    @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService,
  ) {}

  private get dbClient(): PrismaService {
    return this.prisma ?? (this.runner as unknown as { prisma: PrismaService }).prisma;
  }

  private async checkProfilePublic(
    client: { image: { count(args: unknown): Promise<number> } },
    workshop: { id: bigint; status: string; name?: string | null; address?: string | null; story?: string | null; avatar_image_id?: bigint | null },
  ): Promise<boolean> {
    if (workshop.status !== 'active') return false;
    if (!workshop.name?.trim() || !workshop.address?.trim() || !workshop.story?.trim()) return false;
    if (workshop.avatar_image_id !== null) return true;
    const attachedCount = await client.image.count({
      where: { context_type: 'workshop_profile', context_id: workshop.id, is_attached: true },
    });
    return attachedCount > 0;
  }

  async lockAndAssertActive(workshopIds: readonly Id[], tx: TransactionContext): Promise<void> {
    if (workshopIds.length === 0) return;
    const sortedIds = Array.from(new Set(workshopIds.map(toBigIntId))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const client = this.runner.getClient(tx);
    const workshops = typeof client.$queryRaw === 'function'
      ? await client.$queryRaw<Array<{ id: bigint; status: string }>>`
          SELECT id, status FROM "Workshop" WHERE id IN (${Prisma.join(sortedIds)}) ORDER BY id ASC FOR UPDATE
        `
      : await client.workshop.findMany({ where: { id: { in: sortedIds } }, select: { id: true, status: true }, orderBy: { id: 'asc' } });

    if (workshops.length !== sortedIds.length) {
      throw new BusinessRuleException('RESOURCE_NOT_FOUND');
    }
    if (workshops.some(w => w.status === 'suspended')) {
      throw new WorkshopSuspended();
    }
  }

  async getWorkshopSummary(workshopId: Id): Promise<WorkshopSummaryDto | null> {
    let id: bigint;
    try {
      id = toBigIntId(workshopId);
    } catch {
      return null;
    }

    const workshop = await this.dbClient.workshop.findUnique({
      where: { id },
      select: { id: true, name: true, status: true, address: true, story: true, avatar_image_id: true },
    });
    if (!workshop) return null;

    const isProfilePublic = await this.checkProfilePublic(this.dbClient, workshop);
    return {
      id: String(workshop.id),
      name: workshop.name,
      status: workshop.status as WorkshopStatus,
      isProfilePublic,
    };
  }

  async createWorkshop(
    input: {
      accountId: Id;
      name: string;
      address: string | null;
      story: string | null;
      latitude: number | null;
      longitude: number | null;
      actor: TrustedActor;
    },
    tx: TransactionContext,
  ): Promise<{ workshopId: Id }> {
    if (input.actor.role !== 'admin') throw new BusinessRuleException('PERMISSION_DENIED');
    const name = input.name?.trim();
    if (!name || name.length > 200) throw new BusinessRuleException('INVALID_INPUT');
    const address = input.address?.trim() || null;
    if (address && address.length > 500) throw new BusinessRuleException('INVALID_INPUT');

    const hasLat = input.latitude !== null && input.latitude !== undefined;
    const hasLng = input.longitude !== null && input.longitude !== undefined;
    if (hasLat !== hasLng) throw new BusinessRuleException('INVALID_INPUT');
    if (hasLat && (input.latitude! < -90 || input.latitude! > 90 || input.longitude! < -180 || input.longitude! > 180)) {
      throw new BusinessRuleException('INVALID_INPUT');
    }

    const accountId = toBigIntId(input.accountId);
    const client = this.runner.getClient(tx);

    const account = await client.account.findUnique({ where: { id: accountId }, select: { role: true } });
    if (!account || account.role !== 'artisan') throw new BusinessRuleException('INVALID_INPUT');

    if (await client.workshop.findUnique({ where: { account_id: accountId }, select: { id: true } })) {
      throw new BusinessRuleException('INVALID_INPUT');
    }

    const workshop = await client.workshop.create({
      data: {
        account_id: accountId,
        name,
        address,
        story: input.story?.trim() || null,
        latitude: hasLat ? new Prisma.Decimal(input.latitude!) : null,
        longitude: hasLng ? new Prisma.Decimal(input.longitude!) : null,
        status: 'active',
        accepting_visitors: false,
      },
    });

    await client.workshopStatusLog.create({
      data: {
        workshop_id: workshop.id,
        prev_status: null,
        new_status: 'active',
        performed_by: toBigIntId(input.actor.accountId),
        reason: 'Khởi tạo hộ sản xuất',
      },
    });

    return { workshopId: String(workshop.id) };
  }

  async changeStatus(
    input: {
      workshopId: Id;
      status: WorkshopStatus;
      reason: string;
      actor: TrustedActor;
    },
    tx: TransactionContext,
  ): Promise<{ workshopId: Id; status: WorkshopStatus; changed: boolean }> {
    if (input.actor.role !== 'admin') throw new BusinessRuleException('PERMISSION_DENIED');
    if (input.status !== 'active' && input.status !== 'suspended') throw new BusinessRuleException('INVALID_INPUT');
    const reason = input.reason?.trim();
    if (!reason) throw new BusinessRuleException('INVALID_INPUT');

    const workshopId = toBigIntId(input.workshopId);
    const client = this.runner.getClient(tx);

    const workshop = typeof client.$queryRaw === 'function'
      ? (await client.$queryRaw<Array<{ id: bigint; status: string }>>`SELECT id, status FROM "Workshop" WHERE id = ${workshopId} FOR UPDATE`)[0] ?? null
      : await client.workshop.findUnique({ where: { id: workshopId }, select: { id: true, status: true } });

    if (!workshop) throw new BusinessRuleException('RESOURCE_NOT_FOUND');
    if (workshop.status === input.status) {
      return { workshopId: String(workshop.id), status: workshop.status as WorkshopStatus, changed: false };
    }

    await client.workshop.update({ where: { id: workshopId }, data: { status: input.status } });
    await client.workshopStatusLog.create({
      data: {
        workshop_id: workshopId,
        prev_status: workshop.status,
        new_status: input.status,
        performed_by: toBigIntId(input.actor.accountId),
        reason,
      },
    });

    return { workshopId: String(workshop.id), status: input.status, changed: true };
  }

  async getProfileImageAccess(
    input: {
      workshopId: Id;
      imageId: Id;
      certificateId: Id | null;
      actorOrNull: TrustedActor | null;
    },
    tx: TransactionContext,
  ): Promise<{ canRead: boolean }> {
    let workshopId: bigint;
    let imageId: bigint;
    try {
      workshopId = toBigIntId(input.workshopId);
      imageId = toBigIntId(input.imageId);
    } catch {
      return { canRead: false };
    }

    const client = this.runner.getClient(tx);
    const workshop = await client.workshop.findUnique({
      where: { id: workshopId },
      select: { id: true, name: true, status: true, address: true, story: true, avatar_image_id: true },
    });
    if (!workshop) return { canRead: false };

    if (input.certificateId !== null) {
      let certId: bigint;
      try {
        certId = toBigIntId(input.certificateId);
      } catch {
        return { canRead: false };
      }
      const cert = await client.certificate.findUnique({
        where: { id: certId },
        select: { id: true, workshop_id: true, image_id: true },
      });
      if (!cert || cert.workshop_id !== workshop.id || cert.image_id !== imageId) {
        return { canRead: false };
      }
    } else {
      const isAvatar = workshop.avatar_image_id === imageId;
      const isProfileImage = isAvatar || (await client.image.findFirst({
        where: { id: imageId, context_type: 'workshop_profile', context_id: workshop.id, is_attached: true },
        select: { id: true },
      })) !== null;
      if (!isProfileImage) return { canRead: false };
    }

    if (await this.checkProfilePublic(client, workshop)) return { canRead: true };

    const actor = input.actorOrNull;
    if (!actor) return { canRead: false };
    if (actor.role === 'admin') return { canRead: true };
    if (actor.role === 'artisan' && actor.workshopId && String(actor.workshopId) === String(workshop.id)) {
      return { canRead: true };
    }
    return { canRead: false };
  }
}
