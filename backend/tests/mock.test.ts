import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createMockApp } from '../src/mock/app.js';
import { createValidator } from '../src/contracts/validation.js';
import { examples, fixtureTime, ids } from '../src/contracts/fixtures.js';
import { limits } from '../src/contracts/schemas.js';

const app = () => createMockApp(() => new Date(fixtureTime));
const auth = 'Bearer mock-rider-a';
const validator = createValidator();
const mode = '?data_mode=demo';
const bbox = { data_mode: 'demo', min_longitude: 106, min_latitude: 10, max_longitude: 107, max_latitude: 11 };
function conforms(name: string, body: unknown) {
  const validate = validator(name);
  assert.ok(validate(body), `${name}: ${JSON.stringify(validate.errors)}`);
}

test('mock exposes contract, client config, fixture asset and clearly marked no-DB health', async () => {
  const server = app();
  await request(server).get('/docs/').expect(200);
  await request(server).get('/mock-assets/landmark.svg').expect(200).expect('Content-Type', /svg/);
  const spec = await request(server).get('/openapi.json').expect(200);
  assert.equal(spec.body.info.version, '0.3.0');
  const config = await request(server).get('/api/v1/config').expect(200);
  conforms('ClientConfig', config.body);
  assert.equal(config.headers['x-streeteye-mock'], 'true');
  assert.equal(config.headers['cache-control'], 'no-store');
  const health = await request(server).get('/health/ready').expect(503);
  assert.equal(health.body.checks.database, 'not_configured');
});

test('identity requires exact mock token; arbitrary or real-looking tokens are not accepted', async () => {
  const server = app();
  for (const token of ['', 'Bearer anything', 'Bearer eyJ.real.jwt']) {
    const response = await request(server).get('/api/v1/me').set('Authorization', token).expect(401);
    conforms('Error', response.body); assert.equal(response.headers['www-authenticate'], 'Bearer');
  }
  const me = await request(server).get('/api/v1/me').set('Authorization', auth).expect(200);
  conforms('Contributor', me.body); assert.equal(me.body.contributor_id, ids.riderA);
});

test('report retry canonicalizes property order/defaults/timestamps and rejects changed payload', async () => {
  const server = app();
  const first = await request(server).post('/api/v1/reports').set('Authorization', auth).send(examples.manual).expect(201);
  conforms('ReportReceipt', first.body); assert.equal(first.headers['idempotency-replayed'], 'false');
  const reordered = Object.fromEntries(Object.entries({ ...examples.manual, observed_at: '2026-11-17T03:00:00Z', severity: 'unknown', heading_deg: null }).reverse());
  const retry = await request(server).post('/api/v1/reports').set('Authorization', auth).set('X-Mock-Scenario', 'stale').send(reordered).expect(200);
  assert.deepEqual(retry.body, first.body); assert.equal(retry.headers['idempotency-replayed'], 'true');
  assert.notEqual(first.headers['x-request-id'], retry.headers['x-request-id']);
  const conflict = await request(server).post('/api/v1/reports').set('Authorization', auth).send({ ...examples.manual, accuracy_m: 12 }).expect(409);
  conforms('Error', conflict.body); assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(conflict.body.error.requestId, conflict.headers['x-request-id']);
  await request(server).post('/api/v1/reports').set('Authorization', 'Bearer mock-rider-b').send(examples.manual).expect(201);
});

test('report ownership is isolated and receipt contains no internal storage/hash/auth fields', async () => {
  const server = app();
  const submitted = await request(server).post('/api/v1/reports').set('Authorization', auth).send(examples.manual).expect(201);
  const path = `/api/v1/reports/${submitted.body.report_id}`;
  const own = await request(server).get(path).set('Authorization', auth).expect(200);
  conforms('Report', own.body); assert.deepEqual(own.body.photos, []);
  assert.doesNotMatch(JSON.stringify(own.body), /payload_hash|storage_key|auth_user_id/);
  await request(server).get(path).set('Authorization', 'Bearer mock-rider-b').expect(404);
  await request(server).get(path).expect(401);
});

