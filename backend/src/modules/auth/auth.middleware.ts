import type { RequestHandler, Response } from 'express';
import { AppError } from '../../http/errors.js';
import { createAuthService } from './auth.service.js';
import { unauthenticated } from './auth.verifier.js';
import type { AuthDependencies, Contributor } from './auth.types.js';

export function authenticatedContributor(response: Response): Contributor {
  const contributor = response.locals.contributor as Contributor | undefined;
  if (!contributor) throw unauthenticated();
  return contributor;
}

export function requireAuth(dependencies: AuthDependencies): RequestHandler {
  const service = createAuthService(dependencies);
  return async (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    // Reject ambiguous duplicate headers instead of accepting the first value.
    const count = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i]?.toLowerCase() === 'authorization').length;
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(request.get('Authorization') ?? '');
    if (count !== 1 || !match?.[1]) throw unauthenticated();
    response.locals.contributor = await service.authenticate(match[1]);
    next();
  };
}

// /me remains readable while disabled, so Mobile can explain the restriction.
// All future write/moderation routes must apply this guard after requireAuth.
export const requireActiveContributor: RequestHandler = (_request, response, next) => {
  if (authenticatedContributor(response).disabled) throw new AppError(403, 'FORBIDDEN', 'Contributions are disabled for this account.');
  next();
};

export function requireRoles(...roles: Contributor['role'][]): RequestHandler {
  return (_request, response, next) => {
    const contributor = authenticatedContributor(response);
    if (contributor.disabled || !roles.includes(contributor.role)) throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions.');
    next();
  };
}
