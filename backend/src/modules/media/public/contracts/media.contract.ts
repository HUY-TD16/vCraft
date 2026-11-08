import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type { Id, TrustedActor } from '../../../../common/application/types/contract-types';

export type ImageContext = 'workshop_profile' | 'certificate' | 'product' | 'journal_entry';
export interface ImageDto {
  id: Id;
  thumbnail_url: string;
  display_url: string;
}

export const MEDIA_CONTRACT = Symbol('MEDIA_CONTRACT');

export interface IMediaContract {
  replaceImages(input: {
    contextType: ImageContext;
    contextId: Id;
    workshopId: Id;
    imageIds: readonly Id[];
    actor: TrustedActor;
  }, tx: TransactionContext): Promise<void>;
  retainHistoryImages(input: {
    historyId: Id;
    entryId: Id;
    imageIds: readonly Id[];
  }, tx: TransactionContext): Promise<void>;
  attachInitialWorkshopScope(input: {
    initialWorkshopKey: string;
    workshopId: Id;
    imageIds: readonly Id[];
    actor: TrustedActor;
  }, tx: TransactionContext): Promise<void>;
  getImageDto(input: {
    imageId: Id;
    contextType: ImageContext;
    contextId: Id;
    historyId: Id | null;
    actorOrNull: TrustedActor | null;
  }, tx: TransactionContext): Promise<ImageDto | null>;
}