test('UUID case changes do not create duplicate events and expired fixtures are not revived', async () => {
  let time = new Date(fixtureTime);
  const server = createMockApp(() => time);
  const event = randomUUID();
  const first = await request(server).post('/api/v1/reports').set('Authorization', auth).send({ ...examples.manual, client_event_id: event }).expect(201);
  const replay = await request(server).post('/api/v1/reports').set('Authorization', auth).send({ ...examples.manual, client_event_id: event.toUpperCase() }).expect(200);
  assert.deepEqual(first.body, replay.body);
  await request(server).get(`/api/v1/reports/${String(first.body.report_id).toUpperCase()}`).set('Authorization', auth).expect(200);
  time = new Date(Date.parse(fixtureTime) + 7200000);
  const report = await request(server).post('/api/v1/reports').set('Authorization', auth)
    .send({ ...examples.manual, client_event_id: randomUUID(), observed_at: time.toISOString() }).expect(201);
  assert.equal(report.body.eligible_for_alert, false); assert.equal(report.body.hazard_id, null);
  const snapshot = await request(server).post('/api/v1/route-snapshots').send(examples.route).expect(200);
  assert.deepEqual(snapshot.body.hazards, []);
});

test('strict report subtypes reject unconfirmed sensor, missing classification and privileged fields', async () => {
  const server = app();
  for (const body of [
    { ...examples.manual, classification_method: undefined },
    { ...examples.manual, source: 'sensor_confirmed', classification_method: undefined },
    { ...examples.manual, confirmed_at: fixtureTime },
    { ...examples.manual, classification_method: 'timeout', hazard_type: 'pothole' },
    { ...examples.sensor, confirmed_at: '2026-11-17T02:59:00.000Z' },
  ]) await request(server).post('/api/v1/reports').set('Authorization', auth).send(body).expect(422);
  for (const change of [{ source: 'seed' }, { confidence_score: 100 }, { contributor_id: ids.riderB }, { status: 'active' }]) {
    await request(server).post('/api/v1/reports').set('Authorization', auth).send({ ...examples.manual, ...change }).expect(403);
  }
  const sensor = await request(server).post('/api/v1/reports').set('Authorization', auth).send(examples.sensor).expect(201);
  conforms('ReportReceipt', sensor.body); assert.equal(sensor.body.observed_at, examples.sensor.observed_at);
});

test('accepted report can be stale, low accuracy or needs-review without an alert hazard', async () => {
  const server = app();
  for (const [scenario, reason] of [['stale', 'STALE_OBSERVATION'], ['low_accuracy', 'LOW_LOCATION_ACCURACY'], ['needs_review', 'NEEDS_REVIEW']]) {
    const response = await request(server).post('/api/v1/reports').set('Authorization', auth).set('X-Mock-Scenario', scenario!)
      .send({ ...examples.manual, client_event_id: randomUUID() }).expect(201);
    conforms('ReportReceipt', response.body); assert.equal(response.body.accepted, true);
    assert.equal(response.body.eligible_for_alert, false); assert.equal(response.body.hazard_id, null);
    assert.deepEqual(response.body.reason_codes, [reason]);
  }
  const missing = await request(server).post('/api/v1/reports').set('Authorization', auth)
    .send({ ...examples.manual, client_event_id: randomUUID(), accuracy_m: undefined }).expect(201);
  assert.equal(missing.body.eligibility, 'needs_review'); assert.deepEqual(missing.body.reason_codes, ['MISSING_ACCURACY']);
});

test('observation validation distinguishes bad coordinates, timestamps and outside-pilot scenario', async () => {
  const server = app();
  for (const [body, code] of [
    [{ ...examples.manual, position: { longitude: 106, latitude: 91 } }, 'INVALID_COORDINATES'],
    [{ ...examples.manual, observed_at: '2026-02-30T03:00:00Z' }, 'INVALID_TIMESTAMP'],
    [{ ...examples.manual, observed_at: '2026-11-17T04:00:00Z' }, 'INVALID_TIMESTAMP'],
  ] as const) {
    const response = await request(server).post('/api/v1/reports').set('Authorization', auth).send(body).expect(422);
    assert.equal(response.body.error.code, code);
  }
  const outside = await request(server).post('/api/v1/reports').set('Authorization', auth).set('X-Mock-Scenario', 'outside_pilot').send(examples.manual).expect(422);
  assert.equal(outside.body.error.code, 'OUTSIDE_PILOT');
  const skew = await request(server).post('/api/v1/reports').set('Authorization', auth).send({ ...examples.manual, observed_at: '2026-11-17T03:01:00Z' }).expect(201);
  assert.equal(skew.body.observed_at_raw, '2026-11-17T03:01:00.000Z'); assert.equal(skew.body.observed_at, fixtureTime);
});

