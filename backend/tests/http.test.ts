import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { errorHandler } from '../src/http/errors.js';
import type { DatabaseStatus } from '../src/db/database.js';

const config = parseEnv({ NODE_ENV: 'test' });
const quiet = () => {};
const appFor = (status: DatabaseStatus) => createApp(config, async () => status, quiet);

test('liveness remains healthy without invoking the database', async () => {
  const app = createApp(config, async () => { throw new Error('Database must not be called'); }, quiet);
  const response = await request(app).get('/health').expect(200);
  assert.deepEqual(response.body, { status: 'ok', service: 'streeteye-backend' });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-powered-by'], undefined);
});

for (const database of ['not_configured', 'down', 'up'] as const) {
  test(`readiness handles database=${database}`, async () => {
    const response = await request(appFor(database)).get('/health/ready').expect(database === 'up' ? 200 : 503);
    assert.deepEqual(response.body, { status: database === 'up' ? 'ready' : 'not_ready', checks: { database } });
  });
}

test('unexpected database adapter failure becomes 503 without leaking details', async () => {
  const app = createApp(config, async () => { throw new Error('postgres://secret@example.com/private'); }, quiet);
  const response = await request(app).get('/health/ready').expect(503);
  assert.equal(response.body.checks.database, 'down');
  assert.doesNotMatch(response.text, /secret/);
});

test('404 includes a server-generated request ID and ignores client-supplied IDs', async () => {
  const response = await request(appFor('not_configured')).get('/api/v1/reports').set('X-Request-Id', 'client-spoofed').expect(404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
  assert.equal(response.body.error.requestId, response.headers['x-request-id']);
  assert.match(response.body.error.requestId, /^[0-9a-f-]{36}$/);
  assert.notEqual(response.body.error.requestId, 'client-spoofed');
});

test('invalid JSON receives a structured 400 response', async () => {
  const response = await request(appFor('not_configured')).post('/health').set('Content-Type', 'application/json').send('{broken').expect(400);
  assert.equal(response.body.error.code, 'INVALID_JSON');
});

test('oversized JSON receives 413', async () => {
  const response = await request(appFor('not_configured')).post('/health').send({ text: 'a'.repeat(1024 * 1024) }).expect(413);
  assert.equal(response.body.error.code, 'PAYLOAD_TOO_LARGE');
});

test('CORS reflects only configured browser origins', async () => {
  const app = appFor('not_configured');
  const allowed = await request(app).get('/health').set('Origin', 'http://localhost:5173').expect(200);
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:5173');
  const other = await request(app).get('/health').set('Origin', 'https://other.example').expect(200);
  assert.equal(other.headers['access-control-allow-origin'], undefined);
});

test('Express forwards rejected async handlers to the sanitized error handler', async () => {
  const app = express();
  const events: unknown[] = [];
  app.get('/failure', async (_request, response) => {
    response.locals.requestId = 'test-request';
    throw new Error('password=do_not_disclose');
  });
  app.use(errorHandler((event, fields) => events.push({ event, fields })));
  const response = await request(app).get('/failure').expect(500);
  assert.equal(response.body.error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(response.text + JSON.stringify(events), /do_not_disclose/);
  assert.equal(events.length, 1);
});

test('Swagger page, local assets and OpenAPI JSON are served', async () => {
  const app = appFor('not_configured');
  await request(app).get('/docs/').expect(200).expect('Content-Type', /html/);
  await request(app).get('/docs/swagger-ui-bundle.js').expect(200);
  const response = await request(app).get('/openapi.json').expect(200);
  assert.equal(response.body.openapi, '3.0.3');
  assert.equal(Object.keys(response.body.paths).length, 14);
  assert.ok(response.body.paths['/api/v1/route-snapshots']);
  await request(app).post('/api/v1/reports').send({}).expect(401);
});
