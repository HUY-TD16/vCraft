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
  invitedRequestDtoResponseSchema,
  ListArtisanQuoteRequestsQueryDto,
} from '../dtos/list-artisan-quote-requests.dto';
import {
  DeclineQuoteRequestDto,
  declineOperationResponseSchema,
  recipientDtoResponseSchema,
} from '../dtos/decline-quote-request.dto';
import {
  SubmitQuoteDto,
  quoteMutationDtoResponseSchema,
  submitQuoteOperationResponseSchema,
} from '../dtos/submit-quote.dto';
import {
  WithdrawQuoteDto,
  withdrawQuoteOperationResponseSchema,
} from '../dtos/withdraw-quote.dto';
import { ListArtisanQuoteRequestsUseCase } from '../../../application/use-cases/requests/list-artisan-quote-requests.use-case';
import { DeclineQuoteRequestUseCase } from '../../../application/use-cases/quotations/decline-quote-request.use-case';
import { SubmitQuoteUseCase } from '../../../application/use-cases/quotations/submit-quote.use-case';
import { WithdrawQuoteUseCase } from '../../../application/use-cases/quotations/withdraw-quote.use-case';
import {
  TradingMutation,
  TRADING_TX_REQUEST_KEY,
} from '../decorators/trading-mutation.decorator';
import {
  TradingMutationInterceptor,
  type HandlerMutationResult,
} from '../interceptors/trading-mutation.interceptor';
import type {
  InvitedRequestDto,
  QuoteMutationDto,
  RecipientDto,
} from '../../../application/dtos/trading-persistence.dtos';

