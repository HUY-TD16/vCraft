import {
  Controller,
  Get,
  Header,
  InternalServerErrorException,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, SessionLevels } from '../../../../../common/security/decorators/access-policy';
import { CurrentActor } from '../../../../../common/security/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../../../common/security/guards/authenticated-request';
import { HttpResult } from '../../../../../common/http/interceptors/response-envelope.interceptor';
import {
  ApiDataResponse,
  ApiProblemResponses,
  ApiZodParameters,
} from '../../../../../common/http/swagger/api-contract.decorators';
import { allocationDtoResponseSchema } from '../dtos/accept-quote.dto';
import { ListArtisanAllocationsQueryDto } from '../dtos/list-artisan-allocations.dto';
import { ListArtisanAllocationsUseCase } from '../../../application/use-cases/fulfillment/list-artisan-allocations.use-case';
import type { AllocationDto } from '../../../application/dtos/trading-persistence.dtos';

@ApiTags('trading')
@Controller('artisan/allocations')
@Roles('artisan')
@SessionLevels('normal')
export class ArtisanAllocationController {
  constructor(
    private readonly listArtisanAllocationsUseCase: ListArtisanAllocationsUseCase,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Lấy danh sách các phần việc sản xuất trúng thầu của xưởng nghệ nhân (UC-23)',
  })
  @ApiZodParameters(ListArtisanAllocationsQueryDto)
  @ApiDataResponse(allocationDtoResponseSchema, { paginated: true })
  @ApiProblemResponses(
    'INVALID_INPUT',
    'AUTHENTICATION_REQUIRED',
    'SESSION_EXPIRED',
    'PERMISSION_DENIED',
    'TEMP_PASSWORD_RESTRICTED',
    'RATE_LIMIT_EXCEEDED',
    'INTERNAL_SERVER_ERROR',
  )
  async listAllocations(
    @CurrentActor() actor: AuthenticatedActor,
    @Query() query: ListArtisanAllocationsQueryDto,
  ): Promise<HttpResult<readonly AllocationDto[]>> {
    if (!this.listArtisanAllocationsUseCase) {
      throw new InternalServerErrorException(
        'ListArtisanAllocationsUseCase is not configured.',
      );
    }
    return this.listArtisanAllocationsUseCase.execute({
      actor,
      query,
    });
  }
}

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, ListArtisanAllocationsQueryDto],
  ArtisanAllocationController.prototype,
  'listAllocations',
);

