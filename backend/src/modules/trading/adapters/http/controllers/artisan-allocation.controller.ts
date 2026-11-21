import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  Optional,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import { Roles, SessionLevels } from '../../../../../common/security/decorators/access-policy';
import { CurrentActor } from '../../../../../common/security/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../../../common/security/guards/authenticated-request';
import { HttpResult } from '../../../../../common/http/interceptors/response-envelope.interceptor';
import {
  ApiDataResponse,
  ApiIdempotencyKey,
  ApiProblemResponses,
  ApiZodBody,
  ApiZodParameters,
} from '../../../../../common/http/swagger/api-contract.decorators';
import { allocationDtoResponseSchema } from '../dtos/accept-quote.dto';
import { ListArtisanAllocationsQueryDto } from '../dtos/list-artisan-allocations.dto';
import {
  StartAllocationDto,
  startAllocationOperationResponseSchema,
} from '../dtos/start-allocation.dto';
import {
  LinkAllocationBatchesDto,
  linkAllocationBatchesOperationResponseSchema,
} from '../dtos/link-allocation-batches.dto';
import {
  HandoverAllocationDto,
  handoverAllocationOperationResponseSchema,
} from '../dtos/handover-allocation.dto';
import {
  TradingMutation,
  TRADING_TX_REQUEST_KEY,
} from '../decorators/trading-mutation.decorator';
import {
  TradingMutationInterceptor,
  type HandlerMutationResult,
} from '../interceptors/trading-mutation.interceptor';
import { ListArtisanAllocationsUseCase } from '../../../application/use-cases/fulfillment/list-artisan-allocations.use-case';
import { StartAllocationProductionUseCase } from '../../../application/use-cases/fulfillment/start-allocation-production.use-case';
import { LinkAllocationBatchesUseCase } from '../../../application/use-cases/fulfillment/link-allocation-batches.use-case';
import { HandoverAllocationUseCase } from '../../../application/use-cases/fulfillment/handover-allocation.use-case';
import type { AllocationDto } from '../../../application/dtos/trading-persistence.dtos';

