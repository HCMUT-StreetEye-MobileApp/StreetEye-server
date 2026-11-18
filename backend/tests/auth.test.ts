import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, errors, type JWTPayload } from 'jose';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { AppError, errorHandler } from '../src/http/errors.js';
import { createTokenVerifier } from '../src/modules/auth/auth.verifier.js';
import { requireAuth, requireActiveContributor, requireRoles } from '../src/modules/auth/auth.middleware.js';
import { createContributorRepository } from '../src/modules/auth/auth.repository.js';
import type { AuthDependencies, Contributor } from '../src/modules/auth/auth.types.js';
import { createValidator } from '../src/contracts/validation.js';

const config = parseEnv({ NODE_ENV: 'test', SUPABASE_URL: 'https://auth-test.supabase.co' });
const issuer = `${config.SUPABASE_URL}/auth/v1`;
const user = randomUUID();
const session = randomUUID();
const contributor: Contributor = { contributor_id: randomUUID(), role: 'rider', disabled: false };
const keys = await generateKeyPair('ES256');
const publicKey = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'ES256' };
const verifyToken = createTokenVerifier(config, createLocalJWKSet({ keys: [publicKey] }));
async function token(overrides: JWTPayload = {}, key = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: user, session_id: session, role: 'authenticated', aud: 'authenticated',
    iss: issuer, iat: now, exp: now + 300, ...overrides }).setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).sign(key);
}
const quiet = () => {};
const deps = (value: Contributor = contributor): AuthDependencies => ({ verifyToken, resolveContributor: async () => value });
const appFor = (dependencies = deps()) => createApp(config, async () => 'up', quiet, dependencies);
async function statusError(action: Promise<unknown>, status: number) {
  await assert.rejects(action, (error: unknown) => error instanceof AppError && error.status === status);
}

test('real ES256 verification accepts a Supabase anonymous user and ignores metadata role', async () => {
  const jwt = await token({ is_anonymous: true, user_metadata: { role: 'maintainer' }, app_metadata: { role: 'maintainer' } });
  assert.deepEqual(await verifyToken(jwt), { authUserId: user, sessionId: session });
  const response = await request(appFor()).get('/api/v1/me').set('Authorization', `Bearer ${jwt}`).expect(200);
  assert.deepEqual(response.body, contributor);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.doesNotMatch(response.text, new RegExp(`${user}|${session}|access_token|user_metadata`));
  assert.ok(createValidator()('Contributor')(response.body));
});

test('JWT rejects tampering, wrong signing key, issuer, audience, role and identity', async () => {
  const stranger = await generateKeyPair('ES256');
  await statusError(verifyToken(await token({}, stranger.privateKey)), 401);
  const jwt = await token();
  const pieces = jwt.split('.');
  pieces[1] = Buffer.from(JSON.stringify({ sub: randomUUID(), exp: 9999999999 })).toString('base64url');
  await statusError(verifyToken(pieces.join('.')), 401);
  for (const claims of [
    { iss: 'https://other.supabase.co/auth/v1' }, { aud: 'anon' }, { role: 'service_role' },
    { role: 'anon' }, { sub: 'device-id' }, { session_id: 'fake-session' },
  ]) await statusError(verifyToken(await token(claims)), 401);
});

test('JWT requires expiry/issued-at/session and enforces expiry, nbf and future issued-at', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [{ exp: now - 10 }, { nbf: now + 60 }, { iat: now + 60 }, { exp: now - 1, iat: now }]) {
    await statusError(verifyToken(await token(claims)), 401);
  }
  for (const claim of ['exp','iat','session_id','sub','role']) {
    const claims: JWTPayload = { sub: user, session_id: session, role: 'authenticated', aud: 'authenticated', iss: issuer, iat: now, exp: now + 300 };
    delete claims[claim];
    const jwt = await new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).sign(keys.privateKey);
    await statusError(verifyToken(jwt), 401);
  }
});

test('HS256, unsigned JWT, unknown key and malformed tokens are rejected', async () => {
  const jwt = await new SignJWT({ sub: user }).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32).fill(1));
  const unknown = await new SignJWT({ sub: user }).setProtectedHeader({ alg: 'ES256', kid: 'other' }).sign(keys.privateKey);
  for (const value of [jwt, unknown, 'eyJhbGciOiJub25lIn0.e30.', 'mock-rider-a', 'x'.repeat(16385)]) {
    await statusError(verifyToken(value), 401);
  }
});

test('configured clock tolerance handles measured clock drift but still rejects timestamps beyond its bound', async () => {
  const skewConfig = parseEnv({ NODE_ENV: 'test', SUPABASE_URL: config.SUPABASE_URL!, AUTH_CLOCK_TOLERANCE_SECONDS: '60' });
  const skewVerifier = createTokenVerifier(skewConfig, createLocalJWKSet({ keys: [publicKey] }));
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual(await skewVerifier(await token({ iat: now + 55, nbf: now + 55 })), { authUserId: user, sessionId: session });
  await statusError(verifyToken(await token({ iat: now + 55 })), 401);
  for (const claims of [{ iat: now + 80 }, { nbf: now + 80 }, { iat: now - 500, exp: now - 80 }]) {
    await statusError(skewVerifier(await token(claims)), 401);
  }
});