test('verification keeps older observations ineffective and never resolves on one cleared vote', async () => {
  const server = app();
  const path = `/api/v1/hazards/${ids.active}/verifications`;
  const first = await request(server).post(path).set('Authorization', auth).send(examples.verification).expect(201);
  conforms('VerificationReceipt', first.body); assert.equal(first.body.effective_at_receipt, true);
  const old = await request(server).post(path).set('Authorization', auth).send({ ...examples.verification,
    client_event_id: randomUUID(), observed_at: '2026-11-17T02:00:00Z' }).expect(201);
  assert.equal(old.body.effective_at_receipt, false);
  const replay = await request(server).post(path).set('Authorization', auth).send(examples.verification).expect(200);
  assert.deepEqual(replay.body, first.body);
  await request(server).post(`/api/v1/hazards/${ids.pending}/verifications`).set('Authorization', auth).send(examples.verification).expect(409);
  const unchanged = await request(server).get(`/api/v1/hazards/${ids.active}${mode}`).expect(200);
  assert.equal(unchanged.body.status, 'active');
  await request(server).post('/api/v1/reports').set('Authorization', auth).send(examples.manual).expect(201); // event scope differs
});

test('closed hazard verification is retained but ineligible; rejected and mismatched mode are hidden', async () => {
  const server = app();
  for (const hazard of [ids.resolved, ids.expired]) {
    const response = await request(server).post(`/api/v1/hazards/${hazard}/verifications`).set('Authorization', auth)
      .send({ ...examples.verification, client_event_id: randomUUID() }).expect(201);
    conforms('VerificationReceipt', response.body); assert.equal(response.body.eligible_for_score, false);
    assert.deepEqual(response.body.reason_codes, ['HAZARD_CLOSED']);
  }
  await request(server).get(`/api/v1/hazards/${ids.rejected}${mode}`).expect(404);
  await request(server).get(`/api/v1/hazards/${ids.active}?data_mode=pilot`).expect(403);
});

test('viewport paginates only open unexpired hazards and binds cursor to filters', async () => {
  const server = app();
  const first = await request(server).get('/api/v1/hazards').query({ ...bbox, limit: 1 }).expect(200);
  conforms('HazardList', first.body); assert.equal(first.body.hazards[0].warning_label, 'unverified');
  const next = await request(server).get('/api/v1/hazards').query({ ...bbox, limit: 1, cursor: first.body.next_cursor }).expect(200);
  assert.notEqual(next.body.hazards[0].hazard_id, first.body.hazards[0].hazard_id);
  await request(server).get('/api/v1/hazards').query({ ...bbox, limit: 2, cursor: first.body.next_cursor }).expect(422);
  await request(server).get('/api/v1/hazards').query({ ...bbox, min_latitude: 12 }).expect(422);
  await request(server).get('/api/v1/hazards').expect(422);
  const all = await request(server).get('/api/v1/hazards').query(bbox).expect(200);
  assert.equal(all.body.hazards.length, 3); assert.ok(all.body.hazards.some((h: { is_disputed: boolean }) => h.is_disputed));
  assert.ok(all.body.hazards.every((h: { alert_eligible: boolean }) => h.alert_eligible));
  const empty = await request(server).get('/api/v1/hazards').query({ ...bbox, min_longitude: 0, max_longitude: 1 }).expect(200);
  assert.deepEqual(empty.body.hazards, []);
});

test('snapshots echo revision, are complete, exclude closed hazards and honor offline image rights', async () => {
  const server = app();
  const response = await request(server).post('/api/v1/route-snapshots').send({ ...examples.route, route_revision: 'new-route' }).expect(200);
  conforms('RouteSnapshot', response.body); assert.equal(response.body.route_revision, 'new-route');
  assert.equal(response.body.complete, true); assert.equal(response.body.hazards.length, 3);
  assert.equal(response.body.turn_cues[0].maneuver_id, 'turn-1');
  assert.equal(Date.parse(response.body.expires_at) - Date.parse(response.body.generated_at), 1800000);
  const offline = await request(server).post('/api/v1/route-snapshots').send({ ...examples.route, offline: true }).expect(200);
  conforms('RouteSnapshot', offline.body); assert.deepEqual(offline.body.turn_cues[0].cue.images, []);
  assert.deepEqual(offline.body.warnings, ['NO_OFFLINE_IMAGE']);
  const noBearing = await request(server).post('/api/v1/route-snapshots').send({ ...examples.route,
    maneuvers: [{ maneuver_id: 'turn-1', location: examples.manual.position }] }).expect(200);
  assert.deepEqual(noBearing.body.turn_cues, []); assert.equal(noBearing.body.cue_fallbacks[0].reason, 'MISSING_BEARING');
});

