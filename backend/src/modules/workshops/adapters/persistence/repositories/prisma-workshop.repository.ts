import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '../../../../../generated/prisma/client';
import { PrismaService } from '../../../../../infrastructure/database/prisma/prisma.service';
import { PrismaTransactionRunner } from '../../../../../infrastructure/database/transactions/prisma-transaction-runner';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { IWorkshopRepository } from '../../../application/ports/repositories/workshop.repository.port';

@Injectable()
export class PrismaWorkshopRepository implements IWorkshopRepository {
  constructor(
    @Inject(PrismaTransactionRunner) private readonly runner: PrismaTransactionRunner,
    @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService,
  ) {}

  private client(tx?: TransactionContext) {
    if (tx) return this.runner.getClient(tx);
    return this.prisma ?? (this.runner as unknown as { prisma: PrismaService }).prisma;
  }

  async lockAndGetWorkshops(
    ids: bigint[],
    tx: TransactionContext,
  ): Promise<Array<{ id: bigint; status: string }>> {
    const db = this.client(tx);
    if (typeof db.$queryRaw === 'function') {
      return db.$queryRaw<Array<{ id: bigint; status: string }>>`
        SELECT id, status FROM "Workshop" WHERE id IN (${Prisma.join(ids)}) ORDER BY id ASC FOR UPDATE
      `;
    }
    return db.workshop.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
      orderBy: { id: 'asc' },
    });
  }

  async findSummaryById(
    id: bigint,
    tx?: TransactionContext,
  ): Promise<{
    id: bigint;
    name: string;
    status: string;
    address: string | null;
    story: string | null;
    avatar_image_id: bigint | null;
  } | null> {
    return this.client(tx).workshop.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        status: true,
        address: true,
        story: true,
        avatar_image_id: true,
      },
    });
  }

  async getAttachedImageCount(workshopId: bigint, tx?: TransactionContext): Promise<number> {
    return this.client(tx).image.count({
      where: { context_type: 'workshop_profile', context_id: workshopId, is_attached: true },
    });
  }

  async findAccountById(
    accountId: bigint,
    tx: TransactionContext,
  ): Promise<{ id: bigint; role: string } | null> {
    return this.client(tx).account.findUnique({
      where: { id: accountId },
      select: { id: true, role: true },
    });
  }

  async findByAccountId(
    accountId: bigint,
    tx: TransactionContext,
  ): Promise<{ id: bigint } | null> {
    return this.client(tx).workshop.findUnique({
      where: { account_id: accountId },
      select: { id: true },
    });
  }

  async createWorkshop(
    data: {
      accountId: bigint;
      name: string;
      address: string | null;
      story: string | null;
      latitude: number | null;
      longitude: number | null;
    },
    tx: TransactionContext,
  ): Promise<{ id: bigint }> {
    const hasLat = data.latitude !== null && data.latitude !== undefined;
    const hasLng = data.longitude !== null && data.longitude !== undefined;

    const workshop = await this.client(tx).workshop.create({
      data: {
        account_id: data.accountId,
        name: data.name,
        address: data.address,
        story: data.story,
        latitude: hasLat ? new Prisma.Decimal(data.latitude!) : null,
        longitude: hasLng ? new Prisma.Decimal(data.longitude!) : null,
        status: 'active',
        accepting_visitors: false,
      },
      select: { id: true },
    });

    return { id: workshop.id };
  }

  async createStatusLog(
    data: {
      workshopId: bigint;
      prevStatus: string | null;
      newStatus: string;
      performedBy: bigint;
      reason: string;
    },
    tx: TransactionContext,
  ): Promise<void> {
    await this.client(tx).workshopStatusLog.create({
      data: {
        workshop_id: data.workshopId,
        prev_status: data.prevStatus,
        new_status: data.newStatus,
        performed_by: data.performedBy,
        reason: data.reason,
      },
    });
  }

  async findForStatusChange(
    workshopId: bigint,
    tx: TransactionContext,
  ): Promise<{ id: bigint; status: string } | null> {
    const db = this.client(tx);
    if (typeof db.$queryRaw === 'function') {
      const rows = await db.$queryRaw<Array<{ id: bigint; status: string }>>`
        SELECT id, status FROM "Workshop" WHERE id = ${workshopId} FOR UPDATE
      `;
      return rows[0] ?? null;
    }
    return db.workshop.findUnique({
      where: { id: workshopId },
      select: { id: true, status: true },
    });
  }

  async updateStatus(
    workshopId: bigint,
    status: string,
    tx: TransactionContext,
  ): Promise<void> {
    await this.client(tx).workshop.update({
      where: { id: workshopId },
      data: { status },
    });
  }

  async findCertificate(
    certId: bigint,
    tx: TransactionContext,
  ): Promise<{ id: bigint; workshop_id: bigint; image_id: bigint } | null> {
    return this.client(tx).certificate.findUnique({
      where: { id: certId },
      select: { id: true, workshop_id: true, image_id: true },
    });
  }

  async hasProfileImage(
    workshopId: bigint,
    imageId: bigint,
    tx: TransactionContext,
  ): Promise<boolean> {
    const img = await this.client(tx).image.findFirst({
      where: {
        id: imageId,
        context_type: 'workshop_profile',
        context_id: workshopId,
        is_attached: true,
      },
      select: { id: true },
    });
    return img !== null;
  }

  async findManyPublic(params: {
    search?: string;
    accepting_visitors?: boolean;
    skip: number;
    take: number;
  }): Promise<{
    workshops: any[];
    attachedContextIds: Set<string>;
    totalRecords: number;
  }> {
    const db = this.client();
    const where: Prisma.WorkshopWhereInput = {
      status: 'active',
      ...(params.accepting_visitors !== undefined ? { accepting_visitors: params.accepting_visitors } : {}),
      ...(params.search ? { name: { contains: params.search, mode: 'insensitive' } } : {}),
    };

    const totalRecords = await db.workshop.count({ where });
    const workshops = await db.workshop.findMany({
      where,
      skip: params.skip,
      take: params.take,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        name: true,
        address: true,
        avatar_image_id: true,
        latitude: true,
        longitude: true,
        accepting_visitors: true,
        story: true,
        status: true,
      },
    });

    const workshopIds = workshops.map(w => w.id);
    const attachedImages = workshopIds.length > 0
      ? await db.image.findMany({
          where: { context_type: 'workshop_profile', context_id: { in: workshopIds }, is_attached: true },
          select: { context_id: true },
        })
      : [];

    return {
      workshops,
      attachedContextIds: new Set(attachedImages.map(img => String(img.context_id))),
      totalRecords,
    };
  }

  async findDetailById(
    id: bigint,
    includeAccount = false,
  ): Promise<{ workshop: any; images: Array<{ id: bigint }> } | null> {
    const db = this.client();
    const workshop = await db.workshop.findUnique({
      where: { id },
      include: {
        ...(includeAccount
          ? { account: { select: { id: true, username: true, display_name: true, role: true } } }
          : {}),
        certificates: {
          select: { id: true, name: true, image_id: true },
          orderBy: { id: 'asc' },
        },
      },
    });

    if (!workshop) return null;

    const images = await db.image.findMany({
      where: { context_type: 'workshop_profile', context_id: workshop.id, is_attached: true },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    return { workshop, images };
  }

  async findForProfileUpdate(
    id: bigint,
    tx: TransactionContext,
  ): Promise<{ workshop: any; existingImagesCount: number } | null> {
    const db = this.client(tx);
    const workshop = await db.workshop.findUnique({ where: { id } });
    if (!workshop) return null;

    const existingImagesCount = await db.image.count({
      where: { context_type: 'workshop_profile', context_id: workshop.id, is_attached: true },
    });

    return { workshop, existingImagesCount };
  }

  async updateProfileAndAssets(
    data: {
      workshopId: bigint;
      name: string;
      story: string | null;
      address: string | null;
      latitude: number | null;
      longitude: number | null;
      avatarImageId: bigint | null;
      imageIds: bigint[];
      certificates: Array<{ id?: bigint; name: string; imageId: bigint }>;
    },
    tx: TransactionContext,
  ): Promise<void> {
    const db = this.client(tx);
    const hasLat = data.latitude !== null && data.latitude !== undefined;
    const hasLng = data.longitude !== null && data.longitude !== undefined;

    await db.workshop.update({
      where: { id: data.workshopId },
      data: {
        name: data.name,
        story: data.story,
        address: data.address,
        latitude: hasLat ? new Prisma.Decimal(data.latitude!) : null,
        longitude: hasLng ? new Prisma.Decimal(data.longitude!) : null,
        avatar_image_id: data.avatarImageId,
      },
    });

    await db.image.updateMany({
      where: {
        context_type: 'workshop_profile',
        context_id: data.workshopId,
        ...(data.imageIds.length > 0 ? { id: { notIn: data.imageIds } } : {}),
        is_attached: true,
      },
      data: { is_attached: false, unreferenced_at: new Date() },
    });

    if (data.imageIds.length > 0) {
      await db.image.updateMany({
        where: { id: { in: data.imageIds } },
        data: {
          context_type: 'workshop_profile',
          context_id: data.workshopId,
          is_attached: true,
          unreferenced_at: null,
        },
      });
    }

    const incomingCertIds = data.certificates.filter(c => c.id).map(c => c.id!);
    await db.certificate.deleteMany({
      where: {
        workshop_id: data.workshopId,
        id: { notIn: incomingCertIds },
      },
    });

    for (const cert of data.certificates) {
      if (cert.id) {
        await db.certificate.update({
          where: { id: cert.id },
          data: { name: cert.name, image_id: cert.imageId },
        });
      } else {
        await db.certificate.create({
          data: { workshop_id: data.workshopId, name: cert.name, image_id: cert.imageId },
        });
      }
    }
  }

  async updateVisitors(id: bigint, acceptingVisitors: boolean): Promise<boolean> {
    const db = this.client();
    const workshop = await db.workshop.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!workshop) return false;

    await db.workshop.update({
      where: { id },
      data: { accepting_visitors: acceptingVisitors },
    });
    return true;
  }

  async findManyAdmin(params: {
    search?: string;
    status?: string;
    skip: number;
    take: number;
  }): Promise<{
    workshops: any[];
    imagesByWorkshopId: Map<string, Array<{ id: bigint }>>;
    totalRecords: number;
  }> {
    const db = this.client();
    const where: Prisma.WorkshopWhereInput = {
      ...(params.status ? { status: params.status } : {}),
      ...(params.search
        ? {
            OR: [
              { name: { contains: params.search, mode: 'insensitive' } },
              { account: { username: { contains: params.search, mode: 'insensitive' } } },
              ...(Number.isInteger(Number(params.search)) && Number(params.search) > 0
                ? [{ id: BigInt(params.search) }]
                : []),
            ],
          }
        : {}),
    };

    const totalRecords = await db.workshop.count({ where });
    const workshops = await db.workshop.findMany({
      where,
      skip: params.skip,
      take: params.take,
      orderBy: { id: 'asc' },
      include: {
        account: {
          select: { id: true, username: true, display_name: true, role: true },
        },
        certificates: {
          select: { id: true, name: true, image_id: true },
          orderBy: { id: 'asc' },
        },
      },
    });

    const workshopIds = workshops.map(w => w.id);
    const allImages = workshopIds.length > 0
      ? await db.image.findMany({
          where: { context_type: 'workshop_profile', context_id: { in: workshopIds }, is_attached: true },
          select: { id: true, context_id: true },
          orderBy: { id: 'asc' },
        })
      : [];

    const imagesByWorkshopId = new Map<string, Array<{ id: bigint }>>();
    for (const img of allImages) {
      const key = String(img.context_id);
      const list = imagesByWorkshopId.get(key) ?? [];
      list.push({ id: img.id });
      imagesByWorkshopId.set(key, list);
    }

    return { workshops, imagesByWorkshopId, totalRecords };
  }

  async findStatusLogs(
    workshopId: bigint,
    skip: number,
    take: number,
  ): Promise<{ logs: any[]; totalRecords: number; workshopExists: boolean }> {
    const db = this.client();
    const workshopExists = await db.workshop.findUnique({
      where: { id: workshopId },
      select: { id: true },
    });
    if (!workshopExists) {
      return { logs: [], totalRecords: 0, workshopExists: false };
    }

    const totalRecords = await db.workshopStatusLog.count({ where: { workshop_id: workshopId } });
    const logs = await db.workshopStatusLog.findMany({
      where: { workshop_id: workshopId },
      skip,
      take,
      orderBy: { created_at: 'desc' },
      include: {
        performedBy: {
          select: { id: true, display_name: true, username: true },
        },
      },
    });

    return { logs, totalRecords, workshopExists: true };
  }
}
