import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMigrations, migrationUrl, pendingMigrations } from '../src/db/migrations.js';
import { parseEnv } from '../src/config/env.js';

test('migrations require an explicit session/direct URL', () => {
  assert.throws(() => migrationUrl(parseEnv({ DATABASE_URL: 'postgres://user:secret@localhost:6543/postgres' })), /DIRECT_URL/);
  for (const DIRECT_URL of ['postgres://user:secret@localhost:6543/postgres','postgres://user:secret@localhost:5432/postgres?pgbouncer=true']) {
    assert.throws(() => migrationUrl(parseEnv({ DIRECT_URL })), /transaction pooling/);
  }
  const DIRECT_URL='postgres://user:secret@localhost:5432/postgres';
  assert.equal(migrationUrl(parseEnv({ DIRECT_URL })),DIRECT_URL);
});

test('migration history rejects edits, unknown versions and skipped order', async () => {
  const files=await loadMigrations();
  const first=files[0]!;
  assert.equal(first.checksum.length,64);
  assert.equal(pendingMigrations(files,[]).length,files.length);
  assert.equal(pendingMigrations(files,[first]).length,files.length-1);
  assert.throws(() => pendingMigrations(files,[{...first,checksum:'changed'}]), /history differs/);
  assert.throws(() => pendingMigrations(files,[{...first,name:'999_unknown.sql'}]), /history differs/);
});

test('DIRECT_URL validation protects TLS and does not reveal credentials', () => {
  for (const suffix of ['?sslmode=disable','#raw-fragment']) {
    assert.throws(() => parseEnv({ DIRECT_URL:`postgres://user:private_password@localhost/postgres${suffix}` }), (error: unknown) => {
      assert.ok(error instanceof Error); assert.match(error.message,/DIRECT_URL/);
      assert.doesNotMatch(error.message,/private_password/); return true;
    });
  }
  assert.throws(() => parseEnv({ DB_SSL:'disable',DB_SSL_CA_PATH:'certs/server-ca.crt' }), /CA file requires/);
});
