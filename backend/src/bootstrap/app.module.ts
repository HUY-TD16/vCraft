import { Module } from '@nestjs/common';
import { DatabaseModule } from '../infrastructure/database/database.module';
import { SecurityModule } from '../common/security/security.module';
import { TradingModule } from '../modules/trading/trading.module';

@Module({
  imports: [DatabaseModule, SecurityModule.register(), TradingModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
