import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  Optional,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBody, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import { Roles } from '../../../../../common/security/decorators/access-policy';
import { CurrentActor } from '../../../../../common/security/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../../../common/security/guards/authenticated-request';
import { HttpResult } from '../../../../../common/http/interceptors/response-envelope.interceptor';
import {
  ApiDataResponse,
  ApiEmptyResponse,
  ApiIdempotencyKey,
  ApiProblemResponses,
  ApiZodBody,
  ApiZodParameters,
  schemaFor,
} from '../../../../../common/http/swagger/api-contract.decorators';
import { deferSchemaDecorator } from '../../../../../common/http/swagger/deferred-schema.decorators';
import {
  buyerRequestDtoResponseSchema,
  CreateDraftQuoteRequestDto,
} from '../dtos/create-draft-quote-request.dto';
import { UpdateDraftQuoteRequestDto } from '../dtos/update-draft-quote-request.dto';
import { DeleteDraftQuoteRequestDto } from '../dtos/delete-draft-quote-request.dto';
import { CopyQuoteRequestDto } from '../dtos/copy-quote-request.dto';
import { UpdateRecipientContactDto } from '../dtos/update-recipient-contact.dto';
import { CloseBiddingDto } from '../dtos/close-bidding.dto';
import { SendQuoteRequestDto } from '../dtos/send-quote-request.dto';
import { ListBuyerQuoteRequestsQueryDto } from '../dtos/list-buyer-quote-requests.dto';
import { buyerRequestSummaryResponseSchema } from '../dtos/list-admin-quote-requests.dto';
import {
  AcceptQuoteDto,
  acceptanceDtoResponseSchema,
  acceptQuoteOperationResponseSchema,
} from '../dtos/accept-quote.dto';
import {
  ConfirmDeliveryDto,
  confirmDeliveryOperationResponseSchema,
} from '../dtos/confirm-delivery.dto';
import {
  CancelQuoteRequestDto,
  cancelQuoteRequestOperationResponseSchema,
} from '../dtos/cancel-quote-request.dto';
import { CreateDraftQuoteRequestUseCase } from '../../../application/use-cases/requests/create-draft-quote-request.use-case';
import { UpdateDraftQuoteRequestUseCase } from '../../../application/use-cases/requests/update-draft-quote-request.use-case';
import { DeleteDraftQuoteRequestUseCase } from '../../../application/use-cases/requests/delete-draft-quote-request.use-case';
import { CopyQuoteRequestUseCase } from '../../../application/use-cases/requests/copy-quote-request.use-case';
import { UpdateRecipientContactUseCase } from '../../../application/use-cases/requests/update-recipient-contact.use-case';
import { CloseBiddingUseCase } from '../../../application/use-cases/requests/close-bidding.use-case';
import { SendQuoteRequestUseCase } from '../../../application/use-cases/requests/send-quote-request.use-case';
import { ListBuyerQuoteRequestsUseCase } from '../../../application/use-cases/requests/list-buyer-quote-requests.use-case';
import { GetQuoteRequestByIdUseCase } from '../../../application/use-cases/requests/get-quote-request-by-id.use-case';
import { AcceptQuoteUseCase } from '../../../application/use-cases/quotations/accept-quote.use-case';
import { ConfirmDeliveryUseCase } from '../../../application/use-cases/fulfillment/confirm-delivery.use-case';
import { CancelQuoteRequestByBuyerUseCase } from '../../../application/use-cases/requests/cancel-quote-request-by-buyer.use-case';
import {
  TradingMutation,
  TRADING_TX_REQUEST_KEY,
} from '../decorators/trading-mutation.decorator';
import {
  TradingMutationInterceptor,
  type HandlerMutationResult,
} from '../interceptors/trading-mutation.interceptor';
import { QuoteRequestMapper } from '../../persistence/mappers/quote-request.mapper';
import type { QuoteRequest } from '../../../domain';
import type {
  BuyerRequestDto,
  BuyerRequestSummaryDto,
} from '../../../application/dtos/trading-persistence.dtos';
import type { AcceptanceDto } from '../../../public/dtos/acceptance.dto';

