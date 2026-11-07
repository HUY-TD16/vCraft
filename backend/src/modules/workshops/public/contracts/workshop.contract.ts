import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type { Id, TrustedActor } from '../../../../common/application/types/contract-types';

export type WorkshopStatus = 'active' | 'suspended';
export interface WorkshopSummaryDto {
  id: Id;
  name: string;
  status: WorkshopStatus;
  isProfilePublic: boolean;
}

export const WORKSHOP_CONTRACT = Symbol('WORKSHOP_CONTRACT');

export interface IWorkshopContract {
  lockAndAssertActive(workshopIds: readonly Id[], tx: TransactionContext): Promise<void>;
  getWorkshopSummary(workshopId: Id): Promise<WorkshopSummaryDto | null>;
  createWorkshop(input: {
    accountId: Id;
    name: string;
    address: string | null;
    story: string | null;
    latitude: number | null;
    longitude: number | null;
    actor: TrustedActor;
  }, tx: TransactionContext): Promise<{ workshopId: Id }>;
  changeStatus(input: {
    workshopId: Id;
    status: WorkshopStatus;
    reason: string;
    actor: TrustedActor;
  }, tx: TransactionContext): Promise<{ workshopId: Id; status: WorkshopStatus; changed: boolean }>;
  getProfileImageAccess(input: {
    workshopId: Id;
    imageId: Id;
    certificateId: Id | null;
    actorOrNull: TrustedActor | null;
  }, tx: TransactionContext): Promise<{ canRead: boolean }>;
}
