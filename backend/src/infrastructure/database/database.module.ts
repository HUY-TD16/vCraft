import { Module } from '@nestjs/common';
import { AppConfigModule } from '../../common/config/app-config';
import { PrismaService } from './prisma/prisma.service';
import { TRANSACTION_RUNNER } from '../../common/application/ports/transaction-runner';
import { PrismaTransactionRunner } from './transactions/prisma-transaction-runner';

@Module({
  imports: [AppConfigModule],
  providers: [PrismaService, PrismaTransactionRunner, { provide: TRANSACTION_RUNNER, useExisting: PrismaTransactionRunner }],
  exports: [PrismaService, PrismaTransactionRunner, TRANSACTION_RUNNER],
})
export class DatabaseModule {}
