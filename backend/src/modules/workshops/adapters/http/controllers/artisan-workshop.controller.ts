import { Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { Roles, SessionLevels } from '../../../../../common/security/decorators/access-policy';
import { CurrentActor } from '../../../../../common/security/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../../../common/application/types/contract-types';
import { WorkshopService } from '../../../application/services/workshop.service';
import { UpdateWorkshopProfileDto, UpdateWorkshopVisitorsDto } from '../dtos/workshop.dto';

@Controller('artisan/workshop')
@Roles('artisan')
@SessionLevels('normal')
export class ArtisanWorkshopController {
  constructor(private readonly workshopService: WorkshopService) {}

  @Get()
  async getOwnWorkshop(@CurrentActor() actor: AuthenticatedActor) {
    return this.workshopService.getOwnWorkshop(actor);
  }

  @Put()
  async updateOwnWorkshop(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() dto: UpdateWorkshopProfileDto,
  ) {
    return this.workshopService.updateOwnWorkshop(actor, dto);
  }

  @Patch('visitors')
  async updateVisitors(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() dto: UpdateWorkshopVisitorsDto,
  ) {
    return this.workshopService.updateVisitors(actor, dto);
  }
}