type RequestWithTradingTx = Request & {
  [TRADING_TX_REQUEST_KEY]?: TransactionContext;
};

const ApiOptionalZodBody = (dto: { schema: Parameters<typeof schemaFor>[0] }) =>
  deferSchemaDecorator(() =>
    ApiBody({ required: false, schema: schemaFor(dto.schema, 'input') }),
  );

@ApiTags('trading')
@Controller('buyer/quote-requests')
@Roles('buyer')
export class BuyerQuoteRequestController {
  constructor(
    private readonly createDraftUseCase: CreateDraftQuoteRequestUseCase,
    @Optional()
    private readonly updateDraftUseCase?: UpdateDraftQuoteRequestUseCase,
    @Optional()
    private readonly deleteDraftUseCase?: DeleteDraftQuoteRequestUseCase,
    @Optional()
    private readonly copyQuoteRequestUseCase?: CopyQuoteRequestUseCase,
    @Optional()
    private readonly updateRecipientContactUseCase?: UpdateRecipientContactUseCase,
    @Optional()
    private readonly closeBiddingUseCase?: CloseBiddingUseCase,
    @Optional()
    private readonly sendQuoteRequestUseCase?: SendQuoteRequestUseCase,
    @Optional()
    private readonly listBuyerQuoteRequestsUseCase?: ListBuyerQuoteRequestsUseCase,
    @Optional()
    private readonly acceptQuoteUseCase?: AcceptQuoteUseCase,
    @Optional()
    @Inject(GetQuoteRequestByIdUseCase)
    private readonly getQuoteRequestByIdUseCase?: GetQuoteRequestByIdUseCase,
    @Optional()
    @Inject(ConfirmDeliveryUseCase)
    private readonly confirmDeliveryUseCase?: ConfirmDeliveryUseCase,
    @Optional()
    @Inject(CancelQuoteRequestByBuyerUseCase)
    private readonly cancelQuoteRequestByBuyerUseCase?: CancelQuoteRequestByBuyerUseCase,
  ) {}

