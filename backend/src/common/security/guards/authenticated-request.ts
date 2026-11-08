import type { Request } from 'express';
import type { AuthenticatedActor } from '../../application/types/contract-types';

export type { AuthenticatedActor } from '../../application/types/contract-types';
export const authenticatedActors: WeakMap<Request, AuthenticatedActor> = new WeakMap();
