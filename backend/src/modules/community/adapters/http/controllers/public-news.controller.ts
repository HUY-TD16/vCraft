import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../../../../../common/security/decorators/access-policy';
import { CommunityService } from '../../../application/services/community.service';
import { ListPublicNewsQueryDto } from '../dtos/news.dto';

@Controller('news')
@Public()
export class PublicNewsController {
  constructor(private readonly communityService: CommunityService) {}

  @Get()
  async listNews(@Query() query: ListPublicNewsQueryDto) {
    return this.communityService.listPublicNews(query);
  }

  @Get(':id')
  async getNewsDetail(@Param('id') id: string) {
    return this.communityService.getPublicNewsDetail(id);
  }
}
