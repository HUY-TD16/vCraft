import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { Roles, SessionLevels } from '../../../../../common/security/decorators/access-policy';
import { CurrentActor } from '../../../../../common/security/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../../../common/application/types/contract-types';
import { IdentityService } from '../../../application/services/identity.service';
import { CreateArtisanAccountDto } from '../dtos/create-artisan-account.dto';
import { AdminResetPasswordDto } from '../dtos/admin-reset-password.dto';

@Controller('admin/accounts')
@Roles('admin')
@SessionLevels('normal')
export class AdminAccountsController {
  constructor(private readonly identityService: IdentityService) {}

  @Post('artisan')
  @HttpCode(HttpStatus.CREATED)
  async createArtisan(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() dto: CreateArtisanAccountDto,
  ) {
    return this.identityService.createArtisanAccount(actor, dto);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: AdminResetPasswordDto,
  ) {
    return this.identityService.resetPassword(actor, id, dto);
  }
}
