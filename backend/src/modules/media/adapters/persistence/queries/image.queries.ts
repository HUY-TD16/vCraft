import { Prisma } from '../../../../../generated/prisma/client';

/** Advisory lock namespace dành riêng cho khóa theo context của Media. */
export const CONTEXT_LOCK_NAMESPACE = 7302;

export function claimImageForCleanupQuery(imageId: bigint, cutoff: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT i."id", i."quota_id", i."thumbnail_key", i."display_key",
           i."thumbnail_size_bytes", i."display_size_bytes", i."storage_state"
    FROM "Image" i
    WHERE i."id" = ${imageId}
      AND i."is_attached" = false
      AND i."unreferenced_at" <= ${cutoff}
      AND i."storage_state" IN ('ready', 'deleting')
      AND NOT EXISTS (SELECT 1 FROM "JournalHistoryImage" h WHERE h."image_id" = i."id")
      AND NOT EXISTS (SELECT 1 FROM "Workshop" w WHERE w."avatar_image_id" = i."id")
      AND NOT EXISTS (SELECT 1 FROM "Certificate" c WHERE c."image_id" = i."id")
    FOR UPDATE OF i`;
}

export function deleteClaimedImageQuery(imageId: bigint, cutoff: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT i."id", i."quota_id", i."thumbnail_key", i."display_key",
           i."thumbnail_size_bytes", i."display_size_bytes"
    FROM "Image" i
    WHERE i."id" = ${imageId}
      AND i."is_attached" = false
      AND i."unreferenced_at" <= ${cutoff}
      AND i."storage_state" = 'deleting'
      AND NOT EXISTS (SELECT 1 FROM "JournalHistoryImage" h WHERE h."image_id" = i."id")
      AND NOT EXISTS (SELECT 1 FROM "Workshop" w WHERE w."avatar_image_id" = i."id")
      AND NOT EXISTS (SELECT 1 FROM "Certificate" c WHERE c."image_id" = i."id")
    FOR UPDATE OF i`;
}

export function lockImagesByIdsQuery(imageIds: readonly bigint[]): Prisma.Sql {
  return Prisma.sql`
    SELECT "id" FROM "Image"
    WHERE "id" IN (${Prisma.join(imageIds)})
    ORDER BY "id" FOR UPDATE`;
}

export function lockImageContextQuery(namespace: number, contextKey: string): Prisma.Sql {
  return Prisma.sql`
    SELECT pg_advisory_xact_lock(${namespace}, hashtext(${contextKey}))::text AS locked`;
}
