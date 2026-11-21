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
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import { Roles } from '../../../../../common/security/decorators/access-policy';
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
import {
  buyerRequestSummaryResponseSchema,
  ListAdminQuoteRequestsQueryDto,
} from '../dtos/list-admin-quote-requests.dto';
import { buyerRequestDtoResponseSchema } from '../dtos/create-draft-quote-request.dto';
import {
  CancelQuoteRequestByAdminDto,
  cancelQuoteRequestByAdminOperationResponseSchema,
} from '../dtos/cancel-quote-request-by-admin.dto';
import { ListAdminQuoteRequestsUseCase } from '../../../application/use-cases/requests/list-admin-quote-requests.use-case';
import { CancelQuoteRequestByAdminUseCase } from '../../../application/use-cases/requests/cancel-quote-request-by-admin.use-case';
import {
  TradingMutation,
  TRADING_TX_REQUEST_KEY,
} from '../decorators/trading-mutation.decorator';
import {
  TradingMutationInterceptor,
  type HandlerMutationResult,
} from '../interceptors/trading-mutation.interceptor';
import type {
  AdminRequestDto,
  BuyerRequestSummaryDto,
} from '../../../application/dtos/trading-persistence.dtos';

type RequestWithTradingTx = Request & {
  [TRADING_TX_REQUEST_KEY]?: TransactionContext;
};

@ApiTags('trading')
@Controller('admin/quote-requests')
@Roles('admin')
export class AdminQuoteRequestController {
  constructor(
    private readonly listAdminQuoteRequestsUseCase: ListAdminQuoteRequestsUseCase,
    @Optional()
    @Inject(CancelQuoteRequestByAdminUseCase)
    private readonly cancelQuoteRequestByAdminUseCase?: CancelQuoteRequestByAdminUseCase,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Lấy danh sách yêu cầu báo giá phía Admin (giám sát toàn hệ thống)',
  })
  @ApiZodParameters(ListAdminQuoteRequestsQueryDto)
  @ApiDataResponse(buyerRequestSummaryResponseSchema, { paginated: true })
  @ApiProblemResponses(
    'INVALID_INPUT',
    'AUTHENTICATION_REQUIRED',
    'SESSION_EXPIRED',
    'PERMISSION_DENIED',
    'TEMP_PASSWORD_RESTRICTED',
    'RATE_LIMIT_EXCEEDED',
    'INTERNAL_SERVER_ERROR',
  )
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

  @Post(':id/cancel-by-admin')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'cancel_request_by_admin',
    objectType: 'QuoteRequest',
    objectIdParam: 'id',
    expectedVersionField: 'expected_request_version',
  })
  @ApiOperation({
    summary:
      'Admin hủy yêu cầu báo giá sau khi chốt do sự cố bất khả kháng (UC-27, BR-21, BR-22, BR-26, BR-27)',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiZodBody(CancelQuoteRequestByAdminDto)
  @ApiDataResponse(buyerRequestDtoResponseSchema, {
    status: 200,
    operation: cancelQuoteRequestByAdminOperationResponseSchema,
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
  async cancelQuoteRequestByAdmin(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: CancelQuoteRequestByAdminDto,
    @Req() req?: RequestWithTradingTx,
  ): Promise<AdminRequestDto | HandlerMutationResult<AdminRequestDto>> {
    if (!this.cancelQuoteRequestByAdminUseCase) {
      throw new InternalServerErrorException(
        'CancelQuoteRequestByAdminUseCase is not configured.',
      );
    }

    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const result = await this.cancelQuoteRequestByAdminUseCase.execute({
      actor,
      requestId: id,
      expectedRequestVersion: dto.expected_request_version,
      cancelReason: dto.cancel_reason,
      goodsHandlingNote: dto.goods_handling_note,
      tx,
    });

    if (tx) {
      return {
        data: result.request,
        currentState: result.currentState,
      };
    }

    return result.request;
  }
}

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, ListAdminQuoteRequestsQueryDto],
  AdminQuoteRequestController.prototype,
  'listQuoteRequests',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, CancelQuoteRequestByAdminDto, Object],
  AdminQuoteRequestController.prototype,
  'cancelQuoteRequestByAdmin',
);
