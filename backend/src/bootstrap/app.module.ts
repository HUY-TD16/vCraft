import { Module } from "@nestjs/common";
import { DatabaseModule } from "../infrastructure/database/database.module";
import { SecurityModule } from "../common/security/security.module";
import { IdentityModule } from "../modules/identity/identity.module";
import { IdentityService } from "../modules/identity/application/services/identity.service";
import { TradingModule } from "../modules/trading/trading.module";
import { WorkshopsModule } from "../modules/workshops/workshops.module";

@Module({
  imports: [
    DatabaseModule,
    SecurityModule.register([IdentityModule.register(IdentityService)]),
    TradingModule,
    WorkshopsModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
