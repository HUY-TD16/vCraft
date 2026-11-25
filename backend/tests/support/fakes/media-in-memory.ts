import { Readable } from 'node:stream';
import type { TransactionContext, TransactionRunner } from '../../../src/common/application/ports/transaction-runner';
import type { Id } from '../../../src/common/application/types/contract-types';
import type { StorageQuotaState } from '../../../src/modules/media/domain/entities/storage-quota.entity';
import type { StorageCapacitySnapshot } from '../../../src/modules/media/domain/policies/storage-capacity.policy';
import type { DecodedImageInfo } from '../../../src/modules/media/domain/policies/image-validation.policy';
import {
  ImageProcessingUnavailableError, type ImageProcessor, type ProcessedImage,
} from '../../../src/modules/media/application/ports/image-processor.port';
import {
  StorageObjectNotFoundError, type ImageStorage,
} from '../../../src/modules/media/application/ports/image-storage.port';
import type { IStorageCapacity } from '../../../src/modules/media/application/ports/storage-capacity.port';
import type {
  IImageRepository, IStorageQuotaRepository, IUploadReservationRepository, IUploadScopeRepository,
  ImageRecord, NewImage, NewUploadReservation, StorageQuotaRecord, UploadReservationRecord, UploadScopeRecord,
} from '../../../src/modules/media/application/ports/repositories/media-repositories.port';
import type { UploadReservationState } from '../../../src/modules/media/domain/entities/upload-reservation.entity';

export interface QuotaRow {
  readonly id: Id;
  readonly owner: { readonly kind: 'workshop'; readonly workshopId: Id } | { readonly kind: 'scope'; readonly key: string };
  readonly state: StorageQuotaState;
}

/** CSDL giả có snapshot/rollback để mô phỏng giao dịch. Các bản ghi là bất biến, chỉ thay thế, không sửa tại chỗ. */
export class InMemoryMediaDb {
  quotas = new Map<Id, QuotaRow>();
  reservations = new Map<Id, UploadReservationRecord>();
  images = new Map<Id, ImageRecord>();
  scopes = new Map<string, UploadScopeRecord>();
  now = new Date('2026-11-21T10:00:00.000Z');
  locks: string[] = [];
  private sequence = 100;

  nextId(): Id { return String(++this.sequence); }
  snapshot() {
    return { q: new Map(this.quotas), r: new Map(this.reservations), i: new Map(this.images), s: new Map(this.scopes), seq: this.sequence };
  }
  restore(snap: ReturnType<InMemoryMediaDb['snapshot']>) {
    this.quotas = snap.q; this.reservations = snap.r; this.images = snap.i; this.scopes = snap.s; this.sequence = snap.seq;
  }
  advance(ms: number) { this.now = new Date(this.now.getTime() + ms); }
}

export class InMemoryTransactionRunner implements TransactionRunner {
  transactions = 0;
  constructor(private readonly db: InMemoryMediaDb) {}
  async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const snapshot = this.db.snapshot();
    try {
      return await work(Object.freeze({}) as TransactionContext);
    } catch (error) {
      this.db.restore(snapshot);
      throw error;
    }
  }
}

export class InMemoryQuotaRepository implements IStorageQuotaRepository {
  constructor(private readonly db: InMemoryMediaDb) {}
  async lockStorageBudget(): Promise<void> { this.db.locks.push('storage'); }
  async lockOrCreateWorkshopQuota(workshopId: Id, limitBytes: bigint): Promise<StorageQuotaRecord> {
    this.db.locks.push(`quota:w${workshopId}`);
    const found = [...this.db.quotas.values()].find(q => q.owner.kind === 'workshop' && q.owner.workshopId === workshopId);
    if (found) return { id: found.id, state: found.state };
    const row: QuotaRow = {
      id: this.db.nextId(), owner: { kind: 'workshop', workshopId },
      state: { limitBytes, usedBytes: BigInt(0), reservedBytes: BigInt(0) },
    };
    this.db.quotas.set(row.id, row);
    return { id: row.id, state: row.state };
  }
  async lockScopeQuota(key: string): Promise<StorageQuotaRecord | null> {
    this.db.locks.push(`quota:s${key}`);
    const found = [...this.db.quotas.values()].find(q => q.owner.kind === 'scope' && q.owner.key === key);
    return found ? { id: found.id, state: found.state } : null;
  }
  async lockById(quotaId: Id): Promise<StorageQuotaRecord | null> {
    this.db.locks.push(`quota:${quotaId}`);
    const found = this.db.quotas.get(quotaId);
    return found ? { id: found.id, state: found.state } : null;
  }
  async save(record: StorageQuotaRecord): Promise<void> {
    const row = this.db.quotas.get(record.id);
    if (!row) throw new Error('quota missing');
    this.db.quotas.set(record.id, { ...row, state: record.state });
  }
  async sumReservedBytes(): Promise<bigint> {
    return [...this.db.quotas.values()].reduce((sum, q) => sum + q.state.reservedBytes, BigInt(0));
  }
  async sumInitialScopeBytes(adminId: Id): Promise<bigint> {
    let sum = BigInt(0);
    for (const q of this.db.quotas.values()) {
      if (q.owner.kind !== 'scope') continue;
      if (this.db.scopes.get(q.owner.key)?.createdBy === adminId) sum += q.state.usedBytes + q.state.reservedBytes;
    }
    return sum;
  }
}

