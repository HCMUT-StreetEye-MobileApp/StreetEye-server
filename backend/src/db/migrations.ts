import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Client } from 'pg';
import type { AppConfig } from '../config/env.js';

export interface Migration { name: string; sql: string; checksum: string }
export class DatabaseCommandError extends Error {}

export function migrationUrl(config: AppConfig): string {
  if (!config.DIRECT_URL) throw new DatabaseCommandError('DIRECT_URL is required; use a session pooler or direct connection.');
  const url = new URL(config.DIRECT_URL);
  if (url.port === '6543' || url.searchParams.get('pgbouncer') === 'true') {
    throw new DatabaseCommandError('DIRECT_URL must not use transaction pooling (6543/pgbouncer=true).');
  }
  return config.DIRECT_URL;
}

export async function loadMigrations(directory = new URL('../../migrations/', import.meta.url)): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  if (!names.length) throw new DatabaseCommandError('No SQL migrations found.');
  const versions = new Set<string>();
  return Promise.all(names.map(async (name) => {
    const match = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(name);
    if (!match?.[1] || versions.has(match[1])) throw new DatabaseCommandError('Invalid or duplicate migration version.');
    versions.add(match[1]);
    const sql = (await readFile(new URL(name, directory), 'utf8')).replace(/\r\n/g, '\n');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

export function pendingMigrations(files: Migration[], applied: { name: string; checksum: string }[]): Migration[] {
  for (const [index, entry] of applied.entries()) {
    if (files[index]?.name !== entry.name || files[index]?.checksum !== entry.checksum) {
      throw new DatabaseCommandError('Migration history differs from source. Restore applied files; add a new migration for changes.');
    }
  }
  return files.slice(applied.length);
}

export async function migrationStatus(client: Client, files: Migration[]) {
  const exists = await client.query("SELECT to_regclass('streeteye_meta.schema_migrations') IS NOT NULL AS present");
  const applied = exists.rows[0].present
    ? (await client.query<{ name: string; checksum: string }>('SELECT name,checksum FROM streeteye_meta.schema_migrations ORDER BY name')).rows
    : [];
  return { applied, pending: pendingMigrations(files, applied) };
}

// Caller owns the transaction, so dry-run uses exactly the same SQL.
export async function applyMigrations(client: Client, files: Migration[]) {
  await client.query('SELECT pg_advisory_xact_lock(19370001, 1)');
  const { pending } = await migrationStatus(client, files);
  await client.query(`CREATE SCHEMA IF NOT EXISTS streeteye_meta;
    REVOKE ALL ON SCHEMA streeteye_meta FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS streeteye_meta.schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    );
    REVOKE ALL ON streeteye_meta.schema_migrations FROM PUBLIC;`);
  for (const migration of pending) {
    console.log(JSON.stringify({ applying: migration.name }));
    await client.query(migration.sql);
    await client.query('INSERT INTO streeteye_meta.schema_migrations(name,checksum) VALUES ($1,$2)', [migration.name, migration.checksum]);
  }
  return pending.map(({ name }) => name);
}
