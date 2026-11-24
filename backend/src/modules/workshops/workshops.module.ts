import { Module, type DynamicModule, type ModuleMetadata, type Type } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { WORKSHOP_CONTRACT, type IWorkshopContract } from './public/contracts/workshop.contract';
import { WorkshopService } from './application/services/workshop.service';
import { WORKSHOP_REPOSITORY } from './application/ports/repositories/workshop.repository.port';
import { PrismaWorkshopRepository } from './adapters/persistence/repositories/prisma-workshop.repository';
import { PublicWorkshopsController } from './adapters/http/controllers/public-workshops.controller';
import { ArtisanWorkshopController } from './adapters/http/controllers/artisan-workshop.controller';
import { AdminWorkshopsController } from './adapters/http/controllers/admin-workshops.controller';

const defaultControllers = [
  PublicWorkshopsController,
  ArtisanWorkshopController,
  AdminWorkshopsController,
];

const defaultProviders = [
  PrismaWorkshopRepository,
  { provide: WORKSHOP_REPOSITORY, useClass: PrismaWorkshopRepository },
  WorkshopService,
  { provide: WORKSHOP_CONTRACT, useExisting: WorkshopService },
];

@Module({
  imports: [DatabaseModule],
  controllers: defaultControllers,
  providers: defaultProviders,
  exports: [WORKSHOP_CONTRACT, WorkshopService, WORKSHOP_REPOSITORY],
})
export class WorkshopsModule {
  static register(
    implementation: Type<IWorkshopContract> = WorkshopService,
    dependencies: Pick<ModuleMetadata, 'imports' | 'providers' | 'controllers'> = {},
  ): DynamicModule {
    const isDefault = implementation === WorkshopService;
    return {
      module: WorkshopsModule,
      imports: [DatabaseModule, ...(dependencies.imports ?? [])],
      controllers: dependencies.controllers ?? (isDefault ? defaultControllers : []),
      providers: [
        PrismaWorkshopRepository,
        { provide: WORKSHOP_REPOSITORY, useClass: PrismaWorkshopRepository },
        ...(isDefault ? [WorkshopService] : []),
        ...(dependencies.providers ?? []),
        implementation,
        { provide: WORKSHOP_CONTRACT, useExisting: implementation },
      ],
      exports: [WORKSHOP_CONTRACT, implementation],
    };
  }
}
