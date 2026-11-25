import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../common/config/app-config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: Pick<AppConfig, 'DATABASE_URL'>) {
    const connectionString = config.DATABASE_URL;
    const url = new URL(connectionString);
    const schema = url.searchParams.get('schema') ?? undefined;
    const connectionOptions = url.searchParams.get('options');
    const searchPathOption = schema && !connectionOptions && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)
      ? `-c search_path="${schema}"`
      : undefined;
    const poolConfig = {
      connectionString,
      options: [connectionOptions, searchPathOption, '-c timezone=UTC'].filter(Boolean).join(' '),
    };
    super({ adapter: new PrismaPg(poolConfig, { schema }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
