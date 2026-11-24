import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../../../../../common/security/decorators/access-policy';
import { WorkshopService } from '../../../application/services/workshop.service';
import { ListPublicWorkshopsQueryDto } from '../dtos/workshop.dto';

@Controller('workshops')
@Public()
export class PublicWorkshopsController {
  constructor(private readonly workshopService: WorkshopService) {}

  @Get()
  async listWorkshops(@Query() query: ListPublicWorkshopsQueryDto) {
    return this.workshopService.listPublicWorkshops(query);
  }

  @Get(':id')
  async getWorkshopDetail(@Param('id') id: string) {
    return this.workshopService.getPublicWorkshopDetail(id);
  }
}