@ApiTags('trading')
@Controller('artisan/allocations')
@Roles('artisan')
@SessionLevels('normal')
export class ArtisanAllocationController {
  constructor(
    @Inject(ListArtisanAllocationsUseCase)
    private readonly listArtisanAllocationsUseCase: ListArtisanAllocationsUseCase,
    @Optional()
    @Inject(StartAllocationProductionUseCase)
    private readonly startAllocationProductionUseCase?: StartAllocationProductionUseCase,
    @Optional()
    @Inject(LinkAllocationBatchesUseCase)
    private readonly linkAllocationBatchesUseCase?: LinkAllocationBatchesUseCase,
    @Optional()
    @Inject(HandoverAllocationUseCase)
    private readonly handoverAllocationUseCase?: HandoverAllocationUseCase,
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

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'start_production',
    objectType: 'Allocation',
    objectIdParam: 'id',
    expectedVersionField: 'expected_allocation_version',
  })
  @ApiOperation({
    summary:
      'Nghệ nhân xác nhận bắt đầu sản xuất phần việc (UC-23, BR-24)',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiZodBody(StartAllocationDto)
  @ApiDataResponse(allocationDtoResponseSchema, {
    status: 200,
    operation: startAllocationOperationResponseSchema,
  })
  @ApiProblemResponses(
    'INVALID_INPUT',
    'AUTHENTICATION_REQUIRED',
    'SESSION_EXPIRED',
    'PERMISSION_DENIED',
    'TEMP_PASSWORD_RESTRICTED',
    'RESOURCE_NOT_FOUND',
    'CONCURRENCY_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
    'INVALID_STATE',
    'CSRF_INVALID',
    'RATE_LIMIT_EXCEEDED',
    'SECURITY_SERVICE_UNAVAILABLE',
    'INTERNAL_SERVER_ERROR',
  )
  async startAllocation(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: StartAllocationDto,
    @Req() req?: Request & { [TRADING_TX_REQUEST_KEY]?: TransactionContext },
  ): Promise<AllocationDto | HandlerMutationResult<AllocationDto>> {
    if (!this.startAllocationProductionUseCase) {
      throw new InternalServerErrorException(
        'StartAllocationProductionUseCase is not configured.',
      );
    }

    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const result = await this.startAllocationProductionUseCase.execute({
      actor,
      allocationId: id,
      expectedAllocationVersion: dto.expected_allocation_version,
      tx,
    });

    if (tx) {
      return {
        data: result.allocation,
        currentState: result.currentState,
      };
    }

    return result.allocation;
  }

  @Put(':id/batches')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'link_batches',
    objectType: 'Allocation',
    objectIdParam: 'id',
    expectedVersionField: 'expected_allocation_version',
  })
  @ApiOperation({
    summary:
      'Nghệ nhân liên kết các lô gốm truy xuất nguồn gốc vào phần việc sản xuất (UC-23, BR-24)',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiZodBody(LinkAllocationBatchesDto)
  @ApiDataResponse(allocationDtoResponseSchema, {
    status: 200,
    operation: linkAllocationBatchesOperationResponseSchema,
  })
  @ApiProblemResponses(
    'INVALID_INPUT',
    'AUTHENTICATION_REQUIRED',
    'SESSION_EXPIRED',
    'PERMISSION_DENIED',
    'TEMP_PASSWORD_RESTRICTED',
    'RESOURCE_NOT_FOUND',
    'CONCURRENCY_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
    'INVALID_STATE',
    'CSRF_INVALID',
    'RATE_LIMIT_EXCEEDED',
    'SECURITY_SERVICE_UNAVAILABLE',
    'INTERNAL_SERVER_ERROR',
  )
  async linkBatches(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: LinkAllocationBatchesDto,
    @Req() req?: Request & { [TRADING_TX_REQUEST_KEY]?: TransactionContext },
  ): Promise<AllocationDto | HandlerMutationResult<AllocationDto>> {
    if (!this.linkAllocationBatchesUseCase) {
      throw new InternalServerErrorException(
        'LinkAllocationBatchesUseCase is not configured.',
      );
    }

    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const result = await this.linkAllocationBatchesUseCase.execute({
      actor,
      allocationId: id,
      expectedAllocationVersion: dto.expected_allocation_version,
      links: dto.links,
      tx,
    });

    if (tx) {
      return {
        data: result.allocation,
        currentState: result.currentState,
      };
    }

    return result.allocation;
  }

  @Post(':id/handover')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'handover_allocation',
    objectType: 'Allocation',
    objectIdParam: 'id',
    expectedVersionField: 'expected_allocation_version',
  })
  @ApiOperation({
    summary:
      'Nghệ nhân ghi nhận bàn giao phần việc sản xuất hoàn thành (UC-24, BR-24)',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiZodBody(HandoverAllocationDto)
  @ApiDataResponse(allocationDtoResponseSchema, {
    status: 200,
    operation: handoverAllocationOperationResponseSchema,
  })
  @ApiProblemResponses(
    'INVALID_INPUT',
    'AUTHENTICATION_REQUIRED',
    'SESSION_EXPIRED',
    'PERMISSION_DENIED',
    'TEMP_PASSWORD_RESTRICTED',
    'RESOURCE_NOT_FOUND',
    'CONCURRENCY_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
    'INVALID_STATE',
    'CSRF_INVALID',
    'RATE_LIMIT_EXCEEDED',
    'SECURITY_SERVICE_UNAVAILABLE',
    'INTERNAL_SERVER_ERROR',
  )
  async handoverAllocation(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: HandoverAllocationDto,
    @Req() req?: Request & { [TRADING_TX_REQUEST_KEY]?: TransactionContext },
  ): Promise<AllocationDto | HandlerMutationResult<AllocationDto>> {
    if (!this.handoverAllocationUseCase) {
      throw new InternalServerErrorException(
        'HandoverAllocationUseCase is not configured.',
      );
    }

    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const result = await this.handoverAllocationUseCase.execute({
      actor,
      allocationId: id,
      expectedAllocationVersion: dto.expected_allocation_version,
      deliveryNote: dto.delivery_note,
      tx,
    });

    if (tx) {
      return {
        data: result.allocation,
        currentState: result.currentState,
      };
    }

    return result.allocation;
  }
}

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, ListArtisanAllocationsQueryDto],
  ArtisanAllocationController.prototype,
  'listAllocations',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, StartAllocationDto, Object],
  ArtisanAllocationController.prototype,
  'startAllocation',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, LinkAllocationBatchesDto, Object],
  ArtisanAllocationController.prototype,
  'linkBatches',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, HandoverAllocationDto, Object],
  ArtisanAllocationController.prototype,
  'handoverAllocation',
);

