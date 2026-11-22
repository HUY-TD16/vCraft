import {
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type Provider,
  type Type,
} from '@nestjs/common';
import { AppConfigModule } from '../../common/config/app-config';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AdminAllocationController } from './adapters/http/controllers/admin-allocation.controller';
import { AdminQuoteRequestController } from './adapters/http/controllers/admin-quote-request.controller';
import { AllocationController } from './adapters/http/controllers/allocation.controller';
import { ArtisanAllocationController } from './adapters/http/controllers/artisan-allocation.controller';
import { ArtisanQuoteRequestController } from './adapters/http/controllers/artisan-quote-request.controller';
import { BuyerQuoteRequestController } from './adapters/http/controllers/buyer-quote-request.controller';
import { QuoteRequestController } from './adapters/http/controllers/quote-request.controller';
import {
  TRADING_CORE_EXPORTS,
  TRADING_CORE_PROVIDERS,
  TRADING_FULFILLMENT_EXPORTS,
  TRADING_FULFILLMENT_PROVIDERS,
  TRADING_QUOTATION_EXPORTS,
  TRADING_QUOTATION_PROVIDERS,
  TRADING_REQUEST_EXPORTS,
  TRADING_REQUEST_PROVIDERS,
} from './providers';
import {
  TRADING_CONTRACT,
  type ITradingContract,
} from './public/contracts/trading.contract';

const defaultControllers = [
  BuyerQuoteRequestController,
  ArtisanQuoteRequestController,
  AdminQuoteRequestController,
  QuoteRequestController,
  ArtisanAllocationController,
  AdminAllocationController,
  AllocationController,
];

const defaultProviders: Provider[] = [
  ...TRADING_CORE_PROVIDERS,
  ...TRADING_REQUEST_PROVIDERS,
  ...TRADING_QUOTATION_PROVIDERS,
  ...TRADING_FULFILLMENT_PROVIDERS,
];

const defaultExports = [
  ...TRADING_REQUEST_EXPORTS,
  ...TRADING_QUOTATION_EXPORTS,
  ...TRADING_FULFILLMENT_EXPORTS,
  ...TRADING_CORE_EXPORTS,
];

@Module({
  imports: [AppConfigModule, DatabaseModule],
  controllers: defaultControllers,
  providers: defaultProviders,
  exports: defaultExports,
})
export class TradingModule {
  /**
   * Note (`docs/contracts/backend.md`): `WorkshopsModule` is not `@Global()`, so when
   * `WorkshopsModule` is implemented, pass `WorkshopsModule.register(...)` into
   * `dependencies.imports` (e.g. `TradingModule.register(TradingAcceptanceService, { imports: [workshopsModule] })`)
   * so `WORKSHOP_CONTRACT` resolves inside `TradingModule`.
   */
  static register(
    implementation: Type<ITradingContract>,
    dependencies: Pick<
      ModuleMetadata,
      'imports' | 'providers' | 'controllers'
    > = {},
  ): DynamicModule {
    const callerProviders = dependencies.providers ?? [];
    const hasImplementationProvider = [
      ...defaultProviders,
      ...callerProviders,
    ].some(
      (provider) =>
        provider === implementation ||
        (typeof provider === 'object' &&
          provider !== null &&
          'provide' in provider &&
          provider.provide === implementation),
    );

    return {
      module: TradingModule,
      imports: [
        AppConfigModule,
        DatabaseModule,
        ...(dependencies.imports ?? []),
      ],
      controllers: [
        ...defaultControllers,
        ...(dependencies.controllers ?? []),
      ],
      providers: [
        ...defaultProviders,
        ...callerProviders,
        ...(hasImplementationProvider ? [] : [implementation]),
        { provide: TRADING_CONTRACT, useExisting: implementation },
      ],
      exports: Array.from(
        new Set([TRADING_CONTRACT, implementation, ...defaultExports]),
      ),
    };
  }
}

export { TradingAcceptanceService } from './application/services/trading-acceptance.service';
export {
  TRADING_CONTRACT,
  type ITradingContract,
  type AcceptanceInput,
  type AcceptanceExecutionOptions,
} from './public/contracts/trading.contract';
