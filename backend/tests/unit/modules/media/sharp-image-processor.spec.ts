import sharp = require('sharp');
import { describe, expect, it } from 'vitest';
import { BusinessRuleException } from '../../../../src/common/domain/errors/business-rule.exception';
import { SharpImageProcessor } from '../../../../src/modules/media/adapters/image-processing/sharp-image-processor';
import { ImageProcessingUnavailableError } from '../../../../src/modules/media/application/ports/image-processor.port';
import { assertAcceptableImage } from '../../../../src/modules/media/domain/policies/image-validation.policy';

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (e) { return e; }
  return undefined;
}

describe('SharpImageProcessor', () => {
  const processor = new SharpImageProcessor();

  it('inspect đọc đúng định dạng và kích thước', async () => {
    const jpeg = await solid(800, 600).jpeg().toBuffer();
    expect(await processor.inspect(jpeg)).toMatchObject({ format: 'jpeg', width: 800, height: 600 });
    const png = await solid(64, 32).png().toBuffer();
    expect(await processor.inspect(png)).toMatchObject({ format: 'png', width: 64, height: 32 });
  });

  it('ảnh lớn: thumbnail 320 và display 1600, đều là WebP giữ tỉ lệ', async () => {
    const input = await solid(4000, 3000).jpeg().toBuffer();
    const out = await processor.process(input);
    expect([out.width, out.height]).toEqual([4000, 3000]);
    expect([out.thumbnail.width, out.thumbnail.height]).toEqual([320, 240]);
    expect([out.display.width, out.display.height]).toEqual([1600, 1200]);
    for (const v of [out.thumbnail, out.display]) {
      const meta = await sharp(v.data).metadata();
      expect(meta.format).toBe('webp');
      expect([meta.width, meta.height]).toEqual([v.width, v.height]);
      expect(v.bytes).toBe(v.data.length);
    }
  });

  it('ảnh nhỏ không bị phóng to', async () => {
    const out = await processor.process(await solid(200, 100).png().toBuffer());
    expect([out.thumbnail.width, out.thumbnail.height]).toEqual([200, 100]);
    expect([out.display.width, out.display.height]).toEqual([200, 100]);
  });

  it('giữ kênh trong suốt của PNG', async () => {
    const png = await sharp({ create: { width: 50, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.2 } } }).png().toBuffer();
    const out = await processor.process(png);
    expect((await sharp(out.display.data).metadata()).hasAlpha).toBe(true);
  });

  it('xoay đúng chiều theo EXIF orientation 6 (ngang → dọc)', async () => {
    const input = await solid(400, 200).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect(await processor.inspect(input)).toMatchObject({ width: 200, height: 400 });
    const out = await processor.process(input);
    expect([out.width, out.height]).toEqual([200, 400]);
    expect([out.display.width, out.display.height]).toEqual([200, 400]);
    expect((await sharp(out.display.data).metadata()).orientation).toBeUndefined();
  });

  it('loại bỏ EXIF khỏi đầu ra (không lộ GPS/bản quyền)', async () => {
    const input = await solid(300, 300)
      .withExif({ IFD0: { Copyright: 'secret-copyright', ImageDescription: 'secret-description' } })
      .jpeg().toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const out = await processor.process(input);
    const meta = await sharp(out.display.data).metadata();
    expect(meta.exif).toBeUndefined();
    expect(Buffer.from(out.display.data).includes('secret-copyright')).toBe(false);
  });

  it('GIF được nhận diện để chính sách từ chối', async () => {
    const gif = await solid(40, 40).gif().toBuffer();
    const info = await processor.inspect(gif);
    expect(info.format).toBe('gif');
    expect(() => assertAcceptableImage(gif.length, info)).toThrow(BusinessRuleException);
  });

  it('dữ liệu rác → INVALID_IMAGE_FORMAT (undecodable)', async () => {
    const garbage = Buffer.from('đây không phải là ảnh, chỉ là chữ');
    for (const fn of [() => processor.inspect(garbage), () => processor.process(garbage)]) {
      const e = await rejection(fn());
      expect(e).toBeInstanceOf(BusinessRuleException);
      expect((e as BusinessRuleException).code).toBe('INVALID_IMAGE_FORMAT');
      expect((e as BusinessRuleException).details).toEqual({ reason: 'undecodable' });
    }
  });

  it('JPEG bị cắt cụt → từ chối, không lưu ảnh nửa chừng', async () => {
    const noisy = await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 0, g: 0, b: 0 }, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg().toBuffer();
    const truncated = noisy.subarray(0, Math.floor(noisy.length / 2));
    const e = await rejection(processor.process(truncated));
    expect(e).toBeInstanceOf(BusinessRuleException);
    expect((e as BusinessRuleException).code).toBe('INVALID_IMAGE_FORMAT');
  });

  it('vượt 25 triệu pixel bị chặn, không giải mã', async () => {
    const huge = await solid(6000, 5000).jpeg({ quality: 20 }).toBuffer();
    const e = await rejection(processor.process(huge));
    expect(e).toBeInstanceOf(BusinessRuleException);
    expect((e as BusinessRuleException).details).toEqual({ reason: 'too_many_pixels' });
  }, 30_000);

  it('quá thời gian → ImageProcessingUnavailableError', async () => {
    const slow = new SharpImageProcessor({ timeoutMs: 1 });
    const input = await solid(4000, 3000).jpeg().toBuffer();
    expect(await rejection(slow.process(input))).toBeInstanceOf(ImageProcessingUnavailableError);
  });
});
