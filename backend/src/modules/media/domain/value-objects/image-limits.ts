/** Hằng số giới hạn ảnh. Nguồn: SEC-10, SEC-14, API mục 8.1, data-design 2.26–2.28. */
export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

export const IMAGE_LIMITS = Object.freeze({
  maxFileBytes: 5 * MIB,
  maxRequestBodyBytes: 6 * MIB,
  maxPixels: 25_000_000,
  processingTimeoutMs: 10_000,
  thumbnailMaxEdge: 320,
  displayMaxEdge: 1_600,
  /** Tên định dạng theo metadata của Sharp. */
  allowedFormats: Object.freeze(['jpeg', 'png', 'webp'] as const),
});

export const UPLOAD_LIMITS = Object.freeze({
  maxUploadsPerMinutePerAccount: 20,
  maxConcurrentProcessingPerAccount: 2,
  /** Ngân sách giữ chỗ cho MỖI ảnh (đầu vào + tệp tạm + đầu ra). */
  reservationBudgetBytes: BigInt(16 * MIB),
  /** Lease của reservation: timeout xử lý (10 giây) cộng dư địa ghi tệp và quyết toán. */
  reservationLeaseMs: 30_000,
  unattachedTtlHours: 24,
  initialScopeTtlHours: 24,
  maxOpenInitialScopesPerAdmin: 3,
});

/** Hạn mức dung lượng, tính bằng byte (bigint để khớp cột BigInt của Prisma). */
export const QUOTA_LIMIT_BYTES = Object.freeze({
  workshop: BigInt(2 * GIB),
  account: BigInt(GIB),
  initialScope: BigInt(2 * GIB),
});
