import type { Id } from '../../../../../common/application/types/contract-types';
import type { UploadReservationState, ReservationStatus } from '../../../domain/entities/upload-reservation.entity';
import type { UploadScopeStatus } from '../../../domain/policies/upload-scope.policy';
import { IMAGE_CONTEXT_TYPES, type ImageContextType } from '../../../domain/value-objects/image-context';
import type {
  ImageRecord, ImageStateRecord, StorageQuotaRecord, UploadReservationRecord, UploadScopeRecord,
} from '../../../application/ports/repositories/media-repositories.port';

const MAX_BIGINT = BigInt('9223372036854775807');
const ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ID trong contract là chuỗi số dương; DB dùng bigint. Sai định dạng là lỗi lập trình (đầu vào đã được validate ở HTTP). */
export function idToBigInt(id: Id): bigint {
  if (!ID_PATTERN.test(id)) throw new RangeError('Invalid id');
  const value = BigInt(id);
  if (value > MAX_BIGINT) throw new RangeError('Invalid id');
  return value;
}
export function bigintToId(value: bigint): Id { return value.toString(); }
export function nullableIdToBigInt(id: Id | null): bigint | null { return id === null ? null : idToBigInt(id); }
export function nullableBigintToId(value: bigint | null): Id | null { return value === null ? null : bigintToId(value); }
export function isUuid(value: string): boolean { return UUID_PATTERN.test(value); }

export function parseContextType(value: string): ImageContextType {
  if (!(IMAGE_CONTEXT_TYPES as readonly string[]).includes(value)) throw new Error(`Unexpected context_type: ${value}`);
  return value as ImageContextType;
}
function parseReservationStatus(value: string): ReservationStatus {
  if (value !== 'reserved' && value !== 'committed' && value !== 'cleanup_pending' && value !== 'released') {
    throw new Error(`Unexpected reservation status: ${value}`);
  }
  return value;
}
function parseScopeStatus(value: string): UploadScopeStatus {
  if (value !== 'open' && value !== 'attached' && value !== 'expired') throw new Error(`Unexpected scope status: ${value}`);
  return value;
}

export interface QuotaRow { readonly id: bigint; readonly limit_bytes: bigint; readonly used_bytes: bigint; readonly reserved_bytes: bigint }
export interface ReservationRow {
  readonly id: bigint; readonly quota_id: bigint; readonly uploaded_by: bigint; readonly context_type: string;
  readonly context_id: bigint | null; readonly budget_bytes: bigint; readonly actual_bytes: bigint | null;
  readonly status: string; readonly storage_prefix: string; readonly expires_at: Date;
}
export interface ScopeRow { readonly initial_workshop_key: string; readonly created_by: bigint; readonly status: string; readonly expires_at: Date }
export interface ImageRow {
  readonly id: bigint; readonly uploaded_by: bigint; readonly context_type: string; readonly context_id: bigint | null;
  readonly thumbnail_key: string; readonly display_key: string; readonly thumbnail_size_bytes: bigint; readonly display_size_bytes: bigint;
  readonly quota_id: bigint; readonly reservation_id: bigint; readonly width: number; readonly height: number;
  readonly unreferenced_at: Date | null;
}

export function toQuotaRecord(row: QuotaRow): StorageQuotaRecord {
  return {
    id: bigintToId(row.id),
    state: { limitBytes: row.limit_bytes, usedBytes: row.used_bytes, reservedBytes: row.reserved_bytes },
  };
}

export function toReservationRecord(row: ReservationRow): UploadReservationRecord {
  const state: UploadReservationState = {
    status: parseReservationStatus(row.status),
    budgetBytes: row.budget_bytes,
    actualBytes: row.actual_bytes,
    expiresAt: row.expires_at,
  };
  return {
    id: bigintToId(row.id), quotaId: bigintToId(row.quota_id), uploadedBy: bigintToId(row.uploaded_by),
    contextType: parseContextType(row.context_type), contextId: nullableBigintToId(row.context_id),
    storagePrefix: row.storage_prefix, state,
  };
}

export function toScopeRecord(row: ScopeRow): UploadScopeRecord {
  return {
    initialWorkshopKey: row.initial_workshop_key, createdBy: bigintToId(row.created_by),
    status: parseScopeStatus(row.status), expiresAt: row.expires_at,
  };
}

export function toImageRecord(row: ImageRow): ImageRecord {
  return {
    id: bigintToId(row.id), uploadedBy: bigintToId(row.uploaded_by), contextType: parseContextType(row.context_type),
    contextId: nullableBigintToId(row.context_id), thumbnailKey: row.thumbnail_key, displayKey: row.display_key,
    thumbnailSizeBytes: row.thumbnail_size_bytes, displaySizeBytes: row.display_size_bytes,
    quotaId: bigintToId(row.quota_id), reservationId: bigintToId(row.reservation_id),
    width: row.width, height: row.height, unreferencedAt: row.unreferenced_at ?? new Date(0),
  };
}

export interface ImageStateRow {
  readonly id: bigint; readonly uploaded_by: bigint; readonly context_type: string; readonly context_id: bigint | null;
  readonly quota_id: bigint; readonly is_attached: boolean; readonly storage_state: string; readonly unreferenced_at: Date | null;
  readonly thumbnail_key: string; readonly display_key: string;
  readonly thumbnail_size_bytes: bigint; readonly display_size_bytes: bigint;
  readonly quota: { readonly workshop_id: bigint | null };
}

export function toImageStateRecord(row: ImageStateRow): ImageStateRecord {
  if (row.storage_state !== 'ready' && row.storage_state !== 'deleting') {
    throw new Error(`Unexpected storage_state: ${row.storage_state}`);
  }
  return {
    id: bigintToId(row.id), uploadedBy: bigintToId(row.uploaded_by), contextType: parseContextType(row.context_type),
    contextId: nullableBigintToId(row.context_id), quotaId: bigintToId(row.quota_id),
    quotaWorkshopId: nullableBigintToId(row.quota.workshop_id),
    isAttached: row.is_attached, storageState: row.storage_state, unreferencedAt: row.unreferenced_at,
    thumbnailKey: row.thumbnail_key, displayKey: row.display_key,
    thumbnailSizeBytes: row.thumbnail_size_bytes, displaySizeBytes: row.display_size_bytes,
  };
}