@ApiTags('trading')
@Controller('artisan/quote-requests')
@Roles('artisan')
export class ArtisanQuoteRequestController {
  constructor(
    @Inject(ListArtisanQuoteRequestsUseCase)
    private readonly listArtisanQuoteRequestsUseCase: ListArtisanQuoteRequestsUseCase,
    @Optional()
    @Inject(DeclineQuoteRequestUseCase)
    private readonly declineQuoteRequestUseCase?: DeclineQuoteRequestUseCase,
    @Optional()
    @Inject(SubmitQuoteUseCase)
    private readonly submitQuoteUseCase?: SubmitQuoteUseCase,
    @Optional()
    @Inject(WithdrawQuoteUseCase)
    private readonly withdrawQuoteUseCase?: WithdrawQuoteUseCase,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Lấy danh sách các yêu cầu báo giá được mời của Artisan',
  })
  @ApiZodParameters(ListArtisanQuoteRequestsQueryDto)
  @ApiDataResponse(invitedRequestDtoResponseSchema, { paginated: true })
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

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'decline',
    objectType: 'QuoteRequest',
    objectIdParam: 'id',
    expectedVersionField: 'expected_recipient_version',
  })
  @ApiOperation({
    summary: 'Nghệ nhân từ chối tham gia chào giá cho yêu cầu được mời',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiZodBody(DeclineQuoteRequestDto)
  @ApiDataResponse(recipientDtoResponseSchema, {
    status: 200,
    operation: declineOperationResponseSchema,
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
    'BIDDING_CLOSED',
    'CSRF_INVALID',
    'RATE_LIMIT_EXCEEDED',
    'SECURITY_SERVICE_UNAVAILABLE',
    'INTERNAL_SERVER_ERROR',
  )
  async declineQuoteRequest(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: DeclineQuoteRequestDto,
    @Req() req?: Request & { [TRADING_TX_REQUEST_KEY]?: TransactionContext },
  ): Promise<RecipientDto | HandlerMutationResult<RecipientDto>> {
    if (!this.declineQuoteRequestUseCase) {
      throw new InternalServerErrorException(
        'DeclineQuoteRequestUseCase is not configured.',
      );
    }

    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const result = await this.declineQuoteRequestUseCase.execute({
      actor,
      requestId: id,
      expectedRecipientVersion: dto.expected_recipient_version,
      declineReason: dto.decline_reason,
      tx,
    });

    if (tx) {
      return {
        data: result.recipient,
        currentState: result.currentState,
      };
    }

    return result.recipient;
  }

  @Post(':id/quote')
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'submit_quote',
    objectType: 'QuoteRequest',
    objectIdParam: 'id',
    expectedVersionFields: [
      'expected_recipient_version',
      'expected_quote_version',
    ],
    allowNullableVersion: ['expected_quote_version'],
    resolveHttpStatus: ({ body }) =>
      body !== null &&
      typeof body === 'object' &&
      'expected_quote_version' in body &&
      body.expected_quote_version === null
        ? HttpStatus.CREATED
        : HttpStatus.OK,
  })
  @ApiOperation({
    summary:
      'Nghệ nhân gửi, sửa hoặc gửi lại báo giá cho yêu cầu được mời',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiZodBody(SubmitQuoteDto)
  @ApiDataResponse(quoteMutationDtoResponseSchema, {
    status: 201,
    operation: submitQuoteOperationResponseSchema,
  })
  @ApiDataResponse(quoteMutationDtoResponseSchema, {
    status: 200,
    operation: submitQuoteOperationResponseSchema,
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
    'WORKSHOP_SUSPENDED',
    'DEADLINE_VIOLATION',
    'INVALID_STATE',
    'BIDDING_CLOSED',
    'CSRF_INVALID',
    'RATE_LIMIT_EXCEEDED',
    'SECURITY_SERVICE_UNAVAILABLE',
    'INTERNAL_SERVER_ERROR',
  )
  async submitQuote(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: SubmitQuoteDto,
    @Req() req?: Request & { [TRADING_TX_REQUEST_KEY]?: TransactionContext },
  ): Promise<QuoteMutationDto | HandlerMutationResult<QuoteMutationDto>> {
    if (!this.submitQuoteUseCase) {
      throw new InternalServerErrorException(
        'SubmitQuoteUseCase is not configured.',
      );
    }

    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const result = await this.submitQuoteUseCase.execute({
      actor,
      requestId: id,
      expectedRecipientVersion: dto.expected_recipient_version,
      expectedQuoteVersion: dto.expected_quote_version,
      unitPrice: dto.unit_price,
      maxQuantity: dto.max_quantity,
      bidAcceptDeadline: dto.bid_accept_deadline,
      committedDeliveryAt: dto.committed_delivery_at,
      tx,
    });

    if (tx) {
      return {
        data: result.result,
        currentState: result.currentState,
      };
    }

    return result.result;
  }

  @Post(':id/quote/withdraw')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'withdraw_quote',
    objectType: 'QuoteRequest',
    objectIdParam: 'id',
    expectedVersionFields: [
      'expected_recipient_version',
      'expected_quote_version',
    ],
  })
  @ApiOperation({
    summary:
      'Nghệ nhân rút báo giá đã gửi khi yêu cầu chưa chốt và chưa hủy',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiZodBody(WithdrawQuoteDto)
  @ApiDataResponse(quoteMutationDtoResponseSchema, {
    status: 200,
    operation: withdrawQuoteOperationResponseSchema,
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
  async withdrawQuote(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: WithdrawQuoteDto,
    @Req() req?: Request & { [TRADING_TX_REQUEST_KEY]?: TransactionContext },
  ): Promise<QuoteMutationDto | HandlerMutationResult<QuoteMutationDto>> {
    if (!this.withdrawQuoteUseCase) {
      throw new InternalServerErrorException(
        'WithdrawQuoteUseCase is not configured.',
      );
    }

    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const result = await this.withdrawQuoteUseCase.execute({
      actor,
      requestId: id,
      expectedRecipientVersion: dto.expected_recipient_version,
      expectedQuoteVersion: dto.expected_quote_version,
      withdrawReason: dto.withdraw_reason,
      tx,
    });

    if (tx) {
      return {
        data: result.result,
        currentState: result.currentState,
      };
    }

    return result.result;
  }
}

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, ListArtisanQuoteRequestsQueryDto],
  ArtisanQuoteRequestController.prototype,
  'listQuoteRequests',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, DeclineQuoteRequestDto, Object],
  ArtisanQuoteRequestController.prototype,
  'declineQuoteRequest',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, SubmitQuoteDto, Object],
  ArtisanQuoteRequestController.prototype,
  'submitQuote',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, WithdrawQuoteDto, Object],
  ArtisanQuoteRequestController.prototype,
  'withdrawQuote',
);
