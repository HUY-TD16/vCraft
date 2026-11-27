import { StreamableFile } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedActor } from '../../../../src/common/application/types/contract-types';
import { BusinessRuleException } from '../../../../src/common/domain/errors/business-rule.exception';
import { MediaController, AdminWorkshopUploadScopesController } from '../../../../src/modules/media/adapters/http/controllers/media.controller';
import type { GetImageUseCase } from '../../../../src/modules/media/application/use-cases/images/get-image.use-case';
import type { CreateUploadScopeUseCase } from '../../../../src/modules/media/application/use-cases/uploads/create-upload-scope.use-case';
import type { UploadImageUseCase } from '../../../../src/modules/media/application/use-cases/uploads/upload-image.use-case';
import type { ImageStorage } from '../../../../src/modules/media/application/ports/image-storage.port';
import type { IIdentityContract } from '../../../../src/modules/identity/public/contracts/identity.contract';

const artisan: AuthenticatedActor = {
  accountId: '42', role: 'artisan', workshopId: '7', authVersion: 1, sessionId: 'session-1', sessionLevel: 'normal',
};
const admin: AuthenticatedActor = {
  accountId: '99', role: 'admin', workshopId: null, authVersion: 1, sessionId: 'session-admin', sessionLevel: 'normal',
};

describe('Media HTTP controllers', () => {
  let upload: { execute: ReturnType<typeof vi.fn> };
  let getImage: { execute: ReturnType<typeof vi.fn> };
  let storage: { read: ReturnType<typeof vi.fn> };
  let identity: { resolveSession: ReturnType<typeof vi.fn> };
  let controller: MediaController;

  beforeEach(() => {
    upload = { execute: vi.fn().mockResolvedValue({
      imageId: '123', contextType: 'workshop_profile', contextId: null,
      unattachedExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
    }) };
    getImage = { execute: vi.fn().mockResolvedValue({ key: 'private/display.webp', sizeBytes: 20n, contentType: 'image/webp' }) };
    storage = { read: vi.fn().mockResolvedValue({ pipe: vi.fn() }) };
    identity = { resolveSession: vi.fn().mockResolvedValue(null) };
    controller = new MediaController(
      upload as unknown as UploadImageUseCase,
      getImage as unknown as GetImageUseCase,
      storage as unknown as ImageStorage,
      identity as unknown as IIdentityContract,
      { NODE_ENV: 'development' },
    );
  });

  it('uploads a workshop image and maps the result into the API DTO', async () => {
    const buffer = new Uint8Array([1, 2, 3]);
    const result = await controller.upload(artisan, { buffer }, {
      context_type: 'workshop_profile', target_workshop_id: '7',
    });

    expect(upload.execute).toHaveBeenCalledWith({
      actor: artisan, file: buffer, contextType: 'workshop_profile', contextId: null,
      target: { kind: 'workshop', workshopId: '7' },
    });
    expect(result).toEqual({
      image_id: '123', context_type: 'workshop_profile', context_id: null,
      thumbnail_url: '/api/v1/media/pending/123/thumbnail',
      display_url: '/api/v1/media/pending/123/display',
      unattached_expires_at: '2026-12-01T00:00:00.000Z',
    });
  });

  it('rejects a missing upload file and invalid context before calling the upload use case', async () => {
    await expect(controller.upload(artisan, undefined, { context_type: 'workshop_profile', target_workshop_id: '7' }))
      .rejects.toBeInstanceOf(BusinessRuleException);
    await expect(controller.upload(artisan, { buffer: new Uint8Array([1]) }, { context_type: 'unknown', target_workshop_id: '7' }))
      .rejects.toBeInstanceOf(BusinessRuleException);
    expect(upload.execute).not.toHaveBeenCalled();
  });

  it('allows admins to upload only through an initial workshop scope', async () => {
    await controller.upload(admin, { buffer: new Uint8Array([1]) }, {
      context_type: 'workshop_profile', initial_workshop_key: 'initial-key',
    });
    expect(upload.execute).toHaveBeenCalledWith(expect.objectContaining({
      actor: admin, target: { kind: 'initial_scope', initialWorkshopKey: 'initial-key' },
    }));

    await expect(controller.upload(admin, { buffer: new Uint8Array([1]) }, {
      context_type: 'certificate', initial_workshop_key: 'initial-key',
    })).rejects.toBeInstanceOf(BusinessRuleException);
  });

  it('creates an admin upload scope and returns its HTTP response shape', async () => {
    const createScope = { execute: vi.fn().mockResolvedValue({
      initialWorkshopKey: 'initial-key', expiresAt: new Date('2026-12-02T00:00:00.000Z'),
    }) };
    const scopesController = new AdminWorkshopUploadScopesController(createScope as unknown as CreateUploadScopeUseCase);

    await expect(scopesController.create(admin)).resolves.toEqual({
      initial_workshop_key: 'initial-key', expires_at: '2026-12-02T00:00:00.000Z',
    });
    expect(createScope.execute).toHaveBeenCalledWith({ actor: admin });
  });

  it('streams a pending image with secure response headers after authorization', async () => {
    const response = { setHeader: vi.fn() };
    const result = await controller.pendingImage(artisan, '123', 'display', response as never);

    expect(result).toBeInstanceOf(StreamableFile);
    expect(getImage.execute).toHaveBeenCalledWith({
      actorOrNull: artisan, source: { kind: 'pending', imageId: '123' }, variant: 'display',
    });
    expect(storage.read).toHaveBeenCalledWith('private/display.webp');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
  });

  it('streams public current images anonymously and hides invalid variants as not found', async () => {
    const response = { setHeader: vi.fn() };
    await controller.currentImage('workshop_profile', '7', '123', 'thumbnail', { cookies: {} } as never, response as never);
    expect(getImage.execute).toHaveBeenCalledWith({
      actorOrNull: null,
      source: { kind: 'current', contextType: 'workshop_profile', contextId: '7', imageId: '123' },
      variant: 'thumbnail',
    });

    await expect(controller.pendingImage(artisan, '123', 'original', response as never))
      .rejects.toBeInstanceOf(BusinessRuleException);
  });

  it('passes history image identifiers and actor to the image use case', async () => {
    const response = { setHeader: vi.fn() };
    await controller.historicalImage(artisan, '88', '123', 'thumbnail', response as never);

    expect(getImage.execute).toHaveBeenCalledWith({
      actorOrNull: artisan, source: { kind: 'history', historyId: '88', imageId: '123' }, variant: 'thumbnail',
    });
  });
});
