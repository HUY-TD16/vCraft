import {
  Controller,
  Body,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { Public, Roles, SessionLevels } from '../../../../../common/security/decorators/access-policy';
import { CurrentActor } from '../../../../../common/security/decorators/current-actor.decorator';
import type { AuthenticatedActor, TrustedActor } from '../../../../../common/application/types/contract-types';
import { APP_CONFIG, type AppConfig } from '../../../../../common/config/app-config';
import { BusinessRuleException } from '../../../../../common/domain/errors/business-rule.exception';
import { IDENTITY_CONTRACT, type IIdentityContract } from '../../../../identity/public/contracts/identity.contract';
import { isImageContextType } from '../../../domain/value-objects/image-context';
import { parseImageVariant } from '../../../domain/value-objects/image-variant';
import type { ImageContextType } from '../../../domain/value-objects/image-context';
import { IMAGE_LIMITS } from '../../../domain/value-objects/image-limits';
import { CREATE_UPLOAD_SCOPE_USE_CASE, GET_IMAGE_USE_CASE, UPLOAD_IMAGE_USE_CASE } from '../../../application/media-application.providers';
import type { GetImageUseCase } from '../../../application/use-cases/images/get-image.use-case';
import type { ImageSource } from '../../../application/dtos/media-use-case.dtos';
import type { CreateUploadScopeUseCase } from '../../../application/use-cases/uploads/create-upload-scope.use-case';
import type { UploadImageUseCase } from '../../../application/use-cases/uploads/upload-image.use-case';
import { MediaUploadRateLimitGuard } from '../media-upload-rate-limit.guard';
import { IMAGE_STORAGE, type ImageStorage } from '../../../application/ports/image-storage.port';
import type { MediaUploadBodyDto } from '../dtos/media.dto';
import { toCreatedUploadScopeDto, toUploadedImageDto } from '../mappers/media.mapper';

function requireId(value: string, field: string): string {
  if (!/^\d+$/.test(value)) throw new BusinessRuleException('INVALID_INPUT', 'INVALID_INPUT', { field });
  return value;
}

@Controller('media')
@Roles('artisan', 'admin')
@SessionLevels('normal')
export class MediaController {
  constructor(
    @Inject(UPLOAD_IMAGE_USE_CASE) private readonly uploadImage: UploadImageUseCase,
    @Inject(GET_IMAGE_USE_CASE) private readonly getImage: GetImageUseCase,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
    @Inject(IDENTITY_CONTRACT) private readonly identity: IIdentityContract,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'NODE_ENV'>,
  ) {}

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(MediaUploadRateLimitGuard)
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: IMAGE_LIMITS.maxFileBytes, files: 1, fields: 5, fieldSize: 4096, parts: 6 },
  }))
  async upload(
    @CurrentActor() actor: AuthenticatedActor,
    @UploadedFile() file: { buffer: Uint8Array } | undefined,
    @Body() body: MediaUploadBodyDto,
  ) {
    if (!file?.buffer) throw new BusinessRuleException('INVALID_INPUT', 'INVALID_INPUT', { field: 'file' });
    const contextType = body.context_type;
    if (!isImageContextType(contextType)) {
      throw new BusinessRuleException('INVALID_INPUT', 'INVALID_INPUT', { field: 'context_type' });
    }
    const contextId = body.context_id === undefined || body.context_id === ''
      ? null
      : requireId(String(body.context_id), 'context_id');

    let target: { kind: 'workshop'; workshopId: string } | { kind: 'initial_scope'; initialWorkshopKey: string };
    if (actor.role === 'admin') {
      if (contextType !== 'workshop_profile' || contextId !== null || body.target_workshop_id !== undefined) {
        throw new BusinessRuleException('PERMISSION_DENIED');
      }
      const initialWorkshopKey = body.initial_workshop_key;
      if (typeof initialWorkshopKey !== 'string' || initialWorkshopKey.length === 0) {
        throw new BusinessRuleException('INVALID_INPUT', 'INVALID_INPUT', { field: 'initial_workshop_key' });
      }
      target = { kind: 'initial_scope', initialWorkshopKey };
    } else {
      if (typeof body.target_workshop_id !== 'string') {
        throw new BusinessRuleException('INVALID_INPUT', 'INVALID_INPUT', { field: 'target_workshop_id' });
      }
      target = { kind: 'workshop', workshopId: requireId(body.target_workshop_id, 'target_workshop_id') };
    }

    const result = await this.uploadImage.execute({
      actor,
      file: file.buffer,
      contextType,
      contextId,
      target,
    });
    return toUploadedImageDto(result);
  }

  @Public()
  @Get('current/:contextType/:contextId/images/:imageId/:variant')
  async currentImage(
    @Param('contextType') contextTypeRaw: string,
    @Param('contextId') contextIdRaw: string,
    @Param('imageId') imageIdRaw: string,
    @Param('variant') variantRaw: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    if (!isImageContextType(contextTypeRaw)) throw new BusinessRuleException('RESOURCE_NOT_FOUND');
    const contextType: ImageContextType = contextTypeRaw;
    const source: ImageSource = {
      kind: 'current',
      contextType,
      contextId: requireId(contextIdRaw, 'context_id'),
      imageId: requireId(imageIdRaw, 'image_id'),
    };
    return this.streamImage(source, await this.optionalActor(request), variantRaw, response);
  }

  @Get('pending/:imageId/:variant')
  async pendingImage(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('imageId') imageIdRaw: string,
    @Param('variant') variantRaw: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    return this.streamImage({ kind: 'pending', imageId: requireId(imageIdRaw, 'image_id') }, actor, variantRaw, response);
  }

  @Get('history/:historyId/images/:imageId/:variant')
  async historicalImage(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('historyId') historyIdRaw: string,
    @Param('imageId') imageIdRaw: string,
    @Param('variant') variantRaw: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    return this.streamImage({
      kind: 'history',
      historyId: requireId(historyIdRaw, 'history_id'),
      imageId: requireId(imageIdRaw, 'image_id'),
    }, actor, variantRaw, response);
  }

  private async streamImage(
    source: ImageSource,
    actor: TrustedActor | null,
    variantRaw: string,
    response: Response,
  ): Promise<StreamableFile> {
    const variant = parseImageVariant(variantRaw);
    if (variant === null) throw new BusinessRuleException('RESOURCE_NOT_FOUND');
    const target = await this.getImage.execute({ actorOrNull: actor, source, variant });
    const stream = await this.storage.read(target.key);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(stream, { type: target.contentType, length: Number(target.sizeBytes) });
  }

  private async optionalActor(request: Request): Promise<TrustedActor | null> {
    const cookieName = this.config.NODE_ENV === 'development' ? 'vcraft-session' : '__Host-vcraft-session';
    const token = request.cookies?.[cookieName];
    if (typeof token !== 'string' || token.length === 0) return null;
    const actor = await this.identity.resolveSession(token);
    return actor?.sessionLevel === 'normal' ? actor : null;
  }
}

@Controller('admin/workshop-upload-scopes')
@Roles('admin')
@SessionLevels('normal')
export class AdminWorkshopUploadScopesController {
  constructor(@Inject(CREATE_UPLOAD_SCOPE_USE_CASE) private readonly createScope: CreateUploadScopeUseCase) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentActor() actor: AuthenticatedActor) {
    const result = await this.createScope.execute({ actor });
    return toCreatedUploadScopeDto(result);
  }
}
