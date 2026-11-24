export interface ImageDto {
  id: string;
  thumbnail_url: string;
  display_url: string;
}

export interface PublicWorkshopSummaryDto {
  id: string;
  name: string;
  address: string;
  avatar_url: string | null;
  latitude: number | null;
  longitude: number | null;
  accepting_visitors: boolean;
}

export interface PublicWorkshopDto extends PublicWorkshopSummaryDto {
  story: string;
  images: ImageDto[];
  certificates: Array<{
    id: string;
    name: string;
    image: ImageDto;
  }>;
}

export interface OwnWorkshopDto extends Omit<PublicWorkshopDto, 'story' | 'address'> {
  story: string | null;
  address: string | null;
  status: 'active' | 'suspended';
  is_profile_public: boolean;
  missing_public_fields: string[];
  created_at: string;
  updated_at: string;
}

export interface AdminWorkshopDto extends OwnWorkshopDto {
  account: {
    id: string;
    username: string;
    display_name: string | null;
    role: string;
    workshop_id: string | null;
  };
}

export interface WorkshopStatusEventDto {
  id: string;
  prev_status: string | null;
  new_status: string;
  actor: {
    id: string;
    display_name: string | null;
  };
  reason: string | null;
  created_at: string;
}

export function buildWorkshopImageUrl(
  workshopId: string | bigint,
  imageId: string | bigint,
  variant: 'thumbnail' | 'display',
): string {
  return `/api/v1/media/current/workshop_profile/${workshopId}/images/${imageId}/${variant}`;
}

export function buildCertificateImageUrl(
  certificateId: string | bigint,
  imageId: string | bigint,
  variant: 'thumbnail' | 'display',
): string {
  return `/api/v1/media/current/certificate/${certificateId}/images/${imageId}/${variant}`;
}

export function toImageDto(workshopId: string | bigint, imageId: string | bigint): ImageDto {
  return {
    id: String(imageId),
    thumbnail_url: buildWorkshopImageUrl(workshopId, imageId, 'thumbnail'),
    display_url: buildWorkshopImageUrl(workshopId, imageId, 'display'),
  };
}

export function toCertificateImageDto(certificateId: string | bigint, imageId: string | bigint): ImageDto {
  return {
    id: String(imageId),
    thumbnail_url: buildCertificateImageUrl(certificateId, imageId, 'thumbnail'),
    display_url: buildCertificateImageUrl(certificateId, imageId, 'display'),
  };
}

export function toPublicWorkshopSummaryDto(w: any): PublicWorkshopSummaryDto {
  return {
    id: String(w.id),
    name: w.name,
    address: w.address ?? '',
    avatar_url: w.avatar_image_id ? buildWorkshopImageUrl(w.id, w.avatar_image_id, 'thumbnail') : null,
    latitude: w.latitude ? Number(w.latitude) : null,
    longitude: w.longitude ? Number(w.longitude) : null,
    accepting_visitors: Boolean(w.accepting_visitors),
  };
}

export function toPublicWorkshopDto(w: any, images: Array<{ id: bigint | string }>): PublicWorkshopDto {
  return {
    ...toPublicWorkshopSummaryDto(w),
    story: w.story ?? '',
    images: images.map(img => toImageDto(w.id, img.id)),
    certificates: (w.certificates ?? []).map((c: any) => ({
      id: String(c.id),
      name: c.name,
      image: toCertificateImageDto(c.id, c.image_id),
    })),
  };
}

export function toOwnWorkshopDto(
  w: any,
  images: Array<{ id: bigint | string }>,
  isProfilePublic: boolean,
  missingPublicFields: string[],
): OwnWorkshopDto {
  return {
    ...toPublicWorkshopDto(w, images),
    story: w.story ?? null,
    address: w.address ?? null,
    status: w.status,
    is_profile_public: isProfilePublic,
    missing_public_fields: missingPublicFields,
    created_at: w.created_at instanceof Date ? w.created_at.toISOString() : String(w.created_at),
    updated_at: w.updated_at instanceof Date ? w.updated_at.toISOString() : String(w.updated_at),
  };
}

export function toAdminWorkshopDto(
  w: any,
  images: Array<{ id: bigint | string }>,
  isProfilePublic: boolean,
  missingPublicFields: string[],
): AdminWorkshopDto {
  return {
    ...toOwnWorkshopDto(w, images, isProfilePublic, missingPublicFields),
    account: {
      id: String(w.account.id),
      username: w.account.username,
      display_name: w.account.display_name,
      role: w.account.role,
      workshop_id: String(w.id),
    },
  };
}

export function toStatusEventDto(l: any): WorkshopStatusEventDto {
  return {
    id: String(l.id),
    prev_status: l.prev_status,
    new_status: l.new_status,
    actor: {
      id: String(l.performedBy.id),
      display_name: l.performedBy.display_name ?? l.performedBy.username,
    },
    reason: l.reason,
    created_at: l.created_at instanceof Date ? l.created_at.toISOString() : String(l.created_at),
  };
}
