import { Module, type DynamicModule, type ModuleMetadata, type Type } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { IDENTITY_CONTRACT, type IIdentityContract } from './public/contracts/identity.contract';

@Module({})
export class IdentityModule {
  static register(
    implementation: Type<IIdentityContract>,
    dependencies: Pick<ModuleMetadata, 'imports' | 'providers' | 'controllers'> = {},
  ): DynamicModule {
    return {
      module: IdentityModule,
      imports: [DatabaseModule, ...(dependencies.imports ?? [])],
      controllers: dependencies.controllers ?? [],
      providers: [
        ...(dependencies.providers ?? []),
        implementation,
        { provide: IDENTITY_CONTRACT, useExisting: implementation },
      ],
      exports: [IDENTITY_CONTRACT],
    };
  }
}
