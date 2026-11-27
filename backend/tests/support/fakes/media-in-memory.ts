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
import type { ImageAccessResolver } from '../../../src/modules/media/application/ports/image-access-resolver.port';
import type { IStorageCapacity } from '../../../src/modules/media/application/ports/storage-capacity.port';
import type {
  IImageRepository, IStorageQuotaRepository, IUploadReservationRepository, IUploadScopeRepository,
  ImageRecord, ImageStateRecord, NewImage, NewUploadReservation, StorageQuotaRecord, UploadReservationRecord, UploadScopeRecord,
} from '../../../src/modules/media/application/ports/repositories/media-repositories.port';
import type { ImageContextType } from '../../../src/modules/media/domain/value-objects/image-context';
import type { UploadReservationState } from '../../../src/modules/media/domain/entities/upload-reservation.entity';

export interface QuotaRow {
  readonly id: Id;
  readonly owner: { readonly kind: 'workshop'; readonly workshopId: Id } | { readonly kind: 'scope'; readonly key: string };
  readonly state: StorageQuotaState;
}

export interface FakeImage extends ImageRecord {
  readonly isAttached: boolean;
  readonly storageState: 'ready' | 'deleting';
  readonly nullableUnreferencedAt: Date | null;
}
export interface FakeHistoryLink { readonly historyId: Id; readonly imageId: Id; readonly entryId: Id; readonly position: number }
export interface FakeScope extends UploadScopeRecord { readonly attachedWorkshopId: Id | null }

/** CSDL giả có snapshot/rollback để mô phỏng giao dịch. Các bản ghi là bất biến, chỉ thay thế, không sửa tại chỗ. */
export class InMemoryMediaDb {
  quotas = new Map<Id, QuotaRow>();
  reservations = new Map<Id, UploadReservationRecord>();
  images = new Map<Id, FakeImage>();
  scopes = new Map<string, FakeScope>();
  historyLinks: FakeHistoryLink[] = [];
  /** historyId → entryId (do module Traceability sở hữu; test tự khai báo). */
  historyEntries = new Map<Id, Id>();
  now = new Date('2026-11-21T10:00:00.000Z');
  locks: string[] = [];
  private sequence = 100;

