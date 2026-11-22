import { Module, type DynamicModule, type ModuleMetadata, type Type } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AppConfigModule } from '../../common/config/app-config';
import { IDENTITY_CONTRACT, type IIdentityContract } from './public/contracts/identity.contract';
import { PASSWORD_HASHER } from './application/ports/password-hasher.port';
import { Argon2PasswordHasher } from './adapters/crypto/argon2-password-hasher';
import { SESSION_MANAGER } from './application/ports/session-manager.port';
import { SessionManagerService } from './application/services/session-manager.service';
import { IDENTITY_REPOSITORY } from './application/ports/repositories/identity.repository.port';
import { PrismaIdentityRepository } from './adapters/persistence/repositories/prisma-identity.repository';
import { IdentityService } from './application/services/identity.service';
import { AuthController } from './adapters/http/controllers/auth.controller';
import { AdminAccountsController } from './adapters/http/controllers/admin-accounts.controller';

@Module({
  imports: [DatabaseModule, AppConfigModule],
  controllers: [AuthController, AdminAccountsController],
  providers: [
    Argon2PasswordHasher,
    { provide: PASSWORD_HASHER, useExisting: Argon2PasswordHasher },
    SessionManagerService,
    { provide: SESSION_MANAGER, useExisting: SessionManagerService },
    PrismaIdentityRepository,
    { provide: IDENTITY_REPOSITORY, useExisting: PrismaIdentityRepository },
    IdentityService,
    { provide: IDENTITY_CONTRACT, useExisting: IdentityService },
  ],
  exports: [
    IDENTITY_CONTRACT,
    IdentityService,
    PASSWORD_HASHER,
    Argon2PasswordHasher,
    SESSION_MANAGER,
    SessionManagerService,
    IDENTITY_REPOSITORY,
    PrismaIdentityRepository,
  ],
})
export class IdentityModule {
  static register(
    implementation: Type<IIdentityContract> = IdentityService,
    dependencies: Pick<ModuleMetadata, 'imports' | 'providers' | 'controllers'> = {},
  ): DynamicModule {
    return {
      module: IdentityModule,
      imports: [DatabaseModule, AppConfigModule, ...(dependencies.imports ?? [])],
      controllers: [
        AuthController,
        AdminAccountsController,
        ...(dependencies.controllers ?? []),
      ],
      providers: [
        Argon2PasswordHasher,
        { provide: PASSWORD_HASHER, useExisting: Argon2PasswordHasher },
        SessionManagerService,
        { provide: SESSION_MANAGER, useExisting: SessionManagerService },
        PrismaIdentityRepository,
        { provide: IDENTITY_REPOSITORY, useExisting: PrismaIdentityRepository },
        ...(dependencies.providers ?? []),
        implementation,
        { provide: IDENTITY_CONTRACT, useExisting: implementation },
      ],
      exports: [
        IDENTITY_CONTRACT,
        PASSWORD_HASHER,
        Argon2PasswordHasher,
        SESSION_MANAGER,
        SessionManagerService,
        IDENTITY_REPOSITORY,
        PrismaIdentityRepository,
      ],
    };
  }
}
