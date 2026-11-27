import { Injectable } from '@nestjs/common';
import { statfs } from 'node:fs/promises';
import type { StorageCapacitySnapshot } from '../../domain/policies/storage-capacity.policy';
import type { IStorageCapacity } from '../../application/ports/storage-capacity.port';
import { APP_CONFIG, type AppConfig } from '../../../../common/config/app-config';
import { Inject } from '@nestjs/common';

@Injectable()
export class LocalStorageCapacity implements IStorageCapacity {
  constructor(@Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'UPLOAD_DIR'>) {}

  async measure(): Promise<StorageCapacitySnapshot> {
    const stats = await statfs(this.config.UPLOAD_DIR);
    return {
      freeBytes: BigInt(stats.bavail) * BigInt(stats.bsize),
      totalBytes: BigInt(stats.blocks) * BigInt(stats.bsize),
    };
  }
}
