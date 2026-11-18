import 'dotenv/config';
import { createServer } from 'node:http';
import { Client } from 'pg';
import { parseEnv, type AppConfig } from '../config/env.js';
import { connectionSettings, createDatabase } from './database.js';
import { createApp } from '../app.js';
import { applyMigrations, DatabaseCommandError, loadMigrations, migrationStatus, migrationUrl } from './migrations.js';
import { verifySchema } from './verify.js';
import { verifyAuthSchema } from './verify-auth.js';

async function verifyReadiness(config: AppConfig) {
  const database = createDatabase(config, () => {});
  const server = createServer(createApp(config, database.check, () => {}));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new DatabaseCommandError('HTTP smoke test could not bind.');
    const response = await fetch(`http://127.0.0.1:${address.port}/health/ready`, { signal: AbortSignal.timeout(15000) });
    const body = await response.json() as { checks?: { database?: string } };
    if (response.status !== 200 || body.checks?.database !== 'up') throw new DatabaseCommandError('HTTP readiness smoke test failed.');
    console.log(JSON.stringify({ endpoint: '/health/ready', status: response.status, database: body.checks.database }));
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await database.close();
  }
}

async function main() {
  const config = parseEnv(process.env);
  const command = process.argv[2] ?? 'check';
  if (!['check','status','migrate','dry-run','verify','ready'].includes(command)) throw new DatabaseCommandError('Unknown database command.');
  if (command === 'ready') return verifyReadiness(config);
  const targets = command === 'check'
    ? [['DATABASE_URL', config.DATABASE_URL], ['DIRECT_URL', config.DIRECT_URL]] as const
    : [['DIRECT_URL', migrationUrl(config)]] as const;
  for (const [field, url] of targets) {
    if (!url) throw new DatabaseCommandError(`${field} is required.`);
    const client = new Client({ ...connectionSettings(config, url), query_timeout: 120000, application_name: 'streeteye-db-cli' });
    client.on('error', () => {});
    client.on('notice', () => {});
    try {
      await client.connect();
      if (command === 'check') {
        const result = await client.query(`SELECT current_database() AS database,
          current_setting('server_version') AS version, 1 AS connected`);
        console.log(JSON.stringify({ target: field, ...result.rows[0], tls: config.DB_SSL }));
        if (field === 'DIRECT_URL') {
          const inventory = await client.query(`SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname IN ('public','streeteye_meta') AND c.relkind IN ('r','v','m') ORDER BY 1,2`);
          const extensions = await client.query(`SELECT e.extname, n.nspname AS schema FROM pg_extension e
            JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY 1`);
          const auth = await client.query("SELECT to_regclass('auth.users') IS NOT NULL AS auth_users_available");
          console.log(JSON.stringify({ relations: inventory.rows, extensions: extensions.rows, ...auth.rows[0] }));
        }
        continue;
      }
      const files = await loadMigrations();
      if (command === 'status') {
        const status = await migrationStatus(client, files);
        console.log(JSON.stringify({ applied: status.applied.map(({ name }) => name), pending: status.pending.map(({ name }) => name) }));
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='90s'");
        if (command === 'verify') {
          const status = await migrationStatus(client, files);
          console.log(JSON.stringify({ applied: status.applied.map(({ name }) => name), pending: status.pending.map(({ name }) => name) }));
          if (status.pending.length) throw new DatabaseCommandError('Run migrations before verification.');
          await verifySchema(client);
          await verifyAuthSchema(client);
        } else {
          const applied = await applyMigrations(client, files);
          if (command === 'dry-run') { await verifySchema(client); await verifyAuthSchema(client); }
          await client.query('SET CONSTRAINTS ALL IMMEDIATE');
          console.log(JSON.stringify({ migrations: applied }));
        }
        await client.query(command === 'migrate' ? 'COMMIT' : 'ROLLBACK');
        console.log(JSON.stringify({ command, outcome: command === 'migrate' ? 'committed' : 'rolled_back' }));
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      await client.end();
    }
  }
  if (command === 'verify') await verifyReadiness(config);
}

main().catch((error: unknown) => {
  // Driver messages/details can contain connection strings or row contents.
  const field = (key: string) => {
    const value = error && typeof error === 'object' && key in error ? String(Reflect.get(error,key)) : '';
    return /^[a-zA-Z0-9_]+$/.test(value) ? value : undefined;
  };
  const message = error instanceof DatabaseCommandError || (error instanceof Error && error.message.startsWith('Invalid environment:'))
    ? error.message : 'Database command failed. Check network, credentials, TLS CA and schema prerequisites.';
  console.error(JSON.stringify({ error: field('code') ?? 'UNKNOWN', constraint: field('constraint'), position: field('position'), message }));
  process.exitCode = 1;
});
