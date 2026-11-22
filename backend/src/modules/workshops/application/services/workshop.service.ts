import { Inject, Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type { AuthenticatedActor, Id, TrustedActor } from '../../../../common/application/types/contract-types';
import { BusinessRuleException } from '../../../../common/domain/errors/business-rule.exception';
import { WorkshopSuspended } from '../../domain/errors/workshop-suspended';
import { WorkshopProfileRules } from '../../domain/entities/workshop.entity';
import { PrismaTransactionRunner } from '../../../../infrastructure/database/transactions/prisma-transaction-runner';
import { toBigIntId } from '../../../../common/application/helpers/find-or-throw';
import { HttpResult } from '../../../../common/http/interceptors/response-envelope.interceptor';
import { toPrismaOffset, type PaginationParams } from '../../../../common/application/types/pagination';
import type {
  IWorkshopContract,
  WorkshopStatus,
  WorkshopSummaryDto,
} from '../../public/contracts/workshop.contract';
import type {
  ChangeWorkshopStatusDto,
  ListAdminWorkshopsQueryDto,
  ListPublicWorkshopsQueryDto,
  UpdateWorkshopProfileDto,
  UpdateWorkshopVisitorsDto,
} from '../../adapters/http/dtos/workshop.dto';
import {
  toPublicWorkshopSummaryDto,
  toPublicWorkshopDto,
  toOwnWorkshopDto,
  toAdminWorkshopDto,
  toStatusEventDto,
  type AdminWorkshopDto,
  type OwnWorkshopDto,
  type PublicWorkshopDto,
  type PublicWorkshopSummaryDto,
  type WorkshopStatusEventDto,
} from '../../adapters/http/mappers/workshop.mapper';
import {
  WORKSHOP_REPOSITORY,
  type IWorkshopRepository,
} from '../ports/repositories/workshop.repository.port';

@Injectable()
export class WorkshopService implements IWorkshopContract {
  constructor(
    @Inject(WORKSHOP_REPOSITORY) private readonly workshopRepo: IWorkshopRepository,
    @Inject(PrismaTransactionRunner) private readonly runner: PrismaTransactionRunner,
  ) {}

  async lockAndAssertActive(workshopIds: readonly Id[], tx: TransactionContext): Promise<void> {
    if (workshopIds.length === 0) return;

    const uniqueBigInts = Array.from(new Set(workshopIds.map(toBigIntId))).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );

    const workshops = await this.workshopRepo.lockAndGetWorkshops(uniqueBigInts, tx);

    if (workshops.length !== uniqueBigInts.length) {
      throw new BusinessRuleException('RESOURCE_NOT_FOUND', 'Workshop not found.');
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

    const workshop = await this.workshopRepo.findSummaryById(id);
    if (!workshop) return null;

    const attachedCount = workshop.avatar_image_id !== null
      ? 1
      : await this.workshopRepo.getAttachedImageCount(id);

    const { isPublic } = WorkshopProfileRules.evaluateProfilePublicity(workshop, attachedCount);

    return {
      id: String(workshop.id),
      name: workshop.name,
      status: workshop.status as WorkshopStatus,
      isProfilePublic: isPublic,
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
    if (input.actor.role !== 'admin') {
      throw new BusinessRuleException('PERMISSION_DENIED', 'Only admin can create workshop.');
    }

    const name = input.name?.trim();
    if (!name || name.length > 200) {
      throw new BusinessRuleException('INVALID_INPUT', 'Workshop name is required and must not exceed 200 characters.');
    }

    const address = input.address?.trim() || null;
    if (address && address.length > 500) {
      throw new BusinessRuleException('INVALID_INPUT', 'Address must not exceed 500 characters.');
    }

    const story = input.story?.trim() || null;
    if (!WorkshopProfileRules.validateCoordinates(input.latitude, input.longitude)) {
      throw new BusinessRuleException('INVALID_INPUT', 'Coordinates out of bounds or invalid pair.');
    }

    const accountId = toBigIntId(input.accountId);
    const account = await this.workshopRepo.findAccountById(accountId, tx);
    if (!account || account.role !== 'artisan') {
      throw new BusinessRuleException('INVALID_INPUT', 'Account must be an artisan.');
    }

    const existingWorkshop = await this.workshopRepo.findByAccountId(accountId, tx);
    if (existingWorkshop) {
      throw new BusinessRuleException('INVALID_INPUT', 'Account already has a workshop.');
    }

    const { id } = await this.workshopRepo.createWorkshop(
      {
        accountId,
        name,
        address,
        story,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
      },
      tx,
    );

    await this.workshopRepo.createStatusLog(
      {
        workshopId: id,
        prevStatus: null,
        newStatus: 'active',
        performedBy: toBigIntId(input.actor.accountId),
        reason: 'Khởi tạo hộ sản xuất',
      },
      tx,
    );

    return { workshopId: String(id) };
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
    if (input.actor.role !== 'admin') {
      throw new BusinessRuleException('PERMISSION_DENIED', 'Only admin can change workshop status.');
    }

    if (input.status !== 'active' && input.status !== 'suspended') {
      throw new BusinessRuleException('INVALID_INPUT', 'Invalid status.');
    }

    const reason = input.reason?.trim();
    if (!reason) {
      throw new BusinessRuleException('INVALID_INPUT', 'Reason is required.');
    }

    const workshopId = toBigIntId(input.workshopId);
    const workshop = await this.workshopRepo.findForStatusChange(workshopId, tx);

    if (!workshop) {
      throw new BusinessRuleException('RESOURCE_NOT_FOUND', 'Workshop not found.');
    }

    if (workshop.status === input.status) {
      return {
        workshopId: String(workshop.id),
        status: workshop.status as WorkshopStatus,
        changed: false,
      };
    }

    await this.workshopRepo.updateStatus(workshopId, input.status, tx);

    await this.workshopRepo.createStatusLog(
      {
        workshopId,
        prevStatus: workshop.status,
        newStatus: input.status,
        performedBy: toBigIntId(input.actor.accountId),
        reason,
      },
      tx,
    );

    return {
      workshopId: String(workshop.id),
      status: input.status,
      changed: true,
    };
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

    const workshop = await this.workshopRepo.findForImageAccess(workshopId, tx);
    if (!workshop) return { canRead: false };

    if (input.certificateId !== null) {
      let certId: bigint;
      try {
        certId = toBigIntId(input.certificateId);
      } catch {
        return { canRead: false };
      }

      const cert = await this.workshopRepo.findCertificate(certId, tx);
      if (!cert || cert.workshop_id !== workshop.id || cert.image_id !== imageId) {
        return { canRead: false };
      }
    } else {
      const isAvatar = workshop.avatar_image_id === imageId;
      const isProfileImage = isAvatar || (await this.workshopRepo.hasProfileImage(workshop.id, imageId, tx));
      if (!isProfileImage) return { canRead: false };
    }

    const count = workshop.avatar_image_id !== null
      ? 1
      : await this.workshopRepo.getAttachedImageCount(workshop.id, tx);

    const { isPublic } = WorkshopProfileRules.evaluateProfilePublicity(workshop, count);
    if (isPublic) return { canRead: true };

    const actor = input.actorOrNull;
    if (!actor) return { canRead: false };
    if (actor.role === 'admin') return { canRead: true };
    if (actor.role === 'artisan' && actor.workshopId && String(actor.workshopId) === String(workshop.id)) {
      return { canRead: true };
    }

    return { canRead: false };
  }

  async listPublicWorkshops(query: ListPublicWorkshopsQueryDto): Promise<HttpResult<readonly PublicWorkshopSummaryDto[]>> {
    const { skip, take } = toPrismaOffset(query);

    const { workshops, attachedContextIds, totalRecords } = await this.workshopRepo.findManyPublic({
      search: query.search,
      accepting_visitors: query.accepting_visitors,
      skip,
      take,
    });

    const summaries = workshops
      .filter(w => {
        const hasImage = w.avatar_image_id !== null || attachedContextIds.has(String(w.id));
        return WorkshopProfileRules.evaluateProfilePublicity(w, hasImage ? 1 : 0).isPublic;
      })
      .map(toPublicWorkshopSummaryDto);

    return HttpResult.paginated(summaries, totalRecords, { page: query.page, limit: query.limit });
  }

  async getPublicWorkshopDetail(id: string): Promise<PublicWorkshopDto> {
    const workshopId = toBigIntId(id);
    const detail = await this.workshopRepo.findPublicDetail(workshopId);

    if (!detail || detail.workshop.status !== 'active') {
      throw new BusinessRuleException('RESOURCE_NOT_FOUND', 'Workshop not found.');
    }

    const { isPublic } = WorkshopProfileRules.evaluateProfilePublicity(detail.workshop, detail.images.length);
    if (!isPublic) {
      throw new BusinessRuleException('RESOURCE_NOT_FOUND', 'Workshop not found.');
    }

    return toPublicWorkshopDto(detail.workshop, detail.images);
  }

  async getOwnWorkshop(actor: AuthenticatedActor): Promise<OwnWorkshopDto> {
    if (!actor.workshopId) {
      throw new BusinessRuleException('RESOURCE_NOT_FOUND', 'Workshop not found.');
    }

    const workshopId = toBigIntId(actor.workshopId);
    const detail = await this.workshopRepo.findOwnDetail(workshopId);

    if (!detail) {
      throw new BusinessRuleException('RESOURCE_NOT_FOUND', 'Workshop not found.');
    }

    const { isPublic, missingFields } = WorkshopProfileRules.evaluateProfilePublicity(detail.workshop, detail.images.length);
    return toOwnWorkshopDto(detail.workshop, detail.images, isPublic, missingFields);
  }

  async updateOwnWorkshop(actor: AuthenticatedActor, dto: UpdateWorkshopProfileDto): Promise<OwnWorkshopDto> {
    if (!actor.workshopId) {
      throw new BusinessRuleException('RESOURCE_NOT_FOUND', 'Workshop not found.');
    }

    const workshopId = toBigIntId(actor.workshopId);

    return this.runner.run(async tx => {
      const updateData = await this.workshopRepo.findForProfileUpdate(workshopId, tx);
      if (!updateData) {
        throw new BusinessRuleException('RESOURCE_NOT_FOUND', 'Workshop not found.');
      }

      const wasPublic = WorkshopProfileRules.evaluateProfilePublicity(
        updateData.workshop,
        updateData.existingImagesCount,
      ).isPublic;

      const newImageCount = dto.image_ids.length;
      const avatarId = dto.avatar_image_id ? toBigIntId(dto.avatar_image_id) : null;
      const totalImages = (avatarId ? 1 : 0) + newImageCount;

      if (wasPublic && (!dto.name?.trim() || !dto.address?.trim() || !dto.story?.trim() || totalImages === 0)) {
        throw new BusinessRuleException(
          'INVALID_INPUT',
          'Cannot remove required fields from an already public profile.',
        );
      }

      const imageIds = dto.image_ids.map(toBigIntId);
      const certificates = dto.certificates.map(c => ({
        id: c.id ? toBigIntId(c.id) : undefined,
        name: c.name.trim(),
        imageId: toBigIntId(c.image_id),
      }));

      await this.workshopRepo.updateProfileAndAssets(
        {
          workshopId,
          name: dto.name.trim(),
          story: dto.story?.trim() || null,
          address: dto.address?.trim() || null,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          avatarImageId: avatarId,
          imageIds,
          certificates,
        },
        tx,
      );

      return this.getOwnWorkshop(actor);
    });
  }

  async updateVisitors(
    actor: AuthenticatedActor,
    dto: UpdateWorkshopVisitorsDto,
  ): Promise<{ accepting_visitors: boolean }> {
    if (!actor.workshopId) {
      throw new BusinessRuleException('RESOURCE_NOT_FOUND', 'Workshop not found.');
    }

    const workshopId = toBigIntId(actor.workshopId);
    const updated = await this.workshopRepo.updateVisitors(workshopId, dto.accepting_visitors);

    if (!updated) {
      throw new BusinessRuleException('RESOURCE_NOT_FOUND', 'Workshop not found.');
    }

    return { accepting_visitors: dto.accepting_visitors };
  }

  async listAdminWorkshops(query: ListAdminWorkshopsQueryDto): Promise<HttpResult<readonly AdminWorkshopDto[]>> {
    const { skip, take } = toPrismaOffset(query);

    const { workshops, imagesByWorkshopId, totalRecords } = await this.workshopRepo.findManyAdmin({
      search: query.search,
      status: query.status,
      skip,
      take,
    });

    const dtos = workshops.map(w => {
      const images = imagesByWorkshopId.get(String(w.id)) ?? [];
      const { isPublic, missingFields } = WorkshopProfileRules.evaluateProfilePublicity(w, images.length);
      return toAdminWorkshopDto(w, images, isPublic, missingFields);
    });

    return HttpResult.paginated(dtos, totalRecords, { page: query.page, limit: query.limit });
  }

  async getAdminWorkshop(id: string): Promise<AdminWorkshopDto> {
    const workshopId = toBigIntId(id);
    const detail = await this.workshopRepo.findAdminDetail(workshopId);

    if (!detail) {
      throw new BusinessRuleException('RESOURCE_NOT_FOUND', 'Workshop not found.');
    }

    const { isPublic, missingFields } = WorkshopProfileRules.evaluateProfilePublicity(detail.workshop, detail.images.length);
    return toAdminWorkshopDto(detail.workshop, detail.images, isPublic, missingFields);
  }

  async getWorkshopStatusHistory(id: string, params: PaginationParams): Promise<HttpResult<readonly WorkshopStatusEventDto[]>> {
    const workshopId = toBigIntId(id);
    const { skip, take } = toPrismaOffset(params);

    const { logs, totalRecords, workshopExists } = await this.workshopRepo.findStatusLogs(workshopId, skip, take);
    if (!workshopExists) {
      throw new BusinessRuleException('RESOURCE_NOT_FOUND', 'Workshop not found.');
    }

    return HttpResult.paginated(logs.map(toStatusEventDto), totalRecords, params);
  }

  async changeStatusByAdmin(
    id: string,
    dto: ChangeWorkshopStatusDto,
    actor: AuthenticatedActor,
  ): Promise<AdminWorkshopDto> {
    await this.runner.run(async tx => {
      await this.changeStatus(
        {
          workshopId: id,
          status: dto.status,
          reason: dto.reason,
          actor,
        },
        tx,
      );
    });

    return this.getAdminWorkshop(id);
  }
}