test('RS256 keys are supported for project signing-key rotation', async () => {
  const rsa = await generateKeyPair('RS256');
  const verifier = createTokenVerifier(config, createLocalJWKSet({ keys: [{ ...await exportJWK(rsa.publicKey), alg: 'RS256', kid: 'rsa' }] }));
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ sub: user, session_id: session, role: 'authenticated', aud: 'authenticated', iss: issuer, iat: now, exp: now + 60 })
    .setProtectedHeader({ alg: 'RS256', kid: 'rsa' }).sign(rsa.privateKey);
  assert.deepEqual(await verifier(jwt), { authUserId: user, sessionId: session });
});

test('JWKS transport failures produce retryable 503, not an invalid-login 401', async () => {
  for (const failure of [new errors.JWKSTimeout(), new errors.JOSEError('upstream failed'), new TypeError('secret URL')]) {
    const verifier = createTokenVerifier(config, async () => { throw failure; });
    await statusError(verifier(await token()), 503);
  }
});

test('missing/malformed/mock/API-key authorization fails before DB access', async () => {
  let calls = 0;
  const app = appFor({ verifyToken, resolveContributor: async () => { calls++; return contributor; } });
  for (const header of ['', 'Basic a.b.c', 'Bearer mock-rider-a', 'Bearer sb_publishable_fake', 'Bearer a.b.c, Bearer d.e.f', 'Bearer a.b.c extra']) {
    const response = await request(app).get('/api/v1/me').set('Authorization', header).expect(401);
    assert.equal(response.body.error.code, 'UNAUTHENTICATED');
    assert.match(response.headers['www-authenticate'] ?? '', /^Bearer/);
    assert.equal(response.body.error.requestId, response.headers['x-request-id']);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(calls, 0);
});

test('revoked session yields 401 and repository outage yields sanitized 503', async () => {
  const jwt = await token();
  await request(appFor({ verifyToken, resolveContributor: async () => undefined })).get('/api/v1/me').set('Authorization', `Bearer ${jwt}`).expect(401);
  const unavailable = createContributorRepository(undefined);
  const response = await request(appFor({ verifyToken, resolveContributor: unavailable })).get('/api/v1/me').set('Authorization', `Bearer ${jwt}`).expect(503);
  assert.equal(response.body.error.code, 'SERVICE_UNAVAILABLE');
  assert.doesNotMatch(response.text, /postgres|password|stack|session_id/);
});

test('disabled account may inspect /me but cannot write or pass maintainer guard', async () => {
  const jwt = await token();
  const disabled: Contributor = { ...contributor, role: 'maintainer', disabled: true };
  const me = await request(appFor(deps(disabled))).get('/api/v1/me').set('Authorization', `Bearer ${jwt}`).expect(200);
  assert.equal(me.body.disabled, true);
  const app = express();
  app.use(requireAuth(deps(disabled)));
  app.post('/write', requireActiveContributor, (_req,res) => res.sendStatus(204));
  app.post('/admin', requireRoles('maintainer'), (_req,res) => res.sendStatus(204));
  app.use(errorHandler(quiet));
  for (const path of ['/write','/admin']) await request(app).post(path).set('Authorization', `Bearer ${jwt}`).expect(403);
});

test('maintainer authorization uses current DB state on every request', async () => {
  let state = { ...contributor };
  const jwt = await token({ user_metadata: { role: 'maintainer' } });
  const app = express();
  app.post('/admin', requireAuth({ verifyToken, resolveContributor: async () => state }), requireRoles('maintainer'), (_req,res) => res.sendStatus(204));
  app.use(errorHandler(quiet));
  await request(app).post('/admin').set('Authorization', `Bearer ${jwt}`).expect(403);
  state = { ...contributor, role: 'maintainer' };
  await request(app).post('/admin').set('Authorization', `Bearer ${jwt}`).expect(204);
  state = { ...state, disabled: true };
  await request(app).post('/admin').set('Authorization', `Bearer ${jwt}`).expect(403);
});

test('auth guards fail closed if authentication middleware was omitted', async () => {
  const app = express();
  app.post('/write', requireActiveContributor, (_req,res) => res.sendStatus(204));
  app.post('/admin', requireRoles('maintainer'), (_req,res) => res.sendStatus(204));
  app.use(errorHandler(quiet));
  for (const path of ['/write','/admin']) await request(app).post(path).expect(401);
});

test('no Supabase URL fails closed while health and business mock isolation remain intact', async () => {
  const noAuth = parseEnv({ NODE_ENV: 'test' });
  const app = createApp(noAuth, async () => 'up', quiet);
  await request(app).get('/health').expect(200);
  await request(app).get('/api/v1/me').set('Authorization', `Bearer ${await token()}`).expect(503);
  await request(app).post('/api/v1/reports').send({}).expect(401);
});
