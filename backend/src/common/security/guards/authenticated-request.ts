import type { Request } from 'express';
import type { IIdentityContract } from '../../../modules/identity/public/contracts/identity.contract';

export type AuthenticatedActor = Readonly<NonNullable<Awaited<ReturnType<IIdentityContract['resolveSession']>>>>;
export const authenticatedActors: WeakMap<Request, AuthenticatedActor> = new WeakMap();
