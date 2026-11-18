import type { Pool } from 'pg';
import { authUnavailable } from './auth.verifier.js';
import type { Contributor, ResolveContributor } from './auth.types.js';

export function createContributorRepository(pool: Pick<Pool, 'query'> | undefined): ResolveContributor {
  return async ({ authUserId, sessionId }) => {
    if (!pool) throw authUnavailable();
    try {
      const result = await pool.query<Contributor>(
        'SELECT contributor_id, role, disabled FROM streeteye_private.resolve_contributor($1::uuid, $2::uuid)',
        [authUserId, sessionId],
      );
      return result.rows[0];
    } catch {
      // Do not expose database errors, identity details or connection secrets.
      throw authUnavailable();
    }
  };
}
