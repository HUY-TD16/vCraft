import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';

export const WORKSHOP_REPOSITORY = Symbol('WORKSHOP_REPOSITORY');

export interface IWorkshopRepository {
  lockAndGetWorkshops(ids: bigint[], tx: TransactionContext): Promise<Array<{ id: bigint; status: string }>>;

  findSummaryById(
    id: bigint,
    tx?: TransactionContext,
  ): Promise<{
    id: bigint;
    name: string;
    status: string;
    address: string | null;
    story: string | null;
    avatar_image_id: bigint | null;
  } | null>;

  getAttachedImageCount(workshopId: bigint, tx?: TransactionContext): Promise<number>;

  findAccountById(accountId: bigint, tx: TransactionContext): Promise<{ id: bigint; role: string } | null>;

  findByAccountId(accountId: bigint, tx: TransactionContext): Promise<{ id: bigint } | null>;

  createWorkshop(
    data: {
      accountId: bigint;
      name: string;
      address: string | null;
      story: string | null;
      latitude: number | null;
      longitude: number | null;
    },
    tx: TransactionContext,
  ): Promise<{ id: bigint }>;

  createStatusLog(
    data: {
      workshopId: bigint;
      prevStatus: string | null;
      newStatus: string;
      performedBy: bigint;
      reason: string;
    },
    tx: TransactionContext,
  ): Promise<void>;

  findForStatusChange(workshopId: bigint, tx: TransactionContext): Promise<{ id: bigint; status: string } | null>;

  updateStatus(workshopId: bigint, status: string, tx: TransactionContext): Promise<void>;

  findCertificate(certId: bigint, tx: TransactionContext): Promise<{ id: bigint; workshop_id: bigint; image_id: bigint } | null>;

  hasProfileImage(workshopId: bigint, imageId: bigint, tx: TransactionContext): Promise<boolean>;

  findManyPublic(params: {
    search?: string;
    accepting_visitors?: boolean;
    skip: number;
    take: number;
  }): Promise<{
    workshops: any[];
    attachedContextIds: Set<string>;
    totalRecords: number;
  }>;

  findDetailById(
    id: bigint,
    includeAccount?: boolean,
  ): Promise<{ workshop: any; images: Array<{ id: bigint }> } | null>;

  findForProfileUpdate(id: bigint, tx: TransactionContext): Promise<{
    workshop: any;
    existingImagesCount: number;
    certificates: Array<{ id: bigint; name: string; image_id: bigint }>;
  } | null>;

  findCertificatesByWorkshop(workshopId: bigint, tx: TransactionContext): Promise<Array<{
    id: bigint;
    name: string;
    image_id: bigint;
  }>>;

  updateProfileAndAssets(
    data: {
      workshopId: bigint;
      name: string;
      story: string | null;
      address: string | null;
      latitude: number | null;
      longitude: number | null;
      avatarImageId: bigint | null;
      certificates: Array<{ id?: bigint; name: string; imageId: bigint }>;
    },
    tx: TransactionContext,
  ): Promise<void>;

  updateVisitors(id: bigint, acceptingVisitors: boolean): Promise<boolean>;

  findManyAdmin(params: {
    search?: string;
    status?: string;
    skip: number;
    take: number;
  }): Promise<{
    workshops: any[];
    imagesByWorkshopId: Map<string, Array<{ id: bigint }>>;
    totalRecords: number;
  }>;

  findStatusLogs(
    workshopId: bigint,
    skip: number,
    take: number,
  ): Promise<{ logs: any[]; totalRecords: number; workshopExists: boolean }>;
}
