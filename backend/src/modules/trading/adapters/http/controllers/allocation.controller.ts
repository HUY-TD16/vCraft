import {
  Controller,
  Get,
  Header,
  Inject,
  InternalServerErrorException,
  Optional,
  Param,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  Roles,
  SessionLevels,
} from '../../../../../common/security/decorators/access-policy';
import { CurrentActor } from '../../../../../common/security/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../../../common/security/guards/authenticated-request';
import { HttpResult } from '../../../../../common/http/interceptors/response-envelope.interceptor';
import {
  ApiDataResponse,
  ApiProblemResponses,
  ApiZodParameters,
} from '../../../../../common/http/swagger/api-contract.decorators';
import { allocationDetailDtoResponseSchema } from '../dtos/get-allocation-detail.dto';
import {
  allocationEventDtoResponseSchema,
  GetAllocationHistoryQueryDto,
} from '../dtos/get-allocation-history.dto';
import { GetAllocationByIdUseCase } from '../../../application/use-cases/fulfillment/get-allocation-by-id.use-case';
import { GetAllocationHistoryUseCase } from '../../../application/use-cases/fulfillment/get-allocation-history.use-case';
import type {
  AllocationDetailDto,
  AllocationEventDto,
} from '../../../application/dtos/trading-persistence.dtos';

@ApiTags('trading')
@Controller('allocations')
@Roles('buyer', 'artisan', 'admin')
@SessionLevels('normal')
export class AllocationController {
  constructor(
    @Optional()
    @Inject(GetAllocationByIdUseCase)
    private readonly getAllocationByIdUseCase?: GetAllocationByIdUseCase,
    @Optional()
    @Inject(GetAllocationHistoryUseCase)
    private readonly getAllocationHistoryUseCase?: GetAllocationHistoryUseCase,
  ) {}

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Lấy chi tiết phần việc sản xuất cụ thể (UC-23, BR-04); mở khóa thông tin liên hệ và địa chỉ giao hàng cho hộ sở hữu phần việc',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiDataResponse(allocationDetailDtoResponseSchema)
  @ApiProblemResponses(
    'INVALID_INPUT',
    'AUTHENTICATION_REQUIRED',
    'SESSION_EXPIRED',
    'PERMISSION_DENIED',
    'TEMP_PASSWORD_RESTRICTED',
    'RESOURCE_NOT_FOUND',
    'RATE_LIMIT_EXCEEDED',
    'INTERNAL_SERVER_ERROR',
  )
  async getAllocationById(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
  ): Promise<AllocationDetailDto> {
    if (!this.getAllocationByIdUseCase) {
      throw new InternalServerErrorException(
        'GetAllocationByIdUseCase is not configured.',
      );
    }
    return this.getAllocationByIdUseCase.execute({
      actor,
      id,
    });
  }

  @Get(':id/history')
  @Roles('buyer', 'artisan', 'admin')
  @SessionLevels('normal')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Lấy lịch sử tiến độ và chuyển trạng thái phần việc sản xuất (UC-23, BR-26)',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiZodParameters(GetAllocationHistoryQueryDto)
  @ApiDataResponse(allocationEventDtoResponseSchema, { paginated: true })
  @ApiProblemResponses(
    'INVALID_INPUT',
    'AUTHENTICATION_REQUIRED',
    'SESSION_EXPIRED',
    'PERMISSION_DENIED',
    'TEMP_PASSWORD_RESTRICTED',
    'RESOURCE_NOT_FOUND',
    'RATE_LIMIT_EXCEEDED',
    'INTERNAL_SERVER_ERROR',
  )
  async getAllocationHistory(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Query() query: GetAllocationHistoryQueryDto,
  ): Promise<HttpResult<readonly AllocationEventDto[]>> {
    if (!this.getAllocationHistoryUseCase) {
      throw new InternalServerErrorException(
        'GetAllocationHistoryUseCase is not configured.',
      );
    }
    return this.getAllocationHistoryUseCase.execute({
      actor,
      id,
      query,
    });
  }
}

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String],
  AllocationController.prototype,
  'getAllocationById',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, GetAllocationHistoryQueryDto],
  AllocationController.prototype,
  'getAllocationHistory',
);
