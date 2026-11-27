import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiProblem } from '../../../../common/http/filters/api-problem';
import { authenticatedActors } from '../../../../common/security/guards/authenticated-request';
import { UploadRateLimiterService } from '../../application/services/upload-rate-limiter.service';

@Injectable()
export class MediaUploadRateLimitGuard implements CanActivate {
  constructor(@Inject(UploadRateLimiterService) private readonly limiter: UploadRateLimiterService) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const actor = authenticatedActors.get(request);
    if (!actor) throw new ApiProblem('AUTHENTICATION_REQUIRED');

    const release = this.limiter.acquire(actor.accountId);
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      response.off('finish', finish);
      response.off('close', finish);
      release();
    };
    response.once('finish', finish);
    response.once('close', finish);
    return true;
  }
}
