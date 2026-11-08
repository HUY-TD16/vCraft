import { Module, type DynamicModule, type ModuleMetadata, type Type } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { CATALOG_CONTRACT, type ICatalogContract } from './public/contracts/catalog.contract';

@Module({})
export class CatalogModule {
  static register(
    implementation: Type<ICatalogContract>,
    dependencies: Pick<ModuleMetadata, 'imports' | 'providers' | 'controllers'> = {},
  ): DynamicModule {
    return {
      module: CatalogModule,
      imports: [DatabaseModule, ...(dependencies.imports ?? [])],
      controllers: dependencies.controllers ?? [],
      providers: [
        ...(dependencies.providers ?? []),
        implementation,
        { provide: CATALOG_CONTRACT, useExisting: implementation },
      ],
      exports: [CATALOG_CONTRACT],
    };
  }
}
