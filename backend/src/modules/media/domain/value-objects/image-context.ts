export const IMAGE_CONTEXT_TYPES = Object.freeze([
  'workshop_profile', 'certificate', 'product', 'journal_entry',
] as const);

export type ImageContextType = (typeof IMAGE_CONTEXT_TYPES)[number];

export function isImageContextType(value: unknown): value is ImageContextType {
  return typeof value === 'string' && (IMAGE_CONTEXT_TYPES as readonly string[]).includes(value);
}

/**
 * Số ảnh tối đa gắn với MỘT đối tượng sở hữu (API 8.1).
 * Lưu ý: workshop_profile = 10 ảnh xưởng; chưa rõ ảnh đại diện có tính vào 10 hay không (cần chốt với Người A).
 */
export const MAX_IMAGES_PER_OBJECT: Readonly<Record<ImageContextType, number>> = Object.freeze({
  product: 10,
  journal_entry: 10,
  workshop_profile: 10,
  certificate: 20,
});
