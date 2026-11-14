import {
  Controller,
  Get,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../../../../common/security/decorators/access-policy';
import { CurrentActor } from '../../../../../common/security/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../../../common/security/guards/authenticated-request';
import { HttpResult } from '../../../../../common/http/interceptors/response-envelope.interceptor';
import { ListArtisanQuoteRequestsQueryDto } from '../dtos/list-artisan-quote-requests.dto';
import { ListArtisanQuoteRequestsUseCase } from '../../../application/use-cases/requests/list-artisan-quote-requests.use-case';
import type { InvitedRequestDto } from '../../../application/dtos/trading-persistence.dtos';

@ApiTags('trading')
@Controller('artisan/quote-requests')
@Roles('artisan')
export class ArtisanQuoteRequestController {
  constructor(
    private readonly listArtisanQuoteRequestsUseCase: ListArtisanQuoteRequestsUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Lấy danh sách các yêu cầu báo giá được mời của Artisan',
  })
  async listQuoteRequests(
    @CurrentActor() actor: AuthenticatedActor,
    @Query() query: ListArtisanQuoteRequestsQueryDto,
  ): Promise<HttpResult<readonly InvitedRequestDto[]>> {
    const result = await this.listArtisanQuoteRequestsUseCase.execute({
      actor,
      query,
    });
    return HttpResult.paginated(result.items, result.total, {
      page: query.page,
      limit: query.limit,
    });
  }
}

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, ListArtisanQuoteRequestsQueryDto],
  ArtisanQuoteRequestController.prototype,
  'listQuoteRequests',
);
