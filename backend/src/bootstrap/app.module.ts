import { Module } from "@nestjs/common";
import { DatabaseModule } from "../infrastructure/database/database.module";
import { SecurityModule } from "../common/security/security.module";
import { IdentityModule } from "../modules/identity/identity.module";
import { IdentityService } from "../modules/identity/application/services/identity.service";
import { TradingModule } from "../modules/trading/trading.module";
import { WorkshopsModule } from "../modules/workshops/workshops.module";
import { CommunityModule } from "../modules/community/community.module";
import { MediaModule } from "../modules/media/media.module";
import { MediaService } from "../modules/media/application/services/media.service";
import { WorkshopService } from "../modules/workshops/application/services/workshop.service";

const identityModule = IdentityModule.register(IdentityService);
const mediaModule = MediaModule.register(MediaService, { imports: [identityModule] });
const workshopsModule = WorkshopsModule.register(WorkshopService, { imports: [mediaModule] });

@Module({
  imports: [
    DatabaseModule,
    SecurityModule.register([identityModule]),
    mediaModule,
    TradingModule,
    workshopsModule,
    CommunityModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