  private async toBuyerResponse(
    entity: QuoteRequest,
    actor: AuthenticatedActor,
    tx?: TransactionContext,
  ): Promise<BuyerRequestDto> {
    if (this.getQuoteRequestByIdUseCase) {
      return (await this.getQuoteRequestByIdUseCase.execute({
        actor,
        id: entity.id,
        tx,
      })) as BuyerRequestDto;
    }

    return QuoteRequestMapper.toBuyerRequestDto(entity, {
      category: entity.category_id
        ? { id: entity.category_id, name: '' }
        : null,
      now: new Date(),
      coordinationState: null,
      noValidQuotes: false,
      nearestAcceptDeadline: null,
      deliveryConfirmation: null,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Buyer tạo mới yêu cầu báo giá ở trạng thái nháp (UC-14)' })
  @ApiZodBody(CreateDraftQuoteRequestDto)
  @ApiDataResponse(buyerRequestDtoResponseSchema, { status: 201 })
  @ApiProblemResponses(
    'INVALID_INPUT',
    'AUTHENTICATION_REQUIRED',
    'SESSION_EXPIRED',
    'PERMISSION_DENIED',
    'TEMP_PASSWORD_RESTRICTED',
    'CSRF_INVALID',
    'RATE_LIMIT_EXCEEDED',
    'SECURITY_SERVICE_UNAVAILABLE',
    'INTERNAL_SERVER_ERROR',
  )
  async createDraft(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() dto: CreateDraftQuoteRequestDto,
  ): Promise<BuyerRequestDto> {
    const entity = await this.createDraftUseCase.execute({ actor, draft: dto });
    return this.toBuyerResponse(entity, actor);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'update_draft',
    objectType: 'QuoteRequest',
    objectIdParam: 'id',
    expectedVersionField: 'expected_request_version',
  })
  @ApiOperation({ summary: 'Buyer cập nhật nội dung yêu cầu báo giá nháp (UC-14)' })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiZodBody(UpdateDraftQuoteRequestDto)
  @ApiDataResponse(buyerRequestDtoResponseSchema, {
    status: 200,
    operation: confirmDeliveryOperationResponseSchema,
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
  async updateDraft(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: UpdateDraftQuoteRequestDto,
    @Req() req?: RequestWithTradingTx,
  ): Promise<BuyerRequestDto> {
    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const { expected_request_version, ...draft } = dto;
    const entity = await this.updateDraftUseCase!.execute({
      actor,
      requestId: id,
      expectedRequestVersion: expected_request_version,
      draft,
      tx,
    });
    return this.toBuyerResponse(entity, actor, tx);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'delete_draft',
    objectType: 'QuoteRequest',
    objectIdParam: 'id',
    expectedVersionField: 'expected_request_version',
  })
  @ApiOperation({ summary: 'Buyer xóa yêu cầu báo giá nháp chưa gửi (UC-14)' })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiOptionalZodBody(DeleteDraftQuoteRequestDto)
  @ApiEmptyResponse()
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
  async deleteDraft(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto?: DeleteDraftQuoteRequestDto,
    @Req() req?: RequestWithTradingTx,
  ): Promise<void> {
    const tx = req?.[TRADING_TX_REQUEST_KEY];
    await this.deleteDraftUseCase!.execute({
      actor,
      requestId: id,
      expectedRequestVersion: dto?.expected_request_version,
      tx,
    });
  }

  @Post(':id/copy')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Buyer sao chép một yêu cầu báo giá thành bản nháp mới (UC-14, BR-11)',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiOptionalZodBody(CopyQuoteRequestDto)
  @ApiDataResponse(buyerRequestDtoResponseSchema, { status: 201 })
  @ApiProblemResponses(
    'INVALID_INPUT',
    'AUTHENTICATION_REQUIRED',
    'SESSION_EXPIRED',
    'PERMISSION_DENIED',
    'TEMP_PASSWORD_RESTRICTED',
    'RESOURCE_NOT_FOUND',
    'CSRF_INVALID',
    'RATE_LIMIT_EXCEEDED',
    'SECURITY_SERVICE_UNAVAILABLE',
    'INTERNAL_SERVER_ERROR',
  )
  async copyQuoteRequest(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() _dto: CopyQuoteRequestDto,
  ): Promise<BuyerRequestDto> {
    const entity = await this.copyQuoteRequestUseCase!.execute({
      actor,
      requestId: id,
    });
    return this.toBuyerResponse(entity, actor);
  }

  @Patch(':id/contact')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'edit_contact',
    objectType: 'QuoteRequest',
    objectIdParam: 'id',
    expectedVersionField: 'expected_request_version',
  })
  @ApiOperation({
    summary: 'Buyer cập nhật thông tin người nhận liên hệ sau khi gửi yêu cầu (BR-11)',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiZodBody(UpdateRecipientContactDto)
  @ApiDataResponse(buyerRequestDtoResponseSchema, {
    status: 200,
    operation: confirmDeliveryOperationResponseSchema,
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
  async updateContact(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: UpdateRecipientContactDto,
    @Req() req?: RequestWithTradingTx,
  ): Promise<BuyerRequestDto> {
    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const entity = await this.updateRecipientContactUseCase!.execute({
      actor,
      requestId: id,
      expectedRequestVersion: dto.expected_request_version,
      recipientName: dto.recipient_name,
      recipientPhone: dto.recipient_phone,
      tx,
    });
    return this.toBuyerResponse(entity, actor, tx);
  }

  @Post(':id/close-bidding')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'close_bidding',
    objectType: 'QuoteRequest',
    objectIdParam: 'id',
    expectedVersionField: 'expected_request_version',
  })
  @ApiOperation({
    summary: 'Buyer đóng sớm cửa sổ nhận báo giá trước hạn (UC-18, BR-14)',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiZodBody(CloseBiddingDto)
  @ApiDataResponse(buyerRequestDtoResponseSchema, {
    status: 200,
    operation: confirmDeliveryOperationResponseSchema,
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
  async closeBidding(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: CloseBiddingDto,
    @Req() req?: RequestWithTradingTx,
  ): Promise<BuyerRequestDto> {
    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const entity = await this.closeBiddingUseCase!.execute({
      actor,
      requestId: id,
      expectedRequestVersion: dto.expected_request_version,
      tx,
    });
    return this.toBuyerResponse(entity, actor, tx);
  }

  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'send_request',
    objectType: 'QuoteRequest',
    objectIdParam: 'id',
    expectedVersionField: 'expected_request_version',
  })
  @ApiOperation({
    summary:
      'Buyer gửi yêu cầu báo giá nháp tới các hộ sản xuất đủ điều kiện (UC-15, BR-12, BR-13)',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiZodBody(SendQuoteRequestDto)
  @ApiDataResponse(buyerRequestDtoResponseSchema, {
    status: 200,
    operation: confirmDeliveryOperationResponseSchema,
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
    'NO_ELIGIBLE_WORKSHOP',
    'WORKSHOP_SUSPENDED',
    'CSRF_INVALID',
    'RATE_LIMIT_EXCEEDED',
    'SECURITY_SERVICE_UNAVAILABLE',
    'INTERNAL_SERVER_ERROR',
  )
  async sendQuoteRequest(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: SendQuoteRequestDto,
    @Req() req?: RequestWithTradingTx,
  ): Promise<BuyerRequestDto> {
    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const entity = await this.sendQuoteRequestUseCase!.execute({
      actor,
      requestId: id,
      expectedRequestVersion: dto.expected_request_version,
      tx,
    });
    return this.toBuyerResponse(entity, actor, tx);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Lấy danh sách yêu cầu báo giá của Buyer' })
  @ApiZodParameters(ListBuyerQuoteRequestsQueryDto)
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
    @Query() query: ListBuyerQuoteRequestsQueryDto,
  ): Promise<HttpResult<readonly BuyerRequestSummaryDto[]>> {
    const result = await this.listBuyerQuoteRequestsUseCase!.execute({
      actor,
      query,
    });
    return HttpResult.paginated(result.items, result.total, {
      page: query.page,
      limit: query.limit,
    });
  }

  @Post(':id/confirm-delivery')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'confirm_delivery',
    objectType: 'QuoteRequest',
    objectIdParam: 'id',
    expectedVersionField: 'expected_request_version',
  })
  @ApiOperation({
    summary:
      'Buyer xác nhận đã nhận đủ toàn bộ hàng của yêu cầu (UC-25, BR-25, BR-26, BR-27)',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiZodBody(ConfirmDeliveryDto)
  @ApiDataResponse(buyerRequestDtoResponseSchema, {
    status: 200,
    operation: confirmDeliveryOperationResponseSchema,
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
  async confirmDelivery(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: ConfirmDeliveryDto,
    @Req() req?: RequestWithTradingTx,
  ): Promise<BuyerRequestDto | HandlerMutationResult<BuyerRequestDto>> {
    if (!this.confirmDeliveryUseCase) {
      throw new InternalServerErrorException(
        'ConfirmDeliveryUseCase is not configured.',
      );
    }

    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const result = await this.confirmDeliveryUseCase.execute({
      actor,
      requestId: id,
      expectedRequestVersion: dto.expected_request_version,
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

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'cancel_request',
    objectType: 'QuoteRequest',
    objectIdParam: 'id',
    expectedVersionField: 'expected_request_version',
  })
  @ApiOperation({
    summary:
      'Buyer hủy yêu cầu báo giá trước khi chốt (UC-27, BR-21, BR-22, BR-26, BR-27)',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiZodBody(CancelQuoteRequestDto)
  @ApiDataResponse(buyerRequestDtoResponseSchema, {
    status: 200,
    operation: cancelQuoteRequestOperationResponseSchema,
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
  async cancelQuoteRequest(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: CancelQuoteRequestDto,
    @Req() req?: RequestWithTradingTx,
  ): Promise<BuyerRequestDto | HandlerMutationResult<BuyerRequestDto>> {
    if (!this.cancelQuoteRequestByBuyerUseCase) {
      throw new InternalServerErrorException(
        'CancelQuoteRequestByBuyerUseCase is not configured.',
      );
    }

    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const result = await this.cancelQuoteRequestByBuyerUseCase.execute({
      actor,
      requestId: id,
      expectedRequestVersion: dto.expected_request_version,
      cancelReason: dto.cancel_reason,
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

  @Post(':id/accept-quote')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(TradingMutationInterceptor)
  @TradingMutation({
    action: 'accept_quote',
    objectType: 'QuoteRequest',
    objectIdParam: 'id',
    expectedVersionFields: [
      'expected_request_version',
      'expected_quote_version',
    ],
  })
  @ApiOperation({
    summary:
      'Buyer chấp nhận trực tiếp một báo giá đủ 100% số lượng (UC-19, BR-16, BR-20)',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiIdempotencyKey()
  @ApiZodBody(AcceptQuoteDto)
  @ApiDataResponse(acceptanceDtoResponseSchema, {
    status: 200,
    operation: acceptQuoteOperationResponseSchema,
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
    'QUOTE_EXPIRED',
    'WORKSHOP_SUSPENDED',
    'DEADLINE_VIOLATION',
    'INVALID_STATE',
    'INSUFFICIENT_CAPACITY',
    'CSRF_INVALID',
    'RATE_LIMIT_EXCEEDED',
    'SECURITY_SERVICE_UNAVAILABLE',
    'INTERNAL_SERVER_ERROR',
  )
  async acceptQuote(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: AcceptQuoteDto,
    @Req() req?: RequestWithTradingTx,
  ): Promise<AcceptanceDto | HandlerMutationResult<AcceptanceDto>> {
    if (!this.acceptQuoteUseCase) {
      throw new InternalServerErrorException(
        'AcceptQuoteUseCase is not configured.',
      );
    }

    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const result = await this.acceptQuoteUseCase.execute({
      actor,
      requestId: id,
      quoteId: dto.quote_id,
      expectedRequestVersion: dto.expected_request_version,
      expectedQuoteVersion: dto.expected_quote_version,
      tx,
    });

    if (tx) {
      return {
        data: result.data,
        currentState: result.currentState,
      };
    }

    return result.data;
  }
}

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, ListBuyerQuoteRequestsQueryDto],
  BuyerQuoteRequestController.prototype,
  'listQuoteRequests',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, CreateDraftQuoteRequestDto],
  BuyerQuoteRequestController.prototype,
  'createDraft',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, UpdateDraftQuoteRequestDto, Object],
  BuyerQuoteRequestController.prototype,
  'updateDraft',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, DeleteDraftQuoteRequestDto, Object],
  BuyerQuoteRequestController.prototype,
  'deleteDraft',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, CopyQuoteRequestDto],
  BuyerQuoteRequestController.prototype,
  'copyQuoteRequest',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, UpdateRecipientContactDto, Object],
  BuyerQuoteRequestController.prototype,
  'updateContact',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, CloseBiddingDto, Object],
  BuyerQuoteRequestController.prototype,
  'closeBidding',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, SendQuoteRequestDto, Object],
  BuyerQuoteRequestController.prototype,
  'sendQuoteRequest',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, AcceptQuoteDto, Object],
  BuyerQuoteRequestController.prototype,
  'acceptQuote',
);


Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, ConfirmDeliveryDto, Object],
  BuyerQuoteRequestController.prototype,
  'confirmDelivery',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, CancelQuoteRequestDto, Object],
  BuyerQuoteRequestController.prototype,
  'cancelQuoteRequest',
);
