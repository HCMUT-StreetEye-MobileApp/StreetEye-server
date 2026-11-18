import { unauthenticated } from './auth.verifier.js';
import type { AuthDependencies } from './auth.types.js';

export function createAuthService(dependencies: AuthDependencies) {
  return {
    async authenticate(token: string) {
      const identity = await dependencies.verifyToken(token);
      const contributor = await dependencies.resolveContributor(identity);
      if (!contributor) throw unauthenticated();
      return contributor;
    },
  };
}
