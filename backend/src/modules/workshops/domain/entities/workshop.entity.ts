export type WorkshopStatus = 'active' | 'suspended';

export class WorkshopProfileRules {
  static calculateMissingFields(
    workshop: {
      name?: string | null;
      address?: string | null;
      story?: string | null;
      avatar_image_id?: bigint | string | null;
      avatarImageId?: bigint | string | null;
    },
    attachedImagesCount: number,
  ): string[] {
    const missing: string[] = [];
    if (!workshop.name?.trim()) missing.push('name');
    if (!workshop.address?.trim()) missing.push('address');
    if (!workshop.story?.trim()) missing.push('story');
    const avatar = workshop.avatar_image_id !== undefined ? workshop.avatar_image_id : workshop.avatarImageId;
    if ((avatar === null || avatar === undefined) && attachedImagesCount === 0) missing.push('images');
    return missing;
  }

  static evaluateProfilePublicity(
    workshop: {
      status?: string;
      name?: string | null;
      address?: string | null;
      story?: string | null;
      avatar_image_id?: bigint | string | null;
      avatarImageId?: bigint | string | null;
    },
    attachedImagesCount: number,
  ): { isPublic: boolean; missingFields: string[] } {
    const missingFields = this.calculateMissingFields(workshop, attachedImagesCount);
    const isPublic = workshop.status === 'active' && missingFields.length === 0;
    return { isPublic, missingFields };
  }

  static validateCoordinates(
    latitude: number | null | undefined,
    longitude: number | null | undefined,
  ): boolean {
    const hasLat = latitude !== null && latitude !== undefined;
    const hasLng = longitude !== null && longitude !== undefined;
    if ((hasLat && !hasLng) || (!hasLat && hasLng)) return false;
    if (hasLat && hasLng) {
      if (latitude! < -90 || latitude! > 90 || longitude! < -180 || longitude! > 180) {
        return false;
      }
    }
    return true;
  }
}