test('Mapillary failure, missing images and missing cue provide valid fallbacks', async () => {
  const server = app();
  for (const scenario of ['mapillary_down', 'no_images', 'no_cue']) {
    const response = await request(server).post('/api/v1/route-snapshots').set('X-Mock-Scenario', scenario).send(examples.route).expect(200);
    conforms('RouteSnapshot', response.body); assert.equal(response.body.hazards.length, 3);
    if (scenario === 'no_cue') assert.equal(response.body.cue_fallbacks[0].reason, 'NO_ELIGIBLE_CUE');
    else { assert.deepEqual(response.body.turn_cues[0].cue.images, []); assert.ok(response.body.turn_cues[0].cue.instruction_vi); }
  }
  const landmark = await request(server).get(`/api/v1/landmarks/${ids.landmark}${mode}`).expect(200);
  conforms('Landmark', landmark.body);
  const degraded = await request(server).get(`/api/v1/landmarks/${ids.landmark}${mode}`).set('X-Mock-Scenario', 'mapillary_down').expect(200);
  assert.deepEqual(degraded.body.turn_cues[0].images, []);
});

test('route limits, coordinate ordering and maneuver uniqueness fail without partial snapshots', async () => {
  const server = app();
  const cases = [
    { body: { ...examples.route, geometry: { type: 'LineString', coordinates: Array.from({ length: limits.max_route_points + 1 }, () => [106.7, 10.8]) } }, status: 413, code: 'ROUTE_TOO_LARGE' },
    { body: { ...examples.route, geometry: { type: 'LineString', coordinates: [[0, 0], [2, 0]] } }, status: 413, code: 'ROUTE_TOO_LARGE' },
    { body: { ...examples.route, geometry: { type: 'LineString', coordinates: [[10.8, 106.7], [10.9, 106.7]] } }, status: 422, code: 'INVALID_COORDINATES' },
    { body: { ...examples.route, maneuvers: [...examples.route.maneuvers, ...examples.route.maneuvers] }, status: 422, code: 'INVALID_REQUEST' },
  ];
  for (const { body, status, code } of cases) {
    const response = await request(server).post('/api/v1/route-snapshots').send(body).expect(status);
    conforms('Error', response.body); assert.equal(response.body.error.code, code); assert.equal(response.body.complete, undefined);
  }
  const tooMany = await request(server).post('/api/v1/route-snapshots').set('X-Mock-Scenario', 'snapshot_too_large').send(examples.route).expect(413);
  assert.equal(tooMany.body.error.code, 'SNAPSHOT_TOO_LARGE');
});

test('mock error envelopes cover malformed JSON, content type, rate-limit and upstream failure', async () => {
  const server = app();
  for (const [scenario, status, code] of [['rate_limited', 429, 'RATE_LIMITED'], ['unavailable', 503, 'SERVICE_UNAVAILABLE']] as const) {
    const response = await request(server).get('/api/v1/config').set('X-Mock-Scenario', scenario).expect(status);
    conforms('Error', response.body); assert.equal(response.body.error.code, code); assert.ok(response.headers['retry-after']);
  }
  const invalid = await request(server).post('/api/v1/reports').set('Content-Type', 'application/json').set('Authorization', auth).send('{bad').expect(400);
  conforms('Error', invalid.body); assert.equal(invalid.body.error.code, 'INVALID_JSON');
  await request(server).post('/api/v1/reports').set('Authorization', auth).set('Content-Type', 'text/plain').send('test').expect(415);
  const large = await request(server).post('/api/v1/reports').set('Authorization', auth).send({ text: 'a'.repeat(1048576) }).expect(413);
  assert.equal(large.body.error.code, 'PAYLOAD_TOO_LARGE');
  await request(server).post('/api/v1/reports').set('Authorization', auth).set('X-Mock-Scenario', 'typo').send(examples.manual).expect(422);
});
