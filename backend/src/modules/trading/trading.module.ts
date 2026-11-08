import { Module, type DynamicModule, type ModuleMetadata, type Type } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { TRADING_CONTRACT, type ITradingContract } from './public/contracts/trading.contract';

@Module({})
export class TradingModule {
  static register(
    implementation: Type<ITradingContract>,
    dependencies: Pick<ModuleMetadata, 'imports' | 'providers' | 'controllers'> = {},
  ): DynamicModule {
    return {
      module: TradingModule,
      imports: [DatabaseModule, ...(dependencies.imports ?? [])],
      controllers: dependencies.controllers ?? [],
      providers: [
        ...(dependencies.providers ?? []),
        implementation,
        { provide: TRADING_CONTRACT, useExisting: implementation },
      ],
      exports: [TRADING_CONTRACT],
    };
  }
}
