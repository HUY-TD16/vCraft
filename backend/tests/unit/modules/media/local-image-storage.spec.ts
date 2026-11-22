import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalImageStorage } from '../../../../src/modules/media/adapters/storage/local-image-storage';
import {
  InvalidStorageKeyError, StorageObjectNotFoundError,
} from '../../../../src/modules/media/application/ports/image-storage.port';

async function readAll(stream: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('LocalImageStorage', () => {
  let root: string;
  let storage: LocalImageStorage;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vcraft-storage-'));
    storage = new LocalImageStorage(root);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('ghi rồi đọc lại đúng nội dung, tự tạo thư mục con', async () => {
    await storage.write('ws7/abc-123/thumbnail.webp', Buffer.from('hello'));
    expect((await readAll(await storage.read('ws7/abc-123/thumbnail.webp'))).toString()).toBe('hello');
  });

  it('ghi nguyên tử: không để lại tệp .tmp, ghi lại thì thay thế', async () => {
    await storage.write('a/x.webp', Buffer.from('one'));
    await storage.write('a/x.webp', Buffer.from('two'));
    expect(await readdir(join(root, 'a'))).toEqual(['x.webp']);
    expect((await readAll(await storage.read('a/x.webp'))).toString()).toBe('two');
  });

  it('đọc tệp không tồn tại → StorageObjectNotFoundError, ném trước khi trả luồng', async () => {
    await expect(storage.read('a/missing.webp')).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    await storage.write('a/b/c.webp', Buffer.from('x'));
    await expect(storage.read('a/b')).rejects.toBeInstanceOf(StorageObjectNotFoundError); // thư mục, không phải tệp
  });

  it('delete idempotent', async () => {
    await storage.write('a/x.webp', Buffer.from('x'));
    await storage.delete('a/x.webp');
    await storage.delete('a/x.webp');
    expect(existsSync(join(root, 'a', 'x.webp'))).toBe(false);
  });

  it('deletePrefix xóa cả thư mục, kể cả tệp tạm bỏ dở, và idempotent', async () => {
    await storage.write('ws7/r1/thumbnail.webp', Buffer.from('1'));
    await storage.write('ws7/r1/display.webp', Buffer.from('2'));
    await writeFile(join(root, 'ws7', 'r1', 'display.webp.dead.tmp'), 'orphan');
    await storage.write('ws7/r2/display.webp', Buffer.from('keep'));
    await storage.deletePrefix('ws7/r1/');
    await storage.deletePrefix('ws7/r1/');
    expect(existsSync(join(root, 'ws7', 'r1'))).toBe(false);
    expect((await readFile(join(root, 'ws7', 'r2', 'display.webp'))).toString()).toBe('keep');
  });

  it.each([
    '', '..', '.', '/etc/passwd', '../outside.webp', 'a/../../outside.webp', 'a/./b', 'a//b',
    'a\\b', 'a/b\0.webp', '.hidden', 'a/.hidden', ' a', 'a b', 'x'.repeat(256),
  ])('từ chối khóa không an toàn: %j', async (key) => {
    await expect(storage.write(key, Buffer.from('x'))).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(storage.read(key)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(storage.delete(key)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(storage.deletePrefix(key)).rejects.toBeInstanceOf(InvalidStorageKeyError);
  });

  it('deletePrefix không bao giờ xóa thư mục gốc', async () => {
    await storage.write('keep/x.webp', Buffer.from('x'));
    for (const prefix of ['', '/', '.', '..', '../']) {
      await expect(storage.deletePrefix(prefix)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    }
    expect(existsSync(join(root, 'keep', 'x.webp'))).toBe(true);
  });
});
