import { pendingImageUrls } from '../../../application/services/image-urls';
import type { CreatedUploadScopeDto, CreatedUploadScopeResult, UploadedImageDto, UploadedImageResult } from '../dtos/media.dto';

/** Converts application results to the snake_case response format used by the HTTP API. */
export function toUploadedImageDto(result: UploadedImageResult): UploadedImageDto {
  return {
    image_id: result.imageId,
    context_type: result.contextType,
    context_id: result.contextId,
    ...pendingImageUrls(result.imageId),
    unattached_expires_at: result.unattachedExpiresAt.toISOString(),
  };
}

export function toCreatedUploadScopeDto(result: CreatedUploadScopeResult): CreatedUploadScopeDto {
  return {
    initial_workshop_key: result.initialWorkshopKey,
    expires_at: result.expiresAt.toISOString(),
  };
}
