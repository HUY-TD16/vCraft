import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiProblem } from '../../http/filters/api-problem';
import { ACCESS_POLICY, type AccessPolicy } from '../decorators/access-policy';
import { authenticatedActors } from './authenticated-request';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const policy = this.reflector.getAllAndOverride<AccessPolicy>(ACCESS_POLICY, [context.getHandler(), context.getClass()]);
    if (policy?.kind === 'public') return true;
    const actor = authenticatedActors.get(context.switchToHttp().getRequest<Request>());
    if (!actor) throw new ApiProblem('AUTHENTICATION_REQUIRED');
    if (policy?.kind !== 'roles' || !policy.roles.includes(actor.role)) throw new ApiProblem('PERMISSION_DENIED');
    return true;
  }
}
