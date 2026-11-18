import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from '../src/config/env.js';

test('empty DATABASE_URL supports running the foundation without a database', () => {
  const config = parseEnv({ DATABASE_URL: '', DB_SSL_CA_PATH: '' });
  assert.equal(config.DATABASE_URL, undefined);
  assert.equal(config.PORT, 3000);
  assert.equal(config.DB_SSL, 'verify-full');
});

test('invalid port prevents startup', () => {
  for (const PORT of ['0', '65536', 'abc', '1.5', '']) {
    assert.throws(() => parseEnv({ PORT }), /PORT/);
  }
});

test('invalid database configuration does not disclose credentials', () => {
  assert.throws(() => parseEnv({ DATABASE_URL: 'https://user:secret_password@example.com/database' }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /DATABASE_URL/);
    assert.doesNotMatch(error.message, /secret_password/);
    return true;
  });
});

test('URL SSL parameters cannot override verified TLS configuration', () => {
  for (const parameter of ['sslmode=disable', 'sslrootcert=x', 'ssl=true', 'uselibpqcompat=true']) {
    assert.throws(() => parseEnv({ DATABASE_URL: `postgresql://user:password@db.example.com/streeteye?${parameter}` }), /Remove SSL URL parameters/);
  }
});

test('CORS accepts exact origins, rejects wildcards and URL paths', () => {
  assert.equal(parseEnv({ CORS_ORIGINS: 'http://localhost:5173,https://example.com' }).CORS_ORIGINS, 'http://localhost:5173,https://example.com');
  for (const origin of ['*', 'https://example.com/app', 'https://example.com/']) {
    assert.throws(() => parseEnv({ CORS_ORIGINS: origin }), /CORS_ORIGINS/);
  }
});

test('Supabase URL is a trusted HTTPS origin and validation never discloses its input', () => {
  assert.equal(parseEnv({ SUPABASE_URL: 'https://project.supabase.co' }).SUPABASE_URL, 'https://project.supabase.co');
  for (const SUPABASE_URL of ['http://project.supabase.co','https://project.supabase.co/auth/v1','https://user:private_password@project.supabase.co','https://project.supabase.co/']) {
    assert.throws(() => parseEnv({ SUPABASE_URL }), (error: unknown) => {
      assert.ok(error instanceof Error); assert.match(error.message, /SUPABASE_URL/);
      assert.doesNotMatch(error.message, /private_password/); return true;
    });
  }
});

test('production requires database, Supabase Auth and verified TLS', () => {
  assert.throws(() => parseEnv({ NODE_ENV: 'production' }), /Required in production/);
  assert.throws(() => parseEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://user:pass@host/db', SUPABASE_URL: 'https://project.supabase.co', DB_SSL: 'disable' }), /verified TLS/);
  assert.throws(() => parseEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://postgres:pass@host/db', SUPABASE_URL: 'https://project.supabase.co' }), /restricted streeteye_backend/);
  assert.equal(parseEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://streeteye_backend.project:pass@host/db', SUPABASE_URL: 'https://project.supabase.co' }).NODE_ENV, 'production');
});

test('JWT clock tolerance is bounded and defaults to five seconds', () => {
  assert.equal(parseEnv({}).AUTH_CLOCK_TOLERANCE_SECONDS, 5);
  assert.equal(parseEnv({ AUTH_CLOCK_TOLERANCE_SECONDS: '60' }).AUTH_CLOCK_TOLERANCE_SECONDS, 60);
  for (const value of ['-1','121','1.5','invalid']) {
    assert.throws(() => parseEnv({ AUTH_CLOCK_TOLERANCE_SECONDS: value }), /AUTH_CLOCK_TOLERANCE_SECONDS/);
  }
});