  nextId(): Id { return String(++this.sequence); }
  snapshot() {
    return {
      q: new Map(this.quotas), r: new Map(this.reservations), i: new Map(this.images), s: new Map(this.scopes),
      h: [...this.historyLinks], seq: this.sequence,
    };
  }
  restore(snap: ReturnType<InMemoryMediaDb['snapshot']>) {
    this.quotas = snap.q; this.reservations = snap.r; this.images = snap.i; this.scopes = snap.s;
    this.historyLinks = snap.h; this.sequence = snap.seq;
  }
  nextUuid(): string { return `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, '0')}`; }
  workshopOfQuota(quotaId: Id): Id | null {
    const owner = this.quotas.get(quotaId)?.owner;
    return owner?.kind === 'workshop' ? owner.workshopId : null;
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
  async transferScopeQuotaToWorkshop(initialWorkshopKey: string, workshopId: Id): Promise<void> {
    const row = [...this.db.quotas.values()].find(q => q.owner.kind === 'scope' && q.owner.key === initialWorkshopKey);
    if (!row) throw new Error('scope quota missing');
    this.db.quotas.set(row.id, { ...row, owner: { kind: 'workshop', workshopId } });
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
  async countOpenUnexpired(adminId: Id, now: Date): Promise<number> {
    return [...this.db.scopes.values()].filter(s =>
      s.createdBy === adminId && s.status === 'open' && s.expiresAt.getTime() > now.getTime()).length;
  }
  async create(input: { adminId: Id; expiresAt: Date; quotaLimitBytes: bigint }): Promise<UploadScopeRecord> {
    const key = this.db.nextUuid();
    const scope: FakeScope = { initialWorkshopKey: key, createdBy: input.adminId, status: 'open', expiresAt: input.expiresAt, attachedWorkshopId: null };
    this.db.scopes.set(key, scope);
    const id = this.db.nextId();
    this.db.quotas.set(id, { id, owner: { kind: 'scope', key }, state: { limitBytes: input.quotaLimitBytes, usedBytes: BigInt(0), reservedBytes: BigInt(0) } });
    return scope;
  }
  async markAttached(key: string, workshopId: Id): Promise<void> {
    const scope = this.db.scopes.get(key);
    if (!scope) throw new Error('scope missing');
    this.db.scopes.set(key, { ...scope, status: 'attached', attachedWorkshopId: workshopId });
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
  async countActiveByQuota(quotaId: Id): Promise<number> {
    return [...this.db.reservations.values()].filter(r =>
      r.quotaId === quotaId && (r.state.status === 'reserved' || r.state.status === 'cleanup_pending')).length;
  }
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

const byNumericId = (a: Id, b: Id) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

export class InMemoryImageRepository implements IImageRepository {
  constructor(private readonly db: InMemoryMediaDb) {}

  async create(input: NewImage): Promise<ImageRecord> {
    const record: FakeImage = { ...input, id: this.db.nextId(), isAttached: false, storageState: 'ready', nullableUnreferencedAt: input.unreferencedAt };
    this.db.images.set(record.id, record);
    return record;
  }

  private toState(image: FakeImage): ImageStateRecord {
    return {
      id: image.id, uploadedBy: image.uploadedBy, contextType: image.contextType, contextId: image.contextId,
      quotaId: image.quotaId, quotaWorkshopId: this.db.workshopOfQuota(image.quotaId),
      isAttached: image.isAttached, storageState: image.storageState, unreferencedAt: image.nullableUnreferencedAt,
      thumbnailKey: image.thumbnailKey, displayKey: image.displayKey,
      thumbnailSizeBytes: image.thumbnailSizeBytes, displaySizeBytes: image.displaySizeBytes,
    };
  }

  async findById(imageId: Id): Promise<ImageStateRecord | null> {
    const image = this.db.images.get(imageId);
    return image ? this.toState(image) : null;
  }
  async lockByIds(imageIds: readonly Id[]): Promise<ImageStateRecord[]> {
    const ids = [...imageIds].sort(byNumericId);
    this.db.locks.push(`images:${ids.join(',')}`);
    return ids.flatMap(id => { const image = this.db.images.get(id); return image ? [this.toState(image)] : []; });
  }
  async lockContext(contextType: ImageContextType, contextId: Id): Promise<void> {
    this.db.locks.push(`context:${contextType}:${contextId}`);
  }
  async listAttachedIds(contextType: ImageContextType, contextId: Id): Promise<Id[]> {
    return [...this.db.images.values()]
      .filter(i => i.isAttached && i.contextType === contextType && i.contextId === contextId)
      .map(i => i.id).sort(byNumericId);
  }
  async markAttached(imageIds: readonly Id[], contextId: Id): Promise<void> {
    for (const id of imageIds) {
      const image = this.db.images.get(id)!;
      this.db.images.set(id, { ...image, isAttached: true, contextId, nullableUnreferencedAt: null });
    }
  }
  async markDetached(imageIds: readonly Id[], at: Date): Promise<void> {
    for (const id of imageIds) {
      const image = this.db.images.get(id)!;
      this.db.images.set(id, { ...image, isAttached: false, nullableUnreferencedAt: at });
    }
  }
  async addHistoryLinks(historyId: Id, imageIds: readonly Id[]): Promise<void> {
    const entryId = this.db.historyEntries.get(historyId) ?? 'unknown';
    imageIds.forEach((imageId, position) => this.db.historyLinks.push({ historyId, imageId, entryId, position }));
  }
  async findHistoryEntry(historyId: Id, imageId: Id): Promise<{ readonly entryId: Id } | null> {
    const link = this.db.historyLinks.find(l => l.historyId === historyId && l.imageId === imageId);
    return link ? { entryId: link.entryId } : null;
  }
  async isReferencedByHistory(imageId: Id): Promise<boolean> {
    return this.db.historyLinks.some(l => l.imageId === imageId);
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

/** Phân giải quyền giả: test khai báo ai được đọc gì; ghi lại các lời gọi để kiểm tra dữ liệu truyền đi. */
export class FakeImageAccessResolver implements ImageAccessResolver {
  currentAllowed = new Set<string>();
  historyAllowed = new Set<string>();
  calls: Array<{ kind: 'current' | 'history'; input: unknown }> = [];
  async canReadCurrent(input: Parameters<ImageAccessResolver['canReadCurrent']>[0]): Promise<boolean> {
    this.calls.push({ kind: 'current', input });
    return this.currentAllowed.has(`${input.contextType}:${input.contextId}:${input.imageId}:${input.actorOrNull?.accountId ?? 'anon'}`);
  }
  async canReadHistory(input: Parameters<ImageAccessResolver['canReadHistory']>[0]): Promise<boolean> {
    this.calls.push({ kind: 'history', input });
    return this.historyAllowed.has(`${input.historyId}:${input.imageId}:${input.actorOrNull?.accountId ?? 'anon'}`);
  }
}
