import type { Provider } from '@nestjs/common';
import {
  IMAGE_REPOSITORY, STORAGE_QUOTA_REPOSITORY, UPLOAD_RESERVATION_REPOSITORY, UPLOAD_SCOPE_REPOSITORY,
} from '../../application/ports/repositories/media-repositories.port';
import { PrismaImageRepository } from './repositories/prisma-image.repository';
import { PrismaStorageQuotaRepository } from './repositories/prisma-storage-quota.repository';
import { PrismaUploadReservationRepository } from './repositories/prisma-upload-reservation.repository';
import { PrismaUploadScopeRepository } from './repositories/prisma-upload-scope.repository';

export const MEDIA_PERSISTENCE_PROVIDERS: Provider[] = [
  { provide: STORAGE_QUOTA_REPOSITORY, useClass: PrismaStorageQuotaRepository },
  { provide: UPLOAD_SCOPE_REPOSITORY, useClass: PrismaUploadScopeRepository },
  { provide: UPLOAD_RESERVATION_REPOSITORY, useClass: PrismaUploadReservationRepository },
  { provide: IMAGE_REPOSITORY, useClass: PrismaImageRepository },
];
