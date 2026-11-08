import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';

@Module({})
export class CommunityModule {
  static register(
    dependencies: Pick<ModuleMetadata, 'imports' | 'providers' | 'controllers'> = {},
  ): DynamicModule {
    return {
      module: CommunityModule,
      imports: [DatabaseModule, ...(dependencies.imports ?? [])],
      controllers: dependencies.controllers ?? [],
      providers: dependencies.providers ?? [],
      exports: [],
    };
  }
}

