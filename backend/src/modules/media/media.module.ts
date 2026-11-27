import {
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type Type,
} from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { AppConfigModule } from "../../common/config/app-config";
import { IDENTITY_CONTRACT } from "../identity/public/contracts/identity.contract";
import { MEDIA_PERSISTENCE_PROVIDERS } from "./adapters/persistence/media-persistence.providers";
import { ContractImageAccessResolver } from "./adapters/access/contract-image-access-resolver";
import { IMAGE_ACCESS_RESOLVER } from "./application/ports/queries/image-access-resolver.port";
import { ADMIN_ASSERTION } from "./application/ports/admin-assertion.port";
import { MEDIA_APPLICATION_PROVIDERS } from "./application/media-application.providers";
import { MediaController, AdminWorkshopUploadScopesController } from "./adapters/http/controllers/media.controller";
import { MEDIA_CONTRACT, type IMediaContract } from "./public";

@Module({})
export class MediaModule {
  static register(
    implementation: Type<IMediaContract>,
    dependencies: Pick<
      ModuleMetadata,
      "imports" | "providers" | "controllers"
    > = {},
  ): DynamicModule {
    return {
      module: MediaModule,
      imports: [AppConfigModule, DatabaseModule, ...(dependencies.imports ?? [])],
      controllers: [MediaController, AdminWorkshopUploadScopesController, ...(dependencies.controllers ?? [])],
      providers: [
        ...MEDIA_PERSISTENCE_PROVIDERS,
        ...MEDIA_APPLICATION_PROVIDERS,
        ContractImageAccessResolver,
        { provide: IMAGE_ACCESS_RESOLVER, useExisting: ContractImageAccessResolver },
        { provide: ADMIN_ASSERTION, useExisting: IDENTITY_CONTRACT },
        ...(dependencies.providers ?? []),
        implementation,
        { provide: MEDIA_CONTRACT, useExisting: implementation },
      ],
      exports: [MEDIA_CONTRACT],
    };
  }
}
