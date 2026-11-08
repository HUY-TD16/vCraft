import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppConfigModule } from '../config/app-config';
import { AuthenticationGuard } from './guards/authentication.guard';
import { RolesGuard } from './guards/roles.guard';

@Module({})
export class SecurityModule {
  static register(imports: NonNullable<ModuleMetadata['imports']> = []): DynamicModule {
    return {
      module: SecurityModule,
      imports: [AppConfigModule, ...imports],
      providers: [
        AuthenticationGuard, RolesGuard,
        { provide: APP_GUARD, useExisting: AuthenticationGuard },
        { provide: APP_GUARD, useExisting: RolesGuard },
      ],
      exports: [AuthenticationGuard, RolesGuard],
    };
  }
}
