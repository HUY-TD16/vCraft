import type { Provider } from '@nestjs/common';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../../common/application/ports/transaction-runner';
import {
  TRACEABILITY_CONTRACT,
  type ITraceabilityContract,
} from '../../traceability/public/contracts/traceability.contract';
import {
  WORKSHOP_CONTRACT,
  type IWorkshopContract,
} from '../../workshops/public/contracts/workshop.contract';
import {
  ALLOCATION_BATCH_REPOSITORY,
  ALLOCATION_LOG_REPOSITORY,
  ALLOCATION_REPOSITORY,
  QUOTE_REQUEST_REPOSITORY,
  type IAllocationBatchRepository,
  type IAllocationLogRepository,
  type IAllocationRepository,
  type IQuoteRequestRepository,
} from '../application/ports/repositories/trading-repositories.port';
import { ConfirmDeliveryByAdminUseCase } from '../application/use-cases/fulfillment/confirm-delivery-by-admin.use-case';
import { ConfirmDeliveryUseCase } from '../application/use-cases/fulfillment/confirm-delivery.use-case';
import { GetAllocationBatchesUseCase } from '../application/use-cases/fulfillment/get-allocation-batches.use-case';
import { GetAllocationByIdUseCase } from '../application/use-cases/fulfillment/get-allocation-by-id.use-case';
import { GetAllocationHistoryUseCase } from '../application/use-cases/fulfillment/get-allocation-history.use-case';
import { HandoverAllocationByAdminUseCase } from '../application/use-cases/fulfillment/handover-allocation-by-admin.use-case';
import { HandoverAllocationUseCase } from '../application/use-cases/fulfillment/handover-allocation.use-case';
import { LinkAllocationBatchesUseCase } from '../application/use-cases/fulfillment/link-allocation-batches.use-case';
import { ListArtisanAllocationsUseCase } from '../application/use-cases/fulfillment/list-artisan-allocations.use-case';
import { ListQuoteRequestAllocationsUseCase } from '../application/use-cases/fulfillment/list-quote-request-allocations.use-case';
import { StartAllocationProductionUseCase } from '../application/use-cases/fulfillment/start-allocation-production.use-case';

