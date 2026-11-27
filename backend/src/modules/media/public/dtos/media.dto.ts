import type { Id, TrustedActor } from '../../../../common/application/types/contract-types';

/** Context values exposed to other modules; keep independent from Media's domain implementation. */
export type ImageContext = 'workshop_profile' | 'certificate' | 'product' | 'journal_entry';

/** Safe image representation for application workflows; storage keys are intentionally excluded. */
export interface ImageDto {
  readonly id: Id;
  readonly thumbnail_url: string;
  readonly display_url: string;
}

export interface ReplaceImagesInput {
  readonly contextType: ImageContext;
  readonly contextId: Id;
  readonly workshopId: Id;
  readonly imageIds: readonly Id[];
  readonly actor: TrustedActor;
}

export interface RetainHistoryImagesInput {
  readonly historyId: Id;
  readonly entryId: Id;
  readonly imageIds: readonly Id[];
}

export interface AttachInitialWorkshopScopeInput {
  readonly initialWorkshopKey: string;
  readonly workshopId: Id;
  readonly imageIds: readonly Id[];
  readonly actor: TrustedActor;
}

export interface GetImageDtoInput {
  readonly imageId: Id;
  readonly contextType: ImageContext;
  readonly contextId: Id;
  readonly historyId: Id | null;
  readonly actorOrNull: TrustedActor | null;
}
