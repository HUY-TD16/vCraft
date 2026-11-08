import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ApiProblem } from '../../http/filters/api-problem';
import { authenticatedActors } from '../guards/authenticated-request';

export const CurrentActor = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const actor = authenticatedActors.get(context.switchToHttp().getRequest<Request>());
  if (!actor) throw new ApiProblem('AUTHENTICATION_REQUIRED');
  return actor;
});
