import { Module, type DynamicModule, type ModuleMetadata, type Type } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { WORKSHOP_CONTRACT, type IWorkshopContract } from './public/contracts/workshop.contract';

@Module({})
export class WorkshopsModule {
  static register(
    implementation: Type<IWorkshopContract>,
    dependencies: Pick<ModuleMetadata, 'imports' | 'providers' | 'controllers'> = {},
  ): DynamicModule {
    return {
      module: WorkshopsModule,
      imports: [DatabaseModule, ...(dependencies.imports ?? [])],
      controllers: dependencies.controllers ?? [],
      providers: [
        ...(dependencies.providers ?? []),
        implementation,
        { provide: WORKSHOP_CONTRACT, useExisting: implementation },
      ],
      exports: [WORKSHOP_CONTRACT],
    };
  }
}
