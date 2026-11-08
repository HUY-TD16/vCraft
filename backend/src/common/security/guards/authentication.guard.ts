import { Inject, Injectable, Optional, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IDENTITY_CONTRACT, type IIdentityContract } from '../../../modules/identity/public/contracts/identity.contract';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { ApiProblem } from '../../http/filters/api-problem';
import { ACCESS_POLICY, SESSION_LEVELS, type AccessPolicy, type SessionLevel } from '../decorators/access-policy';
import { authenticatedActors } from './authenticated-request';
import { requestContext } from '../../observability/request-context';

@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'NODE_ENV'>,
    @Optional() @Inject(IDENTITY_CONTRACT) private readonly identity?: IIdentityContract,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    authenticatedActors.delete(request);
    const logging = requestContext.getStore();
    if (logging) {
      logging.module = context.getClass().name;
      if (typeof request.route?.path === 'string') logging.route = request.route.path;
    }
    const targets = [context.getHandler(), context.getClass()];
    const policy = this.reflector.getAllAndOverride<AccessPolicy>(ACCESS_POLICY, targets);
    if (policy?.kind === 'public') return true;
    const cookieName = this.config.NODE_ENV === 'development' ? 'vcraft-session' : '__Host-vcraft-session';
    const token: unknown = request.cookies?.[cookieName];
    if (typeof token !== 'string' || !token) throw new ApiProblem('AUTHENTICATION_REQUIRED');
    if (!this.identity) throw new ApiProblem('SECURITY_SERVICE_UNAVAILABLE');
    const actor = await this.identity.resolveSession(token);
    if (!actor) throw new ApiProblem('SESSION_EXPIRED');
    const levels = this.reflector.getAllAndOverride<readonly SessionLevel[]>(SESSION_LEVELS, targets) ?? ['normal'];
    if (actor.sessionLevel === 'temp_password') {
      const path = request.path.replace(/\/$/, '');
      const allowed = (request.method === 'GET' && path === '/api/v1/auth/csrf')
        || (request.method === 'POST' && ['/api/v1/auth/logout', '/api/v1/auth/change-temp-password'].includes(path));
      if (!allowed || !levels.includes('temp_password')) throw new ApiProblem('TEMP_PASSWORD_RESTRICTED');
    } else if (!levels.includes(actor.sessionLevel)) {
      throw new ApiProblem('PERMISSION_DENIED');
    }
    authenticatedActors.set(request, Object.freeze({ ...actor }));
    return true;
  }
}
