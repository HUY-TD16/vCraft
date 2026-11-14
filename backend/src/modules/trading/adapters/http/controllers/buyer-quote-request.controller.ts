import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Optional,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../../../../common/security/decorators/access-policy';
import { CurrentActor } from '../../../../../common/security/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../../../common/security/guards/authenticated-request';
import { HttpResult } from '../../../../../common/http/interceptors/response-envelope.interceptor';
import { CreateDraftQuoteRequestDto } from '../dtos/create-draft-quote-request.dto';
import { UpdateDraftQuoteRequestDto } from '../dtos/update-draft-quote-request.dto';
import { DeleteDraftQuoteRequestDto } from '../dtos/delete-draft-quote-request.dto';
import { CopyQuoteRequestDto } from '../dtos/copy-quote-request.dto';
import { UpdateRecipientContactDto } from '../dtos/update-recipient-contact.dto';
import { CloseBiddingDto } from '../dtos/close-bidding.dto';
import { ListBuyerQuoteRequestsQueryDto } from '../dtos/list-buyer-quote-requests.dto';
import { CreateDraftQuoteRequestUseCase } from '../../../application/use-cases/requests/create-draft-quote-request.use-case';
import { UpdateDraftQuoteRequestUseCase } from '../../../application/use-cases/requests/update-draft-quote-request.use-case';
import { DeleteDraftQuoteRequestUseCase } from '../../../application/use-cases/requests/delete-draft-quote-request.use-case';
import { CopyQuoteRequestUseCase } from '../../../application/use-cases/requests/copy-quote-request.use-case';
import { UpdateRecipientContactUseCase } from '../../../application/use-cases/requests/update-recipient-contact.use-case';
import { CloseBiddingUseCase } from '../../../application/use-cases/requests/close-bidding.use-case';
import { ListBuyerQuoteRequestsUseCase } from '../../../application/use-cases/requests/list-buyer-quote-requests.use-case';
import {
  TradingMutation,
  TRADING_TX_REQUEST_KEY,
} from '../decorators/trading-mutation.decorator';
import { QuoteRequestMapper } from '../../persistence/mappers/quote-request.mapper';
import type {
  BuyerRequestDto,
  BuyerRequestSummaryDto,
} from '../../../application/dtos/trading-persistence.dtos';

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
    private readonly listBuyerQuoteRequestsUseCase?: ListBuyerQuoteRequestsUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createDraft(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() dto: CreateDraftQuoteRequestDto,
  ): Promise<BuyerRequestDto> {
    const entity = await this.createDraftUseCase.execute({ actor, draft: dto });
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

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  async updateDraft(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: UpdateDraftQuoteRequestDto,
  ): Promise<BuyerRequestDto> {
    const { expected_request_version, ...draft } = dto;
    const entity = await this.updateDraftUseCase!.execute({
      actor,
      requestId: id,
      expectedRequestVersion: expected_request_version,
      draft,
    });
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

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDraft(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto?: DeleteDraftQuoteRequestDto,
  ): Promise<void> {
    await this.deleteDraftUseCase!.execute({
      actor,
      requestId: id,
      expectedRequestVersion: dto?.expected_request_version,
    });
  }

  @Post(':id/copy')
  @HttpCode(HttpStatus.CREATED)
  async copyQuoteRequest(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() _dto: CopyQuoteRequestDto,
  ): Promise<BuyerRequestDto> {
    const entity = await this.copyQuoteRequestUseCase!.execute({
      actor,
      requestId: id,
    });
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

  @Patch(':id/contact')
  @HttpCode(HttpStatus.OK)
  @TradingMutation({
    action: 'edit_contact',
    objectType: 'QuoteRequest',
    objectIdParam: 'id',
    expectedVersionField: 'expected_request_version',
  })
  async updateContact(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: UpdateRecipientContactDto,
    @Req() req?: any,
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

  @Post(':id/close-bidding')
  @HttpCode(HttpStatus.OK)
  @TradingMutation({
    action: 'close_bidding',
    objectType: 'QuoteRequest',
    objectIdParam: 'id',
    expectedVersionField: 'expected_request_version',
  })
  async closeBidding(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: CloseBiddingDto,
    @Req() req?: any,
  ): Promise<BuyerRequestDto> {
    const tx = req?.[TRADING_TX_REQUEST_KEY];
    const entity = await this.closeBiddingUseCase!.execute({
      actor,
      requestId: id,
      expectedRequestVersion: dto.expected_request_version,
      tx,
    });
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

  @Get()
  @ApiOperation({ summary: 'Lấy danh sách yêu cầu báo giá của Buyer' })
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
  [Object, String, UpdateDraftQuoteRequestDto],
  BuyerQuoteRequestController.prototype,
  'updateDraft',
);

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, DeleteDraftQuoteRequestDto],
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

