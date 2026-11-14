import {
  Controller,
  Get,
  InternalServerErrorException,
  Optional,
  Param,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, SessionLevels } from '../../../../../common/security/decorators/access-policy';
import { CurrentActor } from '../../../../../common/security/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../../../common/security/guards/authenticated-request';
import { HttpResult } from '../../../../../common/http/interceptors/response-envelope.interceptor';
import { GetQuoteRequestByIdUseCase } from '../../../application/use-cases/requests/get-quote-request-by-id.use-case';
import { ListQuoteRequestRecipientsUseCase } from '../../../application/use-cases/requests/list-quote-request-recipients.use-case';
import { GetContactHistoryUseCase } from '../../../application/use-cases/requests/get-contact-history.use-case';
import { ListQuoteRequestRecipientsQueryDto } from '../dtos/list-quote-request-recipients.dto';
import { GetQuoteRequestContactHistoryQueryDto } from '../dtos/get-quote-request-contact-history.dto';
import type {
  AdminRequestDto,
  BuyerRequestDto,
  ContactEventDto,
  InvitedRequestDto,
  RecipientDto,
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
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Lấy chi tiết yêu cầu báo giá theo vai trò' })
  async getQuoteRequestById(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
  ): Promise<BuyerRequestDto | AdminRequestDto | InvitedRequestDto> {
    return this.getQuoteRequestByIdUseCase.execute({ actor, id });
  }

  @Get(':id/recipients')
  @Roles('buyer', 'admin')
  @SessionLevels('normal')
  @ApiOperation({
    summary: 'Lấy danh sách hộ nhận yêu cầu báo giá và trạng thái phản hồi',
  })
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
  @ApiOperation({
    summary: 'Lấy lịch sử sửa thông tin liên hệ nhận hàng của yêu cầu báo giá',
  })
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
