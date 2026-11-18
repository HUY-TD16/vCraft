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
import { Roles, SessionLevels } from '../../../../../common/security/decorators/access-policy';
import { CurrentActor } from '../../../../../common/security/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../../../common/security/guards/authenticated-request';
import { HttpResult } from '../../../../../common/http/interceptors/response-envelope.interceptor';
import {
  ApiDataResponse,
  ApiProblemResponses,
  ApiZodParameters,
} from '../../../../../common/http/swagger/api-contract.decorators';
import { z } from 'zod';
import { GetQuoteRequestByIdUseCase } from '../../../application/use-cases/requests/get-quote-request-by-id.use-case';
import { ListQuoteRequestRecipientsUseCase } from '../../../application/use-cases/requests/list-quote-request-recipients.use-case';
import { GetContactHistoryUseCase } from '../../../application/use-cases/requests/get-contact-history.use-case';
import { GetStatusHistoryUseCase } from '../../../application/use-cases/requests/get-status-history.use-case';
import { GetRecipientResponseHistoryUseCase } from '../../../application/use-cases/quotations/get-recipient-response-history.use-case';
import { ListQuoteRequestQuotesUseCase } from '../../../application/use-cases/quotations/list-quote-request-quotes.use-case';
import { buyerRequestDtoResponseSchema } from '../dtos/create-draft-quote-request.dto';
import { invitedRequestDtoResponseSchema } from '../dtos/list-artisan-quote-requests.dto';
import { recipientDtoResponseSchema } from '../dtos/decline-quote-request.dto';
import { ListQuoteRequestRecipientsQueryDto } from '../dtos/list-quote-request-recipients.dto';
import { ListQuoteRequestQuotesQueryDto } from '../dtos/list-quote-request-quotes.dto';
import {
  contactEventDtoResponseSchema,
  GetQuoteRequestContactHistoryQueryDto,
} from '../dtos/get-quote-request-contact-history.dto';
import {
  GetQuoteRequestHistoryQueryDto,
  requestEventDtoResponseSchema,
} from '../dtos/get-quote-request-history.dto';
import {
  GetRecipientResponseHistoryQueryDto,
  recipientEventDtoResponseSchema,
} from '../dtos/get-recipient-response-history.dto';
import { quoteDtoResponseSchema } from '../dtos/submit-quote.dto';
import type {
  AdminRequestDto,
  BuyerRequestDto,
  ContactEventDto,
  InvitedRequestDto,
  QuoteDto,
  RecipientDto,
  RecipientEventDto,
  RequestEventDto,
} from '../../../application/dtos/trading-persistence.dtos';