export class InMemoryScopeRepository implements IUploadScopeRepository {
  constructor(private readonly db: InMemoryMediaDb) {}
  async lockByKey(key: string): Promise<UploadScopeRecord | null> {
    this.db.locks.push(`scope:${key}`);
    return this.db.scopes.get(key) ?? null;
  }
}

export class InMemoryReservationRepository implements IUploadReservationRepository {
  constructor(private readonly db: InMemoryMediaDb) {}
  async databaseNow(): Promise<Date> { return this.db.now; }
  async create(input: NewUploadReservation): Promise<UploadReservationRecord> {
    const record: UploadReservationRecord = {
      id: this.db.nextId(), quotaId: input.quotaId, uploadedBy: input.uploadedBy,
      contextType: input.contextType, contextId: input.contextId, storagePrefix: input.storagePrefix,
      state: { status: 'reserved', budgetBytes: input.budgetBytes, actualBytes: null, expiresAt: input.expiresAt },
    };
    this.db.reservations.set(record.id, record);
    return record;
  }
  async findById(id: Id): Promise<UploadReservationRecord | null> { return this.db.reservations.get(id) ?? null; }
  async lockById(id: Id): Promise<UploadReservationRecord | null> {
    this.db.locks.push(`reservation:${id}`);
    return this.db.reservations.get(id) ?? null;
  }
  async saveState(id: Id, state: UploadReservationState): Promise<void> {
    const record = this.db.reservations.get(id);
    if (!record) throw new Error('reservation missing');
    this.db.reservations.set(id, { ...record, state });
  }
}

export class InMemoryImageRepository implements IImageRepository {
  constructor(private readonly db: InMemoryMediaDb) {}
  async create(input: NewImage): Promise<ImageRecord> {
    const record: ImageRecord = { ...input, id: this.db.nextId() };
    this.db.images.set(record.id, record);
    return record;
  }
}

export class InMemoryStorage implements ImageStorage {
  files = new Map<string, Uint8Array>();
  failWriteOnCall: number | null = null;
  failDeletePrefix = false;
  private writes = 0;
  async write(key: string, data: Uint8Array): Promise<void> {
    this.writes += 1;
    if (this.failWriteOnCall === this.writes) throw new Error('disk full');
    this.files.set(key, data);
  }
  async read(key: string): Promise<Readable> {
    const data = this.files.get(key);
    if (!data) throw new StorageObjectNotFoundError();
    return Readable.from([Buffer.from(data)]);
  }
  async delete(key: string): Promise<void> { this.files.delete(key); }
  async deletePrefix(prefix: string): Promise<void> {
    if (this.failDeletePrefix) throw new Error('storage unavailable');
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
  }
}

export class FakeProcessor implements ImageProcessor {
  info: DecodedImageInfo | Error = { format: 'jpeg', width: 4000, height: 3000 };
  outcome: 'ok' | 'timeout' | Error = 'ok';
  thumbnailBytes = 20_000;
  displayBytes = 300_000;
  /** Mô phỏng thời gian xử lý trôi qua trong lúc worker chạy (đồng hồ DB giả). */
  onProcess: () => void = () => undefined;
  /** Giữ reservation trong N ms để ép các giao dịch giữ chỗ đồng thời xảy ra trước mọi quyết toán. */
  delayMs = 0;
  processCalls = 0;
  async inspect(): Promise<DecodedImageInfo> {
    if (this.info instanceof Error) throw this.info;
    return this.info;
  }
  async process(): Promise<ProcessedImage> {
    this.processCalls += 1;
    this.onProcess();
    if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    if (this.outcome === 'timeout') throw new ImageProcessingUnavailableError();
    if (this.outcome instanceof Error) throw this.outcome;
    return {
      width: 4000, height: 3000,
      thumbnail: { data: new Uint8Array(this.thumbnailBytes), width: 320, height: 240, bytes: this.thumbnailBytes },
      display: { data: new Uint8Array(this.displayBytes), width: 1600, height: 1200, bytes: this.displayBytes },
    };
  }
}

export class FakeCapacity implements IStorageCapacity {
  snapshot: StorageCapacitySnapshot = { freeBytes: BigInt(500) * BigInt(1024 ** 3), totalBytes: BigInt(1000) * BigInt(1024 ** 3) };
  async measure(): Promise<StorageCapacitySnapshot> { return this.snapshot; }
}
