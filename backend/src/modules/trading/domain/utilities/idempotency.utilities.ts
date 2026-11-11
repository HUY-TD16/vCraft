import { createHash } from 'node:crypto';
import { InvalidTradingInputError } from '../errors/trading-domain.errors';

/**
 * Biểu thức chính quy kiểm tra định dạng RFC 4122 Version 4 UUID:
 * - 36 ký tự bao gồm 4 dấu gạch ngang: 8-4-4-4-12
 * - Chữ số thứ 13 là '4' (Version 4)
 * - Chữ số thứ 17 là một trong các ký tự '8', '9', 'a', 'b', 'A', 'B' (RFC 4122 variant 10xx)
 */
export const RFC4122_UUID_V4_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

export interface ValidateUuidOptions {
  /**
   * Nếu true, tự động cắt khoảng trắng đầu và cuối chuỗi trước khi kiểm tra định dạng.
   * Mặc định là true để tương thích với HTTP headers và input từ client.
   */
  readonly trim?: boolean;
}

/**
 * Type guard kiểm tra giá trị có phải là chuỗi UUID v4 hợp lệ theo RFC 4122 hay không.
 * Trả về false đối với mọi giá trị null, undefined, không phải chuỗi, chuỗi rỗng,
 * sai độ dài, sai phiên bản, hoặc chứa ký tự không hợp lệ.
 */
export function validateUuidV4(
  value: unknown,
  options: ValidateUuidOptions = {},
): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const shouldTrim = options.trim ?? true;
  const candidate = shouldTrim ? value.trim() : value;
  if (candidate.length !== 36) {
    return false;
  }
  return RFC4122_UUID_V4_REGEX.test(candidate);
}

/**
 * Chuẩn hóa và thẩm định chuỗi UUID v4 cho X-Idempotency-Key.
 * Tự động cắt khoảng trắng, chuyển về chữ thường.
 * Ném InvalidTradingInputError (HTTP 400 INVALID_INPUT) nếu không hợp lệ.
 */
export function normalizeUuidV4(
  value: unknown,
  fieldName: string = 'X-Idempotency-Key',
): string {
  if (typeof value !== 'string') {
    throw new InvalidTradingInputError(
      `${fieldName} must be a valid UUID v4 string.`,
      { field: fieldName },
    );
  }
  const trimmed = value.trim().toLowerCase();
  if (!validateUuidV4(trimmed)) {
    throw new InvalidTradingInputError(
      `${fieldName} must be a valid RFC 4122 UUID v4 format.`,
      { field: fieldName },
    );
  }
  return trimmed;
}

/**
 * Đệ quy chuẩn tắc hóa cấu trúc dữ liệu để tuần tự hóa JSON tất định:
 * - Đối tượng: Sắp xếp toàn bộ keys theo thứ tự từ điển (alphabetical/ASCII). Bỏ qua các key có giá trị undefined.
 * - Mảng: Giữ nguyên thứ tự phần tử (array index order), đệ quy chuẩn tắc hóa các phần tử con.
 * - Dữ liệu nguyên thủy: Giữ nguyên string, boolean; chuẩn hóa Date thành ISO string; BigInt thành string; số không hữu hạn thành null.
 * - Phát hiện và ngăn chặn vòng lặp tham chiếu (Circular Reference) qua WeakSet.
 */
export function canonicalizeJson(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'symbol' || typeof value === 'function') {
    return undefined;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new InvalidTradingInputError(
        'Circular reference detected during canonical JSON serialization.',
        { field: 'payload' },
      );
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => {
        const canonicalItem = canonicalizeJson(item, seen);
        return canonicalItem === undefined ? null : canonicalItem;
      });
    }

    const sortedKeys = Object.keys(value).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const canonicalVal = canonicalizeJson(
        (value as Record<string, unknown>)[key],
        seen,
      );
      if (canonicalVal !== undefined) {
        result[key] = canonicalVal;
      }
    }
    return result;
  }

  return undefined;
}

/**
 * Tính toán mã băm dấu vết chuẩn tắc SHA-256 (64 ký tự hex) cho payload:
 * - Chuẩn hóa payload rỗng/null/undefined thành '{}'.
 * - Tự động parse nếu payload là chuỗi JSON thô.
 * - Sắp xếp đệ quy tất định mọi thuộc tính.
 * - Băm bằng SHA-256 tạo chuỗi 64 ký tự hex viết thường.
 */
export function computeCanonicalFingerprint(payload: unknown): string {
  let normalizedPayload = payload;
  if (typeof payload === 'string') {
    try {
      normalizedPayload = JSON.parse(payload);
    } catch {
      normalizedPayload = payload;
    }
  }

  const target =
    normalizedPayload === undefined || normalizedPayload === null
      ? {}
      : normalizedPayload;

  const canonicalData = canonicalizeJson(target);
  const canonicalJsonString = JSON.stringify(canonicalData);

  return createHash('sha256')
    .update(canonicalJsonString, 'utf8')
    .digest('hex');
}
