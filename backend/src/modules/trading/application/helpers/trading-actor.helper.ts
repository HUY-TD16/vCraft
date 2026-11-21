import type {
  AuthenticatedActor,
  Id,
  Role,
  TrustedActor,
} from '../../../../common/application/types/contract-types';
import {
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../domain';

export type TradingActor = AuthenticatedActor | TrustedActor;

export function assertTradingNormalSession(
  actor: TradingActor,
  message: string,
): void {
  if ('sessionLevel' in actor && actor.sessionLevel === 'temp_password') {
    throw new TradingDomainError('TEMP_PASSWORD_RESTRICTED', message);
  }
}

export function assertTradingRole(
  actor: TradingActor,
  expectedRole: Role | readonly Role[],
  message: string,
): void {
  const allowed: readonly Role[] = Array.isArray(expectedRole)
    ? expectedRole
    : [expectedRole as Role];
  if (!allowed.includes(actor.role)) {
    throw new TradingPermissionDeniedError(message);
  }
}

export function assertTradingArtisanWorkshop(
  actor: TradingActor,
  message: string = 'Artisan actor is not associated with any workshop.',
): Id {
  if (!actor.workshopId) {
    throw new TradingPermissionDeniedError(message);
  }
  return actor.workshopId;
}

export interface AssertTradingActorOptions {
  readonly expectedRole?: Role | readonly Role[];
  readonly tempPasswordMessage: string;
  readonly roleDeniedMessage?: string;
  readonly requireWorkshop?: boolean;
  readonly workshopDeniedMessage?: string;
  readonly checkRoleFirst?: boolean;
}

export function assertTradingActor(
  actor: TradingActor,
  options: AssertTradingActorOptions & { readonly requireWorkshop: true },
): asserts actor is TradingActor & { readonly workshopId: Id };
export function assertTradingActor(
  actor: TradingActor,
  options: AssertTradingActorOptions,
): void;
export function assertTradingActor(
  actor: TradingActor,
  options: AssertTradingActorOptions,
): void {
  if (options.checkRoleFirst) {
    if (options.expectedRole !== undefined) {
      assertTradingRole(
        actor,
        options.expectedRole,
        options.roleDeniedMessage ?? 'Unauthorized trading role.',
      );
    }
    if (options.requireWorkshop) {
      assertTradingArtisanWorkshop(actor, options.workshopDeniedMessage);
    }
    assertTradingNormalSession(actor, options.tempPasswordMessage);
    return;
  }

  assertTradingNormalSession(actor, options.tempPasswordMessage);
  if (options.expectedRole !== undefined) {
    assertTradingRole(
      actor,
      options.expectedRole,
      options.roleDeniedMessage ?? 'Unauthorized trading role.',
    );
  }
  if (options.requireWorkshop) {
    assertTradingArtisanWorkshop(actor, options.workshopDeniedMessage);
  }
}
