import { Module, type DynamicModule, type ModuleMetadata, type Type } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { TRACEABILITY_CONTRACT, type ITraceabilityContract } from './public/contracts/traceability.contract';

@Module({})
export class TraceabilityModule {
  static register(
    implementation: Type<ITraceabilityContract>,
    dependencies: Pick<ModuleMetadata, 'imports' | 'providers' | 'controllers'> = {},
  ): DynamicModule {
    return {
      module: TraceabilityModule,
      imports: [DatabaseModule, ...(dependencies.imports ?? [])],
      controllers: dependencies.controllers ?? [],
      providers: [
        ...(dependencies.providers ?? []),
        implementation,
        { provide: TRACEABILITY_CONTRACT, useExisting: implementation },
      ],
      exports: [TRACEABILITY_CONTRACT],
    };
  }
}
