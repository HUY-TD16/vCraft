import type { Id, TrustedActor } from '../../../../common/application/types/contract-types';
import type { ImageContextType } from '../../domain/value-objects/image-context';
import type { ImageVariant } from '../../domain/value-objects/image-variant';
import type { UploadTarget } from '../../domain/policies/upload-permission.policy';

/** Input/output types exchanged between Media application use cases and their adapters. */
export interface UploadImageCommand {
  readonly actor: TrustedActor;
  readonly file: Uint8Array;
  readonly contextType: ImageContextType;
  /** null while uploading an image for a new object whose identifier is not known yet. */
  readonly contextId: Id | null;
  readonly target: UploadTarget;
}

export interface UploadImageResult {
  readonly imageId: Id;
  readonly contextType: ImageContextType;
  readonly contextId: Id | null;
  readonly unattachedExpiresAt: Date;
}

export interface CreateUploadScopeCommand {
  readonly actor: TrustedActor;
}

export interface UploadScopeResult {
  readonly initialWorkshopKey: string;
  readonly expiresAt: Date;
}

export type ImageSource =
  | { readonly kind: 'pending'; readonly imageId: Id }
  | { readonly kind: 'current'; readonly contextType: ImageContextType; readonly contextId: Id; readonly imageId: Id }
  | { readonly kind: 'history'; readonly historyId: Id; readonly imageId: Id };

export interface GetImageCommand {
  readonly actorOrNull: TrustedActor | null;
  readonly source: ImageSource;
  readonly variant: ImageVariant;
}

/** Storage key is internal to the backend and must never be returned as an HTTP response. */
export interface ImageReadTarget {
  readonly key: string;
  readonly sizeBytes: bigint;
  readonly contentType: 'image/webp';
}

