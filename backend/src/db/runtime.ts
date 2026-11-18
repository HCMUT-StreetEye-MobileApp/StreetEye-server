import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { Client } from 'pg';
import { parseEnv } from '../config/env.js';
import { connectionSettings } from './database.js';
import { DatabaseCommandError, loadMigrations, migrationStatus, migrationUrl } from './migrations.js';

// Explicit local setup command. Keeps the admin DIRECT_URL, changes only the
// server DATABASE_URL, and never prints passwords or complete connection URLs.
async function main() {
  const config = parseEnv(process.env);
  if (!config.DATABASE_URL) throw new DatabaseCommandError('DATABASE_URL is required.');
  const originalEnv = await readFile('.env', 'utf8');
  if ((originalEnv.match(/^DATABASE_URL=/gm) ?? []).length !== 1) throw new DatabaseCommandError('.env must contain exactly one DATABASE_URL.');
  const admin = new Client(connectionSettings(config, migrationUrl(config)));
  admin.on('error', () => {});
  let runtime: Client | undefined;
  try {
    await admin.connect();
    const status = await migrationStatus(admin, await loadMigrations());
    if (status.pending.length) throw new DatabaseCommandError('Apply pending migrations first.');
    const roles = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      FROM pg_roles WHERE rolname='streeteye_backend'`);
    const role = roles.rows[0];
    if (!role || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls) {
      throw new DatabaseCommandError('Runtime role is missing or has unexpected administrative privileges.');
    }
    const url = new URL(config.DATABASE_URL);
    const currentUser = decodeURIComponent(url.username);
    const alreadyConfigured = currentUser === 'streeteye_backend' || currentUser.startsWith('streeteye_backend.');
    if (!alreadyConfigured) {
      // Never rotate credentials of an already provisioned role implicitly.
      if (role.rolcanlogin) throw new DatabaseCommandError('Runtime login already exists; restore its DATABASE_URL instead of rotating its password.');
      const password = randomBytes(36).toString('hex');
      const suffix = currentUser.includes('.') ? currentUser.slice(currentUser.indexOf('.')) : '';
      url.username = `streeteye_backend${suffix}`;
      url.password = password;
      // Persist the generated credential before enabling LOGIN. If the final
      // rename fails, .env.runtime-tmp remains as a local recovery file.
      // Both .env and .env.* are gitignored; no secret enters migration history.
      if (await readFile('.env', 'utf8') !== originalEnv) throw new DatabaseCommandError('.env changed during setup; retry to preserve the new configuration.');
      const updatedEnv = originalEnv.replace(/^DATABASE_URL=.*$/m, () => `DATABASE_URL="${url.toString()}"`);
      await writeFile('.env.runtime-tmp', updatedEnv, { mode: 0o600 });
      await admin.query(`ALTER ROLE streeteye_backend LOGIN PASSWORD '${password}'`);
      await rename('.env.runtime-tmp', '.env');
    }
    runtime = new Client(connectionSettings(config, url.toString()));
    runtime.on('error', () => {});
    await runtime.connect();
    const access = await runtime.query(`SELECT current_user AS role,
      has_function_privilege(current_user,'streeteye_private.resolve_contributor(uuid,uuid)','EXECUTE') AS can_resolve,
      has_table_privilege(current_user,'public.contributors','SELECT,INSERT,UPDATE,DELETE') AS direct_contributors,
      has_schema_privilege(current_user,'public','CREATE') AS can_create_public`);
    const state = access.rows[0];
    if (state.role !== 'streeteye_backend' || !state.can_resolve || state.direct_contributors || state.can_create_public) {
      throw new DatabaseCommandError('Runtime privileges did not pass verification.');
    }
    console.log(JSON.stringify({ runtime: state.role, connected: true, restricted: true, env: '.env', adminUrlPreserved: true }));
  } finally {
    await runtime?.end();
    await admin.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ message: error instanceof DatabaseCommandError ? error.message
    : 'Runtime setup failed. Check migration status, local .env, pooler and filesystem access; no credentials were printed.' }));
  process.exitCode = 1;
});
