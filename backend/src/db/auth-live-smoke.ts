import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Client } from 'pg';
import { z } from 'zod';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { parseEnv } from '../config/env.js';
import { createApp } from '../app.js';
import { connectionSettings, createDatabase } from './database.js';
import { loadMigrations, migrationStatus, migrationUrl } from './migrations.js';
import { createTokenVerifier } from '../modules/auth/auth.verifier.js';
import { createContributorRepository } from '../modules/auth/auth.repository.js';
import type { Contributor } from '../modules/auth/auth.types.js';

class SmokeError extends Error {}
const marker = 'streeteye_be05_live_smoke_run';
const sessionSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1),
  user: z.object({ id: z.uuid(), is_anonymous: z.literal(true) }) });

// Only removes an anonymous account created by this exact test run. Related
// application data blocks deletion through existing foreign keys. No broad purge.
async function cleanup(admin: Client, runId: string) {
  await admin.query('BEGIN');
  try {
    const rows = await admin.query<{ id: string }>(`SELECT id FROM auth.users
      WHERE is_anonymous IS TRUE AND raw_user_meta_data->>$1=$2 FOR UPDATE`, [marker, runId]);
    if (rows.rows.length > 1) throw new SmokeError('Cleanup marker is ambiguous; no rows were deleted.');
    for (const row of rows.rows) {
      await admin.query('DELETE FROM public.contributors WHERE auth_user_id=$1', [row.id]);
      await admin.query('DELETE FROM auth.refresh_tokens WHERE user_id=$1', [row.id]);
      await admin.query('DELETE FROM auth.users WHERE id=$1', [row.id]);
    }
    await admin.query('COMMIT');
    return rows.rowCount;
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}

async function main() {
  const config = parseEnv(process.env);
  const cleanupRun = process.argv[2] === '--cleanup-run' ? process.argv[3] : undefined;
  if (process.argv.length > 2 && (!cleanupRun || !z.uuid().safeParse(cleanupRun).success || process.argv.length !== 4)) {
    throw new SmokeError('Use no arguments, or --cleanup-run <run UUID>.');
  }
  const admin = new Client(connectionSettings(config, migrationUrl(config)));
  admin.on('error', () => {});
  try {
    await admin.connect();
    if (cleanupRun) {
      console.log(JSON.stringify({ cleanup: 'passed', removedTestAccounts: await cleanup(admin, cleanupRun) }));
      return;
    }
    const key = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
    if (!config.SUPABASE_URL || !key) throw new SmokeError('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in local .env.');
    const pending = (await migrationStatus(admin, await loadMigrations())).pending;
    if (pending.length) throw new SmokeError('Apply pending migrations before the live Auth test.');
    const authUrl = `${config.SUPABASE_URL}/auth/v1`;
    async function authRequest(path: string, init: RequestInit = {}) {
      return fetch(`${authUrl}${path}`, { ...init, redirect: 'error',
        headers: { apikey: key!, 'Content-Type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(15000) });
    }
    const settings = await authRequest('/settings');
    if (!settings.ok) throw new SmokeError(`Auth settings rejected the publishable key (HTTP ${settings.status}).`);
    const settingsBody = await settings.json() as { external?: { anonymous_users?: boolean }; disable_signup?: boolean };
    if (!settingsBody.external?.anonymous_users || settingsBody.disable_signup) {
      throw new SmokeError('Enable anonymous sign-ins and allow signups in Supabase Authentication settings, then rerun. No test account was created.');
    }
    const database = createDatabase(config, () => {});
    const server = createServer(createApp(config, database.check, () => {}, {
      verifyToken: createTokenVerifier(config), resolveContributor: createContributorRepository(database.pool),
    }));
    const runId = randomUUID();
    let signupAttempted = false;
    try {
      if (await database.check() !== 'up') throw new SmokeError('Runtime database is not ready.');
      const runtime = await database.pool!.query('SELECT current_user AS role');
      if (runtime.rows[0].role !== 'streeteye_backend') throw new SmokeError('Live test requires the restricted runtime DATABASE_URL.');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const meUrl = `http://127.0.0.1:${address.port}/api/v1/me`;
      console.log(JSON.stringify({ liveAuth: 'started', runId }));
      signupAttempted = true;
      const signup = await authRequest('/signup', { method: 'POST', body: JSON.stringify({ data: { [marker]: runId, role: 'maintainer' } }) });
      if (!signup.ok) {
        const body = await signup.json() as { error_code?: string };
        const code = typeof body.error_code === 'string' && /^[a-z_]+$/.test(body.error_code) ? body.error_code : 'unknown';
        throw new SmokeError(`Anonymous sign-in failed (HTTP ${signup.status}, ${code}).`);
      }
      const session = sessionSchema.parse(await signup.json());
      const claims = decodeJwt(session.access_token);
      const now = Math.floor(Date.now() / 1000);
      const sessionCheck = await admin.query(`SELECT EXISTS(SELECT 1 FROM auth.sessions
        WHERE id=$1::uuid AND user_id=$2::uuid) AS present`, [claims.session_id,session.user.id]);
      console.log(JSON.stringify({ tokenDiagnostics: {
        algorithm: decodeProtectedHeader(session.access_token).alg,
        issuerMatches: claims.iss === authUrl, audienceMatches: claims.aud === 'authenticated',
        roleMatches: claims.role === 'authenticated', subjectMatches: claims.sub === session.user.id,
        hasSessionId: typeof claims.session_id === 'string', sessionPresent: sessionCheck.rows[0].present,
        expiresInSeconds: typeof claims.exp === 'number' ? claims.exp - now : null,
        issuedSecondsAgo: typeof claims.iat === 'number' ? now - claims.iat : null,
      } }));
      async function me(token: string, expected: number) {
        const response = await fetch(meUrl, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
        if (response.status !== expected) throw new SmokeError(`/me returned ${response.status}; expected ${expected}.`);
        return response;
      }
      // Five simultaneous first requests exercise actual unique-key contention.
      const identities = await Promise.all(Array.from({ length: 5 }, async () =>
        await (await me(session.access_token, 200)).json() as Contributor));
      const first = identities[0]!;
      assert.equal(first.role, 'rider');
      assert.equal(first.disabled, false);
      assert.ok(z.uuid().safeParse(first.contributor_id).success);
      assert.ok(identities.every((identity) => JSON.stringify(identity) === JSON.stringify(first)));
      const count = await admin.query('SELECT count(*)::int AS n FROM public.contributors WHERE auth_user_id=$1', [session.user.id]);
      assert.equal(count.rows[0].n, 1);
      const refreshedResponse = await authRequest('/token?grant_type=refresh_token', {
        method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (!refreshedResponse.ok) throw new SmokeError(`Token refresh failed (HTTP ${refreshedResponse.status}).`);
      const refreshed = sessionSchema.parse(await refreshedResponse.json());
      assert.equal(refreshed.user.id, session.user.id);
      assert.deepEqual(await (await me(refreshed.access_token, 200)).json(), first);
      const logout = await authRequest('/logout?scope=local', { method: 'POST', headers: { Authorization: `Bearer ${refreshed.access_token}` } });
      if (!logout.ok) throw new SmokeError(`Logout failed (HTTP ${logout.status}).`);
      await me(refreshed.access_token, 401);
      await me(session.access_token, 401);
      console.log(JSON.stringify({ liveAuth: 'passed', supabaseIssuedToken: true, concurrentMe: 5,
        contributorCount: 1, metadataCannotEscalateRole: true, refreshedMe: 200, afterLogout: 401 }));
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.close();
      if (signupAttempted) {
        try { console.log(JSON.stringify({ cleanup: 'passed', removedTestAccounts: await cleanup(admin, runId) })); }
        catch { throw new SmokeError(`Test cleanup failed. Retry npm.cmd run auth:live -- --cleanup-run ${runId}.`); }
      }
    }
  } finally { await admin.end(); }
}

main().catch((error: unknown) => {
  // Provider bodies, JWTs, refresh tokens, Zod inputs and SQL errors are never logged.
  console.error(JSON.stringify({ liveAuth: 'failed', message: error instanceof SmokeError ? error.message
    : 'Live Auth test failed. Check network, database permissions and Supabase Auth configuration.' }));
  process.exitCode = 1;
});
