import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import {
  InvalidStorageKeyError, StorageObjectNotFoundError, type ImageStorage,
} from '../../application/ports/image-storage.port';

/** Mỗi đoạn bắt đầu bằng chữ/số nên không thể là '.' hay '..'; không có '\\', NUL hay '//'. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MAX_KEY_LENGTH = 255;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export class LocalImageStorage implements ImageStorage {
  private readonly root: string;

  constructor(rootDirectory: string) {
    this.root = resolve(rootDirectory);
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    const target = this.pathOf(key);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, data, { flag: 'wx', mode: 0o640 });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async read(key: string): Promise<Readable> {
    const target = this.pathOf(key);
    try {
      if (!(await stat(target)).isFile()) throw new StorageObjectNotFoundError();
    } catch (error) {
      if (isMissing(error)) throw new StorageObjectNotFoundError();
      throw error;
    }
    return createReadStream(target);
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathOf(key));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    const directory = this.pathOf(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
    await rm(directory, { recursive: true, force: true });
  }

  /** Kiểm tra khóa theo danh sách cho phép, rồi kiểm tra lại đường dẫn nằm dưới thư mục gốc. */
  private pathOf(key: string): string {
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH || !SAFE_KEY.test(key)) {
      throw new InvalidStorageKeyError();
    }
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new InvalidStorageKeyError();
    return full;
  }
}
