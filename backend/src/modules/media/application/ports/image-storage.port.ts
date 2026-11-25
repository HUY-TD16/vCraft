import type { Readable } from 'node:stream';

export const IMAGE_STORAGE = Symbol('IMAGE_STORAGE');

export class StorageObjectNotFoundError extends Error {
  constructor() {
    super('Storage object not found');
    this.name = 'StorageObjectNotFoundError';
  }
}

/** Khóa/tiền tố do server sinh ra nhưng sai định dạng: lỗi lập trình, không phải lỗi người dùng. */
export class InvalidStorageKeyError extends RangeError {
  constructor() {
    super('Invalid storage key');
    this.name = 'InvalidStorageKeyError';
  }
}

export interface ImageStorage {
  /** Ghi nguyên tử (tệp tạm rồi đổi tên). Ghi lại cùng khóa sẽ thay thế. */
  write(key: string, data: Uint8Array): Promise<void>;
  /** Mở luồng đọc. Không có tệp → StorageObjectNotFoundError (ném trước khi trả luồng). */
  read(key: string): Promise<Readable>;
  /** Xóa một tệp. Không tồn tại vẫn thành công (idempotent). */
  delete(key: string): Promise<void>;
  /** Xóa toàn bộ thư mục theo tiền tố, kể cả tệp tạm bị bỏ dở. Không tồn tại vẫn thành công. */
  deletePrefix(prefix: string): Promise<void>;
}
