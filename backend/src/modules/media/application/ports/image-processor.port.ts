import type { DecodedImageInfo } from '../../domain/policies/image-validation.policy';

export const IMAGE_PROCESSOR = Symbol('IMAGE_PROCESSOR');

export interface ProcessedVariant {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export interface ProcessedImage {
  /** Kích thước ảnh gốc sau khi đã xoay đúng chiều theo EXIF. */
  readonly width: number;
  readonly height: number;
  readonly thumbnail: ProcessedVariant;
  readonly display: ProcessedVariant;
}

/** Xử lý ảnh quá hạn hoặc không khả dụng → use case đổi thành 503 IMAGE_PROCESSING_UNAVAILABLE. */
export class ImageProcessingUnavailableError extends Error {
  constructor(message = 'Image processing unavailable') {
    super(message);
    this.name = 'ImageProcessingUnavailableError';
  }
}

export interface ImageProcessor {
  /**
   * Đọc metadata (không giải mã toàn bộ pixel). Ảnh không giải mã được hoặc quá số pixel
   * → BusinessRuleException INVALID_IMAGE_FORMAT.
   */
  inspect(input: Uint8Array): Promise<DecodedImageInfo>;

  /**
   * Giải mã, xoay đúng chiều, bỏ metadata (EXIF/GPS), mã hóa lại thành thumbnail và display.
   * Không nâng cấp cỡ ảnh nhỏ. Quá hạn → ImageProcessingUnavailableError.
   */
  process(input: Uint8Array): Promise<ProcessedImage>;
}
