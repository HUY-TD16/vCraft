import type { ImageContextType } from '../../../domain/value-objects/image-context';
import type { UploadScopeResult, UploadImageResult } from '../../../application/dtos/media-use-case.dtos';

/** Multipart fields arrive as strings; the controller validates and converts them before calling the use case. */
export interface MediaUploadBodyDto {
  readonly context_type?: unknown;
  readonly context_id?: unknown;
  readonly target_workshop_id?: unknown;
  readonly initial_workshop_key?: unknown;
}

export interface UploadedImageDto {
  readonly image_id: string;
  readonly context_type: ImageContextType;
  readonly context_id: string | null;
  readonly thumbnail_url: string;
  readonly display_url: string;
  readonly unattached_expires_at: string;
}

export interface CreatedUploadScopeDto {
  readonly initial_workshop_key: string;
  readonly expires_at: string;
}

export type UploadedImageResult = UploadImageResult;
export type CreatedUploadScopeResult = UploadScopeResult;
