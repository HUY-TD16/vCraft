import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Roles, SessionLevels } from '../../../../../common/security/decorators/access-policy';
import { CurrentActor } from '../../../../../common/security/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../../../common/application/types/contract-types';
import { WorkshopService } from '../../../application/services/workshop.service';
import {
  ChangeWorkshopStatusDto,
  ListAdminWorkshopsQueryDto,
  PaginationQueryDto,
} from '../dtos/workshop.dto';

@Controller('admin/workshops')
@Roles('admin')
@SessionLevels('normal')
export class AdminWorkshopsController {
  constructor(private readonly workshopService: WorkshopService) {}

  @Get()
  async listWorkshops(@Query() query: ListAdminWorkshopsQueryDto) {
    return this.workshopService.listAdminWorkshops(query);
  }

  @Get(':id')
  async getWorkshop(@Param('id') id: string) {
    return this.workshopService.getAdminWorkshop(id);
  }

  @Get(':id/status-history')
  async getStatusHistory(
    @Param('id') id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.workshopService.getWorkshopStatusHistory(id, query);
  }

  @Patch(':id/status')
  async changeStatus(
    @Param('id') id: string,
    @Body() dto: ChangeWorkshopStatusDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.workshopService.changeStatusByAdmin(id, dto, actor);
  }
}
