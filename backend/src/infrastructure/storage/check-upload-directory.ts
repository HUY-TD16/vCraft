import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function checkUploadDirectory(directory: string): Promise<void> {
  const probe = join(directory, `.startup-${randomUUID()}`);
  try {
    await mkdir(directory, { recursive: true });
    await access(directory, constants.R_OK);
    await writeFile(probe, '', { flag: 'wx', mode: 0o600 });
    await unlink(probe);
  } catch {
    throw new Error('UPLOAD_DIR must be a writable directory');
  }
}
