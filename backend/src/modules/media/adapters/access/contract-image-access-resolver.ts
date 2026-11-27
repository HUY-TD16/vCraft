import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type { Id, TrustedActor } from '../../../../common/application/types/contract-types';
import { CATALOG_CONTRACT, type ICatalogContract } from '../../../catalog/public/contracts/catalog.contract';
import { TRACEABILITY_CONTRACT, type ITraceabilityContract } from '../../../traceability/public/contracts/traceability.contract';
import { WORKSHOP_CONTRACT, type IWorkshopContract } from '../../../workshops/public/contracts/workshop.contract';
import type { ImageContextType } from '../../domain/value-objects/image-context';
import type { ImageAccessResolver } from '../../application/ports/queries/image-access-resolver.port';

/**
 * Routes image authorization to the module that owns each record. Missing optional
 * contracts fail closed so an unregistered domain can never make its images public.
 */
@Injectable()
export class ContractImageAccessResolver implements ImageAccessResolver {
  constructor(@Inject(ModuleRef) private readonly moduleRef: ModuleRef) {}

  private getContract<T>(token: symbol): T | null {
    try {
      return this.moduleRef.get<T>(token, { strict: false });
    } catch {
      return null;
    }
  }

  async canManageTarget(
    input: { contextType: ImageContextType; contextId: Id; workshopId: Id },
    tx: TransactionContext,
  ): Promise<boolean> {
    if (input.contextType !== 'workshop_profile' && input.contextType !== 'certificate') return false;
    const workshops = this.getContract<IWorkshopContract>(WORKSHOP_CONTRACT);
    if (!workshops) return false;
    return workshops.canManageImageTarget({
      contextType: input.contextType,
      contextId: input.contextId,
      workshopId: input.workshopId,
    }, tx);
  }

  async canReadCurrent(
    input: {
      contextType: ImageContextType;
      contextId: Id;
      imageId: Id;
      workshopId: Id | null;
      actorOrNull: TrustedActor | null;
    },
    tx: TransactionContext,
  ): Promise<boolean> {
    if (input.contextType === 'workshop_profile' || input.contextType === 'certificate') {
      const workshops = this.getContract<IWorkshopContract>(WORKSHOP_CONTRACT);
      if (!workshops || input.workshopId === null) return false;
      const result = await workshops.getProfileImageAccess({
        workshopId: input.workshopId,
        imageId: input.imageId,
        certificateId: input.contextType === 'certificate' ? input.contextId : null,
        actorOrNull: input.actorOrNull,
      }, tx);
      return result.canRead;
    }

    if (input.contextType === 'product') {
      const catalog = this.getContract<ICatalogContract>(CATALOG_CONTRACT);
      if (!catalog) return false;
      return (await catalog.getProductImageAccess({
        productId: input.contextId,
        imageId: input.imageId,
        actorOrNull: input.actorOrNull,
      }, tx)).canRead;
    }

    const traceability = this.getContract<ITraceabilityContract>(TRACEABILITY_CONTRACT);
    if (!traceability) return false;
    return (await traceability.getJournalImageAccess({
      entryId: input.contextId,
      imageId: input.imageId,
      historyId: null,
      actorOrNull: input.actorOrNull,
    }, tx)).canRead;
  }

  async canReadHistory(
    input: { entryId: Id; historyId: Id; imageId: Id; actorOrNull: TrustedActor | null },
    tx: TransactionContext,
  ): Promise<boolean> {
    const traceability = this.getContract<ITraceabilityContract>(TRACEABILITY_CONTRACT);
    if (!traceability) return false;
    return (await traceability.getJournalImageAccess({
      entryId: input.entryId,
      imageId: input.imageId,
      historyId: input.historyId,
      actorOrNull: input.actorOrNull,
    }, tx)).canRead;
  }
}
