import { MediaDomainError } from '../errors/media-domain.error';
import { IMAGE_LIMITS } from '../value-objects/image-limits';

export type ImageRejectReason =
  | 'undecodable' | 'file_too_large' | 'unsupported_format'
  | 'multi_frame' | 'invalid_dimensions' | 'too_many_pixels';

export function invalidImage(reason: ImageRejectReason): MediaDomainError {
  return new MediaDomainError('INVALID_IMAGE_FORMAT', { reason });
}

/** Thông tin lấy từ việc GIẢI MÃ thật (không tin Content-Type/đuôi tệp của client). */
export interface DecodedImageInfo {
  readonly format: string | undefined;
  readonly width: number;
  readonly height: number;
  /** Số khung hình; undefined nghĩa là ảnh tĩnh một khung. */
  readonly pages?: number;
}

export function assertAcceptableImage(fileBytes: number, info: DecodedImageInfo): void {
  if (!Number.isInteger(fileBytes) || fileBytes <= 0 || fileBytes > IMAGE_LIMITS.maxFileBytes) {
    throw invalidImage('file_too_large');
  }
  if (!(IMAGE_LIMITS.allowedFormats as readonly (string | undefined)[]).includes(info.format)) {
    throw invalidImage('unsupported_format');
  }
  if ((info.pages ?? 1) !== 1) throw invalidImage('multi_frame');
  if (!Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width < 1 || info.height < 1) {
    throw invalidImage('invalid_dimensions');
  }
  if (info.width * info.height > IMAGE_LIMITS.maxPixels) throw invalidImage('too_many_pixels');
}
