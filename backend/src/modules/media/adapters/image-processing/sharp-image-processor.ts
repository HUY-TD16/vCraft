import sharp = require('sharp');
import { invalidImage, type DecodedImageInfo } from '../../domain/policies/image-validation.policy';
import { IMAGE_LIMITS } from '../../domain/value-objects/image-limits';
import { planVariants, type Dimensions } from '../../domain/value-objects/image-variants';
import {
  ImageProcessingUnavailableError, type ImageProcessor, type ProcessedImage, type ProcessedVariant,
} from '../../application/ports/image-processor.port';

/** failOn 'error': ảnh cụt/hỏng bị từ chối thay vì lưu nửa chừng. limitInputPixels chặn bom giải nén. */
const INPUT_OPTIONS: sharp.SharpOptions = {
  failOn: 'error',
  limitInputPixels: IMAGE_LIMITS.maxPixels,
  sequentialRead: true,
};
const WEBP_OPTIONS: sharp.WebpOptions = { quality: 82, effort: 4 };

function mapDecodeError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return invalidImage(/pixel limit/i.test(message) ? 'too_many_pixels' : 'undecodable');
}

/** EXIF orientation 5–8 nghĩa là ảnh được hiển thị xoay 90°, nên đổi chỗ rộng/cao. */
function orientedSize(meta: sharp.Metadata): Dimensions {
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  return meta.orientation !== undefined && meta.orientation >= 5 ? { width: height, height: width } : { width, height };
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ImageProcessingUnavailableError('Image processing timed out')), timeoutMs);
  });
  // Nếu hết giờ trước, tránh unhandled rejection khi tác vụ nền thất bại muộn.
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export class SharpImageProcessor implements ImageProcessor {
  private readonly timeoutMs: number;

  constructor(options: { readonly timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? IMAGE_LIMITS.processingTimeoutMs;
  }

  async inspect(input: Uint8Array): Promise<DecodedImageInfo> {
    try {
      const meta = await sharp(input, INPUT_OPTIONS).metadata();
      const { width, height } = orientedSize(meta);
      return { format: meta.format, width, height, pages: meta.pages };
    } catch (error) {
      throw mapDecodeError(error);
    }
  }

  process(input: Uint8Array): Promise<ProcessedImage> {
    return withTimeout(this.render(input), this.timeoutMs);
  }

  private async render(input: Uint8Array): Promise<ProcessedImage> {
    const source = await this.inspect(input);
    const plan = planVariants({ width: source.width, height: source.height });
    try {
      // rotate() không tham số: xoay theo EXIF rồi bỏ thẻ. Đầu ra không mang EXIF/GPS.
      const base = sharp(input, INPUT_OPTIONS).rotate();
      const [thumbnail, display] = await Promise.all([
        this.encode(base, plan.thumbnail), this.encode(base, plan.display),
      ]);
      return { width: source.width, height: source.height, thumbnail, display };
    } catch (error) {
      throw mapDecodeError(error);
    }
  }

  private async encode(base: sharp.Sharp, size: Dimensions): Promise<ProcessedVariant> {
    const { data, info } = await base.clone()
      .resize(size.width, size.height, { fit: 'fill' })
      .webp(WEBP_OPTIONS)
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, bytes: data.length };
  }
}
