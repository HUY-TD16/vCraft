import { Module, type DynamicModule, type ModuleMetadata, type Type } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { MEDIA_CONTRACT, type IMediaContract } from './public/contracts/media.contract';

@Module({})
export class MediaModule {
  static register(
    implementation: Type<IMediaContract>,
    dependencies: Pick<ModuleMetadata, 'imports' | 'providers' | 'controllers'> = {},
  ): DynamicModule {
    return {
      module: MediaModule,
      imports: [DatabaseModule, ...(dependencies.imports ?? [])],
      controllers: dependencies.controllers ?? [],
      providers: [
        ...(dependencies.providers ?? []),
        implementation,
        { provide: MEDIA_CONTRACT, useExisting: implementation },
      ],
      exports: [MEDIA_CONTRACT],
    };
  }
}
