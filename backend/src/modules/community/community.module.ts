import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { NEWS_REPOSITORY } from './application/ports/repositories/news.repository.port';
import { PrismaNewsRepository } from './adapters/persistence/repositories/prisma-news.repository';
import { CommunityService } from './application/services/community.service';
import { PublicNewsController } from './adapters/http/controllers/public-news.controller';
import { AdminNewsController } from './adapters/http/controllers/admin-news.controller';

const defaultControllers = [PublicNewsController, AdminNewsController];

const defaultProviders = [
  PrismaNewsRepository,
  { provide: NEWS_REPOSITORY, useExisting: PrismaNewsRepository },
  CommunityService,
];

@Module({
  imports: [DatabaseModule],
  controllers: defaultControllers,
  providers: defaultProviders,
  exports: [CommunityService, NEWS_REPOSITORY],
})
export class CommunityModule {
  static register(
    dependencies: Pick<ModuleMetadata, 'imports' | 'providers' | 'controllers'> = {},
  ): DynamicModule {
    return {
      module: CommunityModule,
      imports: [DatabaseModule, ...(dependencies.imports ?? [])],
      controllers: dependencies.controllers ?? defaultControllers,
      providers: [...defaultProviders, ...(dependencies.providers ?? [])],
      exports: [CommunityService, NEWS_REPOSITORY],
    };
  }
}
