import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db/database.js';
import { parseEnv } from '../src/config/env.js';

test('no URL creates no pool and reports not_configured', async () => {
  const database = createDatabase(parseEnv({}), () => {});
  assert.equal(database.pool, undefined);
  assert.equal(await database.check(), 'not_configured');
  await database.close();
});

test('driver connection failure reports down without disclosing connection credentials', async () => {
  const events: unknown[] = [];
  const database = createDatabase(parseEnv({
    DATABASE_URL: 'postgresql://demo:private_password@127.0.0.1:1/streeteye',
    DB_SSL: 'disable',
    DB_TIMEOUT_MS: '100',
  }), (event, fields) => events.push({ event, fields }));
  try {
    assert.equal(await database.check(), 'down');
    assert.doesNotMatch(JSON.stringify(events), /private_password/);
    assert.equal(events.length, 1);
  } finally {
    await database.close();
  }
});
