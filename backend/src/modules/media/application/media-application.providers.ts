import type { Provider } from '@nestjs/common';
import { TRANSACTION_RUNNER } from '../../../common/application/ports/transaction-runner';
import { APP_CONFIG } from '../../../common/config/app-config';
import { SharpImageProcessor } from '../adapters/image-processing/sharp-image-processor';
import { LocalImageStorage } from '../adapters/storage/local-image-storage';
import { LocalStorageCapacity } from '../adapters/storage/local-storage-capacity';
import { IMAGE_PROCESSOR } from './ports/image-processor.port';
import { IMAGE_STORAGE } from './ports/image-storage.port';
import { STORAGE_CAPACITY } from './ports/storage-capacity.port';
import { ADMIN_ASSERTION } from './ports/admin-assertion.port';
import { IMAGE_ACCESS_RESOLVER } from './ports/queries/image-access-resolver.port';
import {
  IMAGE_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
  UPLOAD_RESERVATION_REPOSITORY,
  UPLOAD_SCOPE_REPOSITORY,
} from './ports/repositories/media-repositories.port';
import { GetImageUseCase } from './use-cases/images/get-image.use-case';
import { CreateUploadScopeUseCase } from './use-cases/uploads/create-upload-scope.use-case';
import { UploadImageUseCase } from './use-cases/uploads/upload-image.use-case';
import { ReservationCleanupService } from './services/reservation-cleanup.service';
import { ReservationCleanupScheduler } from '../adapters/jobs/reservation-cleanup.scheduler';
import { UploadRateLimiterService } from './services/upload-rate-limiter.service';
import { MediaUploadRateLimitGuard } from '../adapters/http/media-upload-rate-limit.guard';

export const GET_IMAGE_USE_CASE = Symbol('GET_IMAGE_USE_CASE');
export const CREATE_UPLOAD_SCOPE_USE_CASE = Symbol('CREATE_UPLOAD_SCOPE_USE_CASE');
export const UPLOAD_IMAGE_USE_CASE = Symbol('UPLOAD_IMAGE_USE_CASE');

export const MEDIA_APPLICATION_PROVIDERS: Provider[] = [
  ReservationCleanupScheduler,
  UploadRateLimiterService,
  MediaUploadRateLimitGuard,
  { provide: IMAGE_PROCESSOR, useFactory: () => new SharpImageProcessor() },
  {
    provide: IMAGE_STORAGE,
    inject: [APP_CONFIG],
    useFactory: (config: { UPLOAD_DIR: string }) => new LocalImageStorage(config.UPLOAD_DIR),
  },
  { provide: STORAGE_CAPACITY, useExisting: LocalStorageCapacity },
  LocalStorageCapacity,
  {
    provide: ReservationCleanupService,
    inject: [TRANSACTION_RUNNER, STORAGE_QUOTA_REPOSITORY, UPLOAD_RESERVATION_REPOSITORY, IMAGE_REPOSITORY, IMAGE_STORAGE],
    useFactory: (txRunner, quotas, reservations, images, storage) =>
      new ReservationCleanupService({ txRunner, quotas, reservations, images, storage }),
  },
  {
    provide: UPLOAD_IMAGE_USE_CASE,
    inject: [
      TRANSACTION_RUNNER,
      STORAGE_QUOTA_REPOSITORY,
      UPLOAD_SCOPE_REPOSITORY,
      UPLOAD_RESERVATION_REPOSITORY,
      IMAGE_REPOSITORY,
      IMAGE_PROCESSOR,
      IMAGE_STORAGE,
      STORAGE_CAPACITY,
      ReservationCleanupService,
      ADMIN_ASSERTION,
      IMAGE_ACCESS_RESOLVER,
    ],
    useFactory: (txRunner, quotas, scopes, reservations, images, processor, storage, capacity, cleanup, admins, access) =>
      new UploadImageUseCase({
        txRunner, quotas, scopes, reservations, images, processor, storage, capacity, cleanup, admins, access,
      }),
  },
  {
    provide: CREATE_UPLOAD_SCOPE_USE_CASE,
    inject: [TRANSACTION_RUNNER, UPLOAD_SCOPE_REPOSITORY, UPLOAD_RESERVATION_REPOSITORY, ADMIN_ASSERTION],
    useFactory: (txRunner, scopes, reservations, admins) =>
      new CreateUploadScopeUseCase({ txRunner, scopes, reservations, admins }),
  },
  {
    provide: GET_IMAGE_USE_CASE,
    inject: [TRANSACTION_RUNNER, IMAGE_REPOSITORY, UPLOAD_RESERVATION_REPOSITORY, IMAGE_ACCESS_RESOLVER],
    useFactory: (txRunner, images, reservations, access) =>
      new GetImageUseCase({ txRunner, images, reservations, access }),
  },
];
