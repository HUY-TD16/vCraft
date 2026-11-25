import { IMAGE_LIMITS } from './image-limits';

export interface Dimensions { readonly width: number; readonly height: number }
export interface VariantPlan { readonly thumbnail: Dimensions; readonly display: Dimensions }

/** Thu nhỏ để cạnh dài ≤ maxEdge, giữ tỉ lệ, KHÔNG phóng to, mỗi cạnh ≥ 1px. */
export function fitWithin(source: Dimensions, maxEdge: number): Dimensions {
  const { width, height } = source;
  if (![width, height, maxEdge].every(n => Number.isInteger(n) && n > 0)) {
    throw new RangeError('Invalid dimensions');
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return { width, height };
  const scale = maxEdge / longEdge;
  return {
    width: width === longEdge ? maxEdge : Math.max(1, Math.round(width * scale)),
    height: height === longEdge ? maxEdge : Math.max(1, Math.round(height * scale)),
  };
}

export function planVariants(source: Dimensions): VariantPlan {
  return {
    thumbnail: fitWithin(source, IMAGE_LIMITS.thumbnailMaxEdge),
    display: fitWithin(source, IMAGE_LIMITS.displayMaxEdge),
  };
}
