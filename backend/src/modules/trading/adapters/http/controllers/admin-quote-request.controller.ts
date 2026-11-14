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
import { ListAdminQuoteRequestsQueryDto } from '../dtos/list-admin-quote-requests.dto';
import { ListAdminQuoteRequestsUseCase } from '../../../application/use-cases/requests/list-admin-quote-requests.use-case';
import type { BuyerRequestSummaryDto } from '../../../application/dtos/trading-persistence.dtos';

@ApiTags('trading')
@Controller('admin/quote-requests')
@Roles('admin')
export class AdminQuoteRequestController {
  constructor(
    private readonly listAdminQuoteRequestsUseCase: ListAdminQuoteRequestsUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Lấy danh sách yêu cầu báo giá phía Admin (giám sát toàn hệ thống)',
  })
  async listQuoteRequests(
    @CurrentActor() actor: AuthenticatedActor,
    @Query() query: ListAdminQuoteRequestsQueryDto,
  ): Promise<HttpResult<readonly BuyerRequestSummaryDto[]>> {
    const result = await this.listAdminQuoteRequestsUseCase.execute({
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
  [Object, ListAdminQuoteRequestsQueryDto],
  AdminQuoteRequestController.prototype,
  'listQuoteRequests',
);
