import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Client } from 'pg';
import { createLocalJWKSet, generateKeyPair, exportJWK, SignJWT } from 'jose';
import { parseEnv } from '../config/env.js';
import { createApp } from '../app.js';
import { connectionSettings } from './database.js';
import { migrationUrl } from './migrations.js';
import { createTokenVerifier } from '../modules/auth/auth.verifier.js';
import { createContributorRepository } from '../modules/auth/auth.repository.js';

// HTTP + cryptographic verification + real PostgreSQL integration. Test signing
// key is ephemeral, injected only into this server; no production auth bypass.
// All Auth/contributor fixture rows remain in a rollback-only transaction.
async function main() {
  const config = parseEnv(process.env);
  if (!config.SUPABASE_URL) throw new Error('Supabase URL required');
  const client = new Client(connectionSettings(config, migrationUrl(config)));
  client.on('error', () => {});
  const pair = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'ephemeral-db-smoke', alg: 'ES256' };
  const verifier = createTokenVerifier(config, createLocalJWKSet({ keys: [jwk] }));
  const server = createServer(createApp(config, async () => 'up', () => {}, {
    verifyToken: verifier, resolveContributor: createContributorRepository(client),
  }));
  try {
    await client.connect();
    await client.query('BEGIN');
    const authUser = randomUUID();
    const session = randomUUID();
    await client.query('INSERT INTO auth.users(id) VALUES ($1)', [authUser]);
    await client.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [session,authUser]);
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({ sub: authUser, session_id: session, role: 'authenticated',
      aud: 'authenticated', iss: `${config.SUPABASE_URL}/auth/v1`, iat: now, exp: now + 300,
      user_metadata: { role: 'maintainer' }, is_anonymous: true })
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid }).sign(pair.privateKey);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/api/v1/me`;
    async function me(expected: number) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, expected);
      return await response.json() as { contributor_id: string; role: string; disabled: boolean };
    }
    await client.query('SET LOCAL ROLE streeteye_backend');
    const first = await me(200);
    assert.equal(first.role, 'rider');
    assert.equal(first.disabled, false);
    assert.deepEqual(await me(200), first);
    await client.query('RESET ROLE');
    await client.query("UPDATE public.contributors SET role='maintainer',disabled_at=now() WHERE auth_user_id=$1",[authUser]);
    await client.query('SET LOCAL ROLE streeteye_backend');
    assert.deepEqual(await me(200), { ...first, role: 'maintainer', disabled: true });
    await client.query('RESET ROLE');
    await client.query('DELETE FROM auth.sessions WHERE id=$1', [session]);
    await client.query('SET LOCAL ROLE streeteye_backend');
    await me(401);
    await client.query('RESET ROLE');
    console.log(JSON.stringify({ authHttpSmoke: 'passed', status: [200,200,200,401], databaseRole: 'streeteye_backend',
      signingKey: 'ephemeral_test_only', fixtures: 'rollback_only', supabaseIssuedToken: false }));
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    try { await client.query('ROLLBACK'); } finally { await client.end(); }
  }
}
main().catch(() => { console.error(JSON.stringify({ authHttpSmoke: 'failed', message: 'Check DB migration, TLS and Supabase URL configuration.' })); process.exitCode = 1; });
