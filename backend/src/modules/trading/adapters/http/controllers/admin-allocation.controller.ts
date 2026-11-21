import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  Optional,
  Param,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import {
  Roles,
  SessionLevels,
} from '../../../../../common/security/decorators/access-policy';
import { CurrentActor } from '../../../../../common/security/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../../../common/security/guards/authenticated-request';
import {
  ApiDataResponse,
  ApiIdempotencyKey,
  ApiProblemResponses,
  ApiZodBody,
} from '../../../../../common/http/swagger/api-contract.decorators';
import { allocationDtoResponseSchema } from '../dtos/accept-quote.dto';
import {
  HandoverAllocationByAdminDto,
  handoverAllocationByAdminOperationResponseSchema,
} from '../dtos/handover-allocation-by-admin.dto';
import {
  TradingMutation,
  TRADING_TX_REQUEST_KEY,
} from '../decorators/trading-mutation.decorator';
import {
  TradingMutationInterceptor,
  type HandlerMutationResult,
} from '../interceptors/trading-mutation.interceptor';
import { HandoverAllocationByAdminUseCase } from '../../../application/use-cases/fulfillment/handover-allocation-by-admin.use-case';
import type { AllocationDto } from '../../../application/dtos/trading-persistence.dtos';

type RequestWithTradingTx = Request & {
  [TRADING_TX_REQUEST_KEY]?: TransactionContext;
};

@ApiTags('trading')
@Controller('admin/allocations')
@Roles('admin')
@SessionLevels('normal')
export class AdminAllocationController {
  constructor(
    @Optional()
    @Inject(HandoverAllocationByAdminUseCase)
    private readonly handoverAllocationByAdminUseCase?: HandoverAllocationByAdminUseCase,
  ) {}

  @Post(':id/handover-by-admin')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'handover_allocation_by_admin',
    objectType: 'Allocation',
    objectIdParam: 'id',
    expectedVersionField: 'expected_allocation_version',
  })
  @ApiOperation({
    summary:
      'Admin ghi nhận bàn giao phần việc sản xuất thay cho hộ trong trường hợp ngoại lệ (UC-24, BR-24, BR-26, BR-27)',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiZodBody(HandoverAllocationByAdminDto)
  @ApiDataResponse(allocationDtoResponseSchema, {
    status: 200,
    operation: handoverAllocationByAdminOperationResponseSchema,
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
    'DEADLINE_VIOLATION',
    'INVALID_STATE',
    'CSRF_INVALID',
    'RATE_LIMIT_EXCEEDED',
    'SECURITY_SERVICE_UNAVAILABLE',
    'INTERNAL_SERVER_ERROR',
  )
  async handoverAllocationByAdmin(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: HandoverAllocationByAdminDto,
    @Req() req?: RequestWithTradingTx,
  ): Promise<AllocationDto | HandlerMutationResult<AllocationDto>> {
    if (!this.handoverAllocationByAdminUseCase) {
      throw new InternalServerErrorException(
        'HandoverAllocationByAdminUseCase is not configured.',
      );
    }

    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const result = await this.handoverAllocationByAdminUseCase.execute({
      actor,
      allocationId: id,
      expectedAllocationVersion: dto.expected_allocation_version,
      reason: dto.reason,
      evidence: dto.evidence,
      actualHandoverAt: dto.actual_handover_at,
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
  [Object, String, HandoverAllocationByAdminDto, Object],
  AdminAllocationController.prototype,
  'handoverAllocationByAdmin',
);
