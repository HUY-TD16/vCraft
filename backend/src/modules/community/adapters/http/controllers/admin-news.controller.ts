import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Roles, SessionLevels } from '../../../../../common/security/decorators/access-policy';
import { CurrentActor } from '../../../../../common/security/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../../../common/application/types/contract-types';
import { CommunityService } from '../../../application/services/community.service';
import {
  ChangeNewsStatusDto,
  ListAdminNewsQueryDto,
  NewsWriteDto,
} from '../dtos/news.dto';

@Controller('admin/news')
@Roles('admin')
@SessionLevels('normal')
export class AdminNewsController {
  constructor(private readonly communityService: CommunityService) {}

  @Get()
  async listNews(@Query() query: ListAdminNewsQueryDto) {
    return this.communityService.listAdminNews(query);
  }

  @Get(':id')
  async getNewsDetail(@Param('id') id: string) {
    return this.communityService.getAdminNewsDetail(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createNews(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() dto: NewsWriteDto,
  ) {
    return this.communityService.createNews(actor, dto);
  }

  @Put(':id')
  async updateNews(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: NewsWriteDto,
  ) {
    return this.communityService.updateNews(actor, id, dto);
  }

  @Patch(':id/status')
  async changeNewsStatus(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: ChangeNewsStatusDto,
  ) {
    return this.communityService.changeNewsStatus(actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteNews(@Param('id') id: string) {
    await this.communityService.deleteNews(id);
  }
}
