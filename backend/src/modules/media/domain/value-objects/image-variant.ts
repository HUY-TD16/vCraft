export type ImageVariant = 'thumbnail' | 'display';

/** Chỉ `thumbnail` hoặc `display`; không có endpoint đọc bản gốc hay đọc theo storage key (API 8.2). */
export function parseImageVariant(value: string): ImageVariant | null {
  return value === 'thumbnail' || value === 'display' ? value : null;
}