export const TRADING_FULFILLMENT_PROVIDERS: Provider[] = [
  {
    provide: ListQuoteRequestAllocationsUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      quoteRequestRepo: IQuoteRequestRepository,
      allocationRepo: IAllocationRepository,
    ) => {
      return new ListQuoteRequestAllocationsUseCase(
        txRunner,
        quoteRequestRepo,
        allocationRepo,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      QUOTE_REQUEST_REPOSITORY,
      ALLOCATION_REPOSITORY,
    ],
  },
  {
    provide: ListArtisanAllocationsUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      allocationRepo: IAllocationRepository,
    ) => {
      return new ListArtisanAllocationsUseCase(txRunner, allocationRepo);
    },
    inject: [TRANSACTION_RUNNER, ALLOCATION_REPOSITORY],
  },
  {
    provide: GetAllocationByIdUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      allocationRepo: IAllocationRepository,
    ) => {
      return new GetAllocationByIdUseCase(txRunner, allocationRepo);
    },
    inject: [TRANSACTION_RUNNER, ALLOCATION_REPOSITORY],
  },
  {
    provide: GetAllocationBatchesUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      allocationRepo: IAllocationRepository,
      allocationBatchRepo: IAllocationBatchRepository,
      quoteRequestRepo?: IQuoteRequestRepository,
    ) => {
      return new GetAllocationBatchesUseCase(
        txRunner,
        allocationRepo,
        allocationBatchRepo,
        quoteRequestRepo,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      ALLOCATION_REPOSITORY,
      ALLOCATION_BATCH_REPOSITORY,
      { token: QUOTE_REQUEST_REPOSITORY, optional: true },
    ],
  },
  {
    provide: StartAllocationProductionUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      allocationRepo: IAllocationRepository,
      quoteRequestRepo: IQuoteRequestRepository,
      workshopContract?: IWorkshopContract,
    ) => {
      return new StartAllocationProductionUseCase(
        txRunner,
        allocationRepo,
        quoteRequestRepo,
        workshopContract,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      ALLOCATION_REPOSITORY,
      QUOTE_REQUEST_REPOSITORY,
      { token: WORKSHOP_CONTRACT, optional: true },
    ],
  },
  {
    provide: LinkAllocationBatchesUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      allocationRepo: IAllocationRepository,
      quoteRequestRepo: IQuoteRequestRepository,
      traceabilityContract?: ITraceabilityContract,
      allocationBatchRepo?: IAllocationBatchRepository,
      workshopContract?: IWorkshopContract,
    ) => {
      return new LinkAllocationBatchesUseCase(
        txRunner,
        allocationRepo,
        quoteRequestRepo,
        traceabilityContract,
        allocationBatchRepo,
        workshopContract,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      ALLOCATION_REPOSITORY,
      QUOTE_REQUEST_REPOSITORY,
      { token: TRACEABILITY_CONTRACT, optional: true },
      { token: ALLOCATION_BATCH_REPOSITORY, optional: true },
      { token: WORKSHOP_CONTRACT, optional: true },
    ],
  },
  {
    provide: HandoverAllocationUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      allocationRepo: IAllocationRepository,
      quoteRequestRepo: IQuoteRequestRepository,
      workshopContract?: IWorkshopContract,
    ) => {
      return new HandoverAllocationUseCase(
        txRunner,
        allocationRepo,
        quoteRequestRepo,
        workshopContract,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      ALLOCATION_REPOSITORY,
      QUOTE_REQUEST_REPOSITORY,
      { token: WORKSHOP_CONTRACT, optional: true },
    ],
  },
  {
    provide: HandoverAllocationByAdminUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      allocationRepo: IAllocationRepository,
      quoteRequestRepo: IQuoteRequestRepository,
      workshopContract?: IWorkshopContract,
    ) => {
      return new HandoverAllocationByAdminUseCase(
        txRunner,
        allocationRepo,
        quoteRequestRepo,
        workshopContract,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      ALLOCATION_REPOSITORY,
      QUOTE_REQUEST_REPOSITORY,
      { token: WORKSHOP_CONTRACT, optional: true },
    ],
  },
  {
    provide: ConfirmDeliveryUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      quoteRequestRepo: IQuoteRequestRepository,
      allocationRepo: IAllocationRepository,
    ) => {
      return new ConfirmDeliveryUseCase(
        txRunner,
        quoteRequestRepo,
        allocationRepo,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      QUOTE_REQUEST_REPOSITORY,
      ALLOCATION_REPOSITORY,
    ],
  },
  {
    provide: ConfirmDeliveryByAdminUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      quoteRequestRepo: IQuoteRequestRepository,
      allocationRepo: IAllocationRepository,
    ) => {
      return new ConfirmDeliveryByAdminUseCase(
        txRunner,
        quoteRequestRepo,
        allocationRepo,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      QUOTE_REQUEST_REPOSITORY,
      ALLOCATION_REPOSITORY,
    ],
  },
  {
    provide: GetAllocationHistoryUseCase,
    useFactory: (
      txRunner: TransactionRunner,
      allocationRepo: IAllocationRepository,
      allocationLogRepo: IAllocationLogRepository,
      quoteRequestRepo?: IQuoteRequestRepository,
    ) => {
      return new GetAllocationHistoryUseCase(
        txRunner,
        allocationRepo,
        allocationLogRepo,
        quoteRequestRepo,
      );
    },
    inject: [
      TRANSACTION_RUNNER,
      ALLOCATION_REPOSITORY,
      ALLOCATION_LOG_REPOSITORY,
      { token: QUOTE_REQUEST_REPOSITORY, optional: true },
    ],
  },
];

export const TRADING_FULFILLMENT_EXPORTS = [
  ListQuoteRequestAllocationsUseCase,
  ListArtisanAllocationsUseCase,
  GetAllocationByIdUseCase,
  GetAllocationHistoryUseCase,
  GetAllocationBatchesUseCase,
  StartAllocationProductionUseCase,
  LinkAllocationBatchesUseCase,
  HandoverAllocationUseCase,
  HandoverAllocationByAdminUseCase,
  ConfirmDeliveryUseCase,
  ConfirmDeliveryByAdminUseCase,
];
