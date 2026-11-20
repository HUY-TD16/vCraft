import { Module, type DynamicModule, type ModuleMetadata, type Type } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { IDENTITY_CONTRACT, type IIdentityContract } from './public/contracts/identity.contract';
import { PASSWORD_HASHER } from './application/ports/password-hasher.port';
import { Argon2PasswordHasher } from './adapters/crypto/argon2-password-hasher';
import { SESSION_MANAGER } from './application/ports/session-manager.port';
import { SessionManagerService } from './application/services/session-manager.service';

@Module({
  imports: [DatabaseModule],
  providers: [
    Argon2PasswordHasher,
    { provide: PASSWORD_HASHER, useExisting: Argon2PasswordHasher },
    SessionManagerService,
    { provide: SESSION_MANAGER, useExisting: SessionManagerService },
  ],
  exports: [
    PASSWORD_HASHER,
    Argon2PasswordHasher,
    SESSION_MANAGER,
    SessionManagerService,
  ],
})
export class IdentityModule {
  static register(
    implementation: Type<IIdentityContract>,
    dependencies: Pick<ModuleMetadata, 'imports' | 'providers' | 'controllers'> = {},
  ): DynamicModule {
    return {
      module: IdentityModule,
      imports: [DatabaseModule, ...(dependencies.imports ?? [])],
      controllers: dependencies.controllers ?? [],
      providers: [
        Argon2PasswordHasher,
        { provide: PASSWORD_HASHER, useExisting: Argon2PasswordHasher },
        SessionManagerService,
        { provide: SESSION_MANAGER, useExisting: SessionManagerService },
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
      ],
    };
  }
}
