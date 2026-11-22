import { Module } from "@nestjs/common";
import { DatabaseModule } from "../infrastructure/database/database.module";
import { SecurityModule } from "../common/security/security.module";
import { IdentityModule } from "../modules/identity/identity.module";
import { IdentityService } from "../modules/identity/application/services/identity.service";
import { TradingModule } from "../modules/trading/trading.module";

@Module({
  imports: [
    DatabaseModule,
    SecurityModule.register([IdentityModule.register(IdentityService)]),
    TradingModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