@ApiTags('trading')
@Controller('quote-requests')
@Roles('buyer', 'artisan', 'admin')
export class QuoteRequestController {
  constructor(
    private readonly getQuoteRequestByIdUseCase: GetQuoteRequestByIdUseCase,
    @Optional()
    private readonly listQuoteRequestRecipientsUseCase?: ListQuoteRequestRecipientsUseCase,
    @Optional()
    private readonly getContactHistoryUseCase?: GetContactHistoryUseCase,
    @Optional()
    private readonly getStatusHistoryUseCase?: GetStatusHistoryUseCase,
    @Optional()
    @Inject(ListQuoteRequestQuotesUseCase)
    private readonly listQuoteRequestQuotesUseCase?: ListQuoteRequestQuotesUseCase,
    @Optional()
    @Inject(GetRecipientResponseHistoryUseCase)
    private readonly getRecipientResponseHistoryUseCase?: GetRecipientResponseHistoryUseCase,
  ) {}

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Lấy chi tiết yêu cầu báo giá theo vai trò' })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiDataResponse(
    z.union([buyerRequestDtoResponseSchema, invitedRequestDtoResponseSchema]),
  )
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
  async getQuoteRequestById(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
  ): Promise<BuyerRequestDto | AdminRequestDto | InvitedRequestDto> {
    return this.getQuoteRequestByIdUseCase.execute({ actor, id });
  }

  @Get(':id/recipients')
  @Roles('buyer', 'admin')
  @SessionLevels('normal')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Lấy danh sách hộ nhận yêu cầu báo giá và trạng thái phản hồi',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiZodParameters(ListQuoteRequestRecipientsQueryDto)
  @ApiDataResponse(recipientDtoResponseSchema, { paginated: true })
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
  async getRecipients(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Query() query: ListQuoteRequestRecipientsQueryDto,
  ): Promise<HttpResult<readonly RecipientDto[]>> {
    if (!this.listQuoteRequestRecipientsUseCase) {
      throw new InternalServerErrorException(
        'ListQuoteRequestRecipientsUseCase is not configured.',
      );
    }
    return this.listQuoteRequestRecipientsUseCase.execute({
      actor,
      requestId: id,
      query,
    });
  }

  @Get(':id/contact-history')
  @Roles('buyer', 'artisan', 'admin')
  @SessionLevels('normal')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Lấy lịch sử sửa thông tin liên hệ nhận hàng của yêu cầu báo giá',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiZodParameters(GetQuoteRequestContactHistoryQueryDto)
  @ApiDataResponse(contactEventDtoResponseSchema, { paginated: true })
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
  async getContactHistory(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Query() query: GetQuoteRequestContactHistoryQueryDto,
  ): Promise<HttpResult<readonly ContactEventDto[]>> {
    if (!this.getContactHistoryUseCase) {
      throw new InternalServerErrorException(
        'GetContactHistoryUseCase is not configured.',
      );
    }
    return this.getContactHistoryUseCase.execute({
      actor,
      requestId: id,
      query,
    });
  }

  @Get(':id/history')
  @Roles('buyer', 'admin')
  @SessionLevels('normal')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Lấy lịch sử chuyển trạng thái yêu cầu báo giá',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiZodParameters(GetQuoteRequestHistoryQueryDto)
  @ApiDataResponse(requestEventDtoResponseSchema, { paginated: true })
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
  async getHistory(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Query() query: GetQuoteRequestHistoryQueryDto,
  ): Promise<HttpResult<readonly RequestEventDto[]>> {
    if (!this.getStatusHistoryUseCase) {
      throw new InternalServerErrorException(
        'GetStatusHistoryUseCase is not configured.',
      );
    }
    return this.getStatusHistoryUseCase.execute({
      actor,
      requestId: id,
      query,
    });
  }

  @Get(':id/quotes')
  @Roles('buyer', 'artisan', 'admin')
  @SessionLevels('normal')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Lấy danh sách báo giá của yêu cầu báo giá theo vai trò',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiZodParameters(ListQuoteRequestQuotesQueryDto)
  @ApiDataResponse(quoteDtoResponseSchema, { paginated: true })
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
  async getQuotes(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Query() query: ListQuoteRequestQuotesQueryDto,
  ): Promise<HttpResult<readonly QuoteDto[]>> {
    if (!this.listQuoteRequestQuotesUseCase) {
      throw new InternalServerErrorException(
        'ListQuoteRequestQuotesUseCase is not configured.',
      );
    }
    return this.listQuoteRequestQuotesUseCase.execute({
      actor,
      requestId: id,
      query,
    });
  }

  @Get(':id/recipients/:recipientId/history')
  @Roles('buyer', 'artisan', 'admin')
  @SessionLevels('normal')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Lấy lịch sử phản hồi và báo giá của một hộ nhận theo yêu cầu báo giá',
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiParam({
    name: 'recipientId',
    required: true,
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiZodParameters(GetRecipientResponseHistoryQueryDto)
  @ApiDataResponse(recipientEventDtoResponseSchema, { paginated: true })
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
  async getRecipientHistory(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Param('recipientId') recipientId: string,
    @Query() query: GetRecipientResponseHistoryQueryDto,
  ): Promise<HttpResult<readonly RecipientEventDto[]>> {
    if (!this.getRecipientResponseHistoryUseCase) {
      throw new InternalServerErrorException(
        'GetRecipientResponseHistoryUseCase is not configured.',
      );
    }
    return this.getRecipientResponseHistoryUseCase.execute({
      actor,
      requestId: id,
      recipientId,
      query,
    });
  }
}

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String],
  QuoteRequestController.prototype,
  'getQuoteRequestById',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, ListQuoteRequestRecipientsQueryDto],
  QuoteRequestController.prototype,
  'getRecipients',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, GetQuoteRequestContactHistoryQueryDto],
  QuoteRequestController.prototype,
  'getContactHistory',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, GetQuoteRequestHistoryQueryDto],
  QuoteRequestController.prototype,
  'getHistory',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, ListQuoteRequestQuotesQueryDto],
  QuoteRequestController.prototype,
  'getQuotes',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, String, GetRecipientResponseHistoryQueryDto],
  QuoteRequestController.prototype,
  'getRecipientHistory',
);
