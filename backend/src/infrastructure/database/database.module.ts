import { Module } from '@nestjs/common';
import { AppConfigModule } from '../../common/config/app-config';
import { PrismaService } from './prisma/prisma.service';

@Module({
  imports: [AppConfigModule],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
