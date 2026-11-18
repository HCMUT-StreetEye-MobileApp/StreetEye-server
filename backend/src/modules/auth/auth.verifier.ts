import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AppConfig } from '../../config/env.js';
import { AppError } from '../../http/errors.js';
import type { VerifyAccessToken } from './auth.types.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'A valid Supabase user access token is required.');
export const authUnavailable = () => new AppError(503, 'SERVICE_UNAVAILABLE', 'Authentication is temporarily unavailable.');

// The optional key resolver is for isolated cryptographic tests only. Production
// derives the trusted JWKS location from configuration, never from JWT headers.
export function createTokenVerifier(config: AppConfig, testKey?: JWTVerifyGetKey): VerifyAccessToken {
  if (!config.SUPABASE_URL) return async () => { throw authUnavailable(); };
  const issuer = `${config.SUPABASE_URL}/auth/v1`;
  const key = testKey ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    timeoutDuration: config.AUTH_TIMEOUT_MS,
    cooldownDuration: 30000,
    cacheMaxAge: 600000,
  });
  return async (token) => {
    if (token.length > 16384) throw unauthenticated();
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['ES256', 'RS256'], issuer, audience: 'authenticated',
        requiredClaims: ['sub', 'exp', 'iat', 'role', 'session_id'], clockTolerance: config.AUTH_CLOCK_TOLERANCE_SECONDS,
      });
      if (!payload.sub || !uuid.test(payload.sub) || payload.role !== 'authenticated'
        || typeof payload.session_id !== 'string' || !uuid.test(payload.session_id)
        || typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000 + config.AUTH_CLOCK_TOLERANCE_SECONDS
        || typeof payload.exp !== 'number' || payload.exp <= payload.iat) throw unauthenticated();
      // Never use user_metadata/app_metadata to authorize application roles.
      return { authUserId: payload.sub.toLowerCase(), sessionId: payload.session_id.toLowerCase() };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid
        || !(error instanceof errors.JOSEError) || error.code === 'ERR_JOSE_GENERIC') throw authUnavailable();
      throw unauthenticated();
    }
  };
}
