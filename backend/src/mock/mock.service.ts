import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { catalog, ids } from '../contracts/fixtures.js';
import { limits, policy } from '../contracts/schemas.js';

export interface Position { longitude: number; latitude: number }
interface Observation {
  client_event_id: string; data_mode: 'demo' | 'pilot'; position: Position; observed_at: string; accuracy_m?: number | null;
}
export interface ReportInput extends Observation {
  source: 'manual' | 'sensor_confirmed'; classification_method?: 'chosen' | 'timeout'; confirmed_at?: string;
  hazard_type?: string; severity?: string; heading_deg?: number | null; peak_accel_g?: number | null; speed_kmh?: number | null;
}
export interface VerificationInput extends Observation { result: 'still_present' | 'cleared' }
import type { HazardQuery, RouteInput } from '../contracts/read-types.js';
export type { HazardQuery, RouteInput } from '../contracts/read-types.js';
interface Receipt {
  client_event_id: string; data_mode: string; accepted: true; eligibility: string; reason_codes: string[];
  observed_at_raw: string; observed_at: string; received_at: string;
}
interface ReportReceipt extends Receipt { report_id: string; source: string; hazard_id: string | null; eligible_for_alert: boolean }
interface VerificationReceipt extends Receipt {
  verification_id: string; hazard_id: string; result: string; eligible_for_score: boolean; effective_at_receipt: boolean;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const iso = (value: string) => new Date(value).toISOString();
const fail = (status: number, code: string, message: string): never => { throw new AppError(status, code, message); };
function demoOnly(mode: string) {
  if (mode !== 'demo') fail(403, 'FORBIDDEN', 'Local mock only serves synthetic demo data.');
}
function meters(a: [number, number], b: [number, number]) {
  const radians = Math.PI / 180;
  const value = Math.sin((b[1] - a[1]) * radians / 2) ** 2
    + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin((b[0] - a[0]) * radians / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, value)));
}

export function createMockService(clock: () => Date = () => new Date()) {
  const fixtures = catalog(clock());
  const reports = new Map<string, { actor: string; hash: string; observation: ReportInput; receipt: ReportReceipt }>();
  const verifications = new Map<string, { actor: string; hash: string; receipt: VerificationReceipt }>();
  function capacity() {
    if (reports.size + verifications.size >= 1000) fail(503, 'SERVICE_UNAVAILABLE', 'Mock memory limit reached; restart mock to reset fixtures.');
  }
  function observation(input: Observation, scenario: string): Receipt {
    const now = clock();
    const raw = iso(input.observed_at);
    if (Date.parse(raw) > now.getTime() + policy.experimental.future_clock_skew_seconds * 1000) {
      fail(422, 'INVALID_TIMESTAMP', 'Observation is beyond the allowed future clock skew.');
    }
    if (scenario === 'outside_pilot') fail(422, 'OUTSIDE_PILOT', 'Synthetic outside-pilot scenario; no real pilot polygon is configured.');
    const reason = scenario === 'stale' ? 'STALE_OBSERVATION'
      : scenario === 'needs_review' ? 'NEEDS_REVIEW'
      : scenario === 'too_far' ? 'TOO_FAR'
      : input.accuracy_m == null ? 'MISSING_ACCURACY'
      : scenario === 'low_accuracy' || input.accuracy_m > policy.experimental.max_accuracy_m ? 'LOW_LOCATION_ACCURACY' : null;
    return { client_event_id: input.client_event_id, data_mode: input.data_mode, accepted: true,
      eligibility: reason === null ? 'eligible' : ['MISSING_ACCURACY', 'NEEDS_REVIEW'].includes(reason) ? 'needs_review' : 'ineligible',
      reason_codes: reason === null ? [] : [reason], observed_at_raw: raw,
      observed_at: new Date(Math.min(Date.parse(raw), now.getTime())).toISOString(), received_at: now.toISOString() };
  }
  function getHazard(id: string, mode: string) {
    demoOnly(mode);
    const found = fixtures.hazards.find((h) => h.hazard_id === id && h.status !== 'rejected');
    if (!found) return fail(404, 'NOT_FOUND', 'Hazard not found in this data mode.');
    return { ...structuredClone(found), alert_eligible: found.alert_eligible && Date.parse(found.expires_at) > clock().getTime() };
  }
  function report(input: ReportInput, actor: string, scenario: string) {
    demoOnly(input.data_mode);
    const normalized: ReportInput = { ...input, client_event_id: input.client_event_id.toLowerCase(), observed_at: iso(input.observed_at),
      hazard_type: input.hazard_type ?? 'unknown', severity: input.severity ?? 'unknown', accuracy_m: input.accuracy_m ?? null,
      heading_deg: input.heading_deg ?? null,
      ...(input.source === 'sensor_confirmed' ? { confirmed_at: iso(input.confirmed_at!), peak_accel_g: input.peak_accel_g ?? null, speed_kmh: input.speed_kmh ?? null } : {}),
    };
    const key = `${actor}:${normalized.client_event_id}`;
    const fingerprint = hash(normalized);
    const previous = reports.get(key);
    if (previous) {
      if (previous.hash !== fingerprint) return fail(409, 'IDEMPOTENCY_CONFLICT', 'This report event ID was already used with different content.');
      return { status: 200, body: structuredClone(previous.receipt) };
    }
    if (input.source === 'manual' && input.classification_method === 'timeout' && normalized.hazard_type !== 'unknown') {
      fail(422, 'INVALID_REQUEST', 'A timed-out Quick Flag must have hazard_type unknown.');
    }
    if (normalized.confirmed_at && (Date.parse(normalized.confirmed_at) < Date.parse(normalized.observed_at)
      || Date.parse(normalized.confirmed_at) > clock().getTime() + policy.experimental.future_clock_skew_seconds * 1000)) {
      fail(422, 'INVALID_TIMESTAMP', 'Sensor confirmation must follow observation and stay within clock skew.');
    }
    const base = observation(normalized, scenario);
    if (base.eligibility === 'eligible' && !getHazard(ids.pending, input.data_mode).alert_eligible) {
      base.eligibility = 'needs_review'; base.reason_codes = ['NEEDS_REVIEW'];
    }
    const receipt: ReportReceipt = { ...base, report_id: randomUUID(), source: input.source,
      hazard_id: base.eligibility === 'eligible' ? ids.pending : null, eligible_for_alert: base.eligibility === 'eligible' };
    capacity();
    reports.set(key, { actor, hash: fingerprint, observation: structuredClone(input), receipt });
    return { status: 201, body: structuredClone(receipt) };
  }
  function verification(input: VerificationInput, hazardId: string, actor: string, scenario: string) {
    demoOnly(input.data_mode);
    const normalized = { ...input, client_event_id: input.client_event_id.toLowerCase(), observed_at: iso(input.observed_at), accuracy_m: input.accuracy_m ?? null, hazard_id: hazardId };
    const key = `${actor}:${normalized.client_event_id}`;
    const fingerprint = hash(normalized);
    const previous = verifications.get(key);
    if (previous) {
      if (previous.hash !== fingerprint) return fail(409, 'IDEMPOTENCY_CONFLICT', 'This verification event ID was already used with different content.');
      return { status: 200, body: structuredClone(previous.receipt) };
    }
    const hazard = getHazard(hazardId, input.data_mode);
    const base = observation(normalized, scenario);
    if (!hazard.alert_eligible) { base.eligibility = 'ineligible'; base.reason_codes = ['HAZARD_CLOSED']; }
    const receipt: VerificationReceipt = { ...base, verification_id: randomUUID(), hazard_id: hazardId, result: input.result,
      eligible_for_score: base.eligibility === 'eligible', effective_at_receipt: false };
    const candidates = [...verifications.values()].filter((v) => v.actor === actor && v.receipt.hazard_id === hazardId && v.receipt.eligibility === 'eligible')
      .map((v) => v.receipt);
    if (receipt.eligibility === 'eligible') {
      const ordered = [...candidates, receipt].sort((a, b) => b.observed_at.localeCompare(a.observed_at)
        || b.received_at.localeCompare(a.received_at) || b.verification_id.localeCompare(a.verification_id));
      receipt.effective_at_receipt = ordered[0] === receipt;
    }
    capacity(); verifications.set(key, { actor, hash: fingerprint, receipt });
    return { status: 201, body: structuredClone(receipt) };
  }
  function listHazards(input: HazardQuery) {
    demoOnly(input.data_mode);
    if (input.min_longitude >= input.max_longitude || input.min_latitude >= input.max_latitude) fail(422, 'INVALID_COORDINATES', 'Bounding box minimums must be smaller than maximums.');
    const limit = input.limit ?? 100;
    const filter = hash({ ...input, limit, cursor: null });
    let offset = 0;
    if (input.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as { offset: number; filter: string };
        if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > fixtures.hazards.length || cursor.filter !== filter) throw new Error();
        offset = cursor.offset;
      } catch { fail(422, 'INVALID_REQUEST', 'Invalid cursor or changed filters.'); }
    }
    const {longitude,latitude,radius_m}=input;
    const near=[longitude,latitude,radius_m];
    if(near.some(v=>v!==undefined)&&near.some(v=>v===undefined)) fail(422,'INVALID_REQUEST','Supply all proximity parameters.');
    function within(p:Position){
      if(longitude===undefined||latitude===undefined||radius_m===undefined)return true;
      const r=Math.PI/180;
      const a=Math.sin((p.latitude-latitude)*r/2)**2+Math.cos(latitude*r)*Math.cos(p.latitude*r)*Math.sin((p.longitude-longitude)*r/2)**2;
      return 12742000*Math.asin(Math.min(1,Math.sqrt(a)))<=radius_m;
    }
    const all = fixtures.hazards.filter((h) => h.alert_eligible && Date.parse(h.expires_at) > clock().getTime()
      && within(h.location) && h.location.longitude >= input.min_longitude && h.location.longitude <= input.max_longitude
      && h.location.latitude >= input.min_latitude && h.location.latitude <= input.max_latitude)
      .sort((a, b) => a.hazard_id.localeCompare(b.hazard_id));
    const next = offset + limit;
    return { data_mode: input.data_mode, generated_at: clock().toISOString(), hazards: structuredClone(all.slice(offset, next)),
      next_cursor: next < all.length ? Buffer.from(JSON.stringify({ offset: next, filter })).toString('base64url') : null };
  }
  function getLandmark(id: string, mode: string, scenario: string) {
    demoOnly(mode);
    if (id !== ids.landmark) return fail(404, 'NOT_FOUND', 'Landmark not found.');
    const result = structuredClone(fixtures.landmark);
    if (['no_images', 'mapillary_down'].includes(scenario)) result.turn_cues.forEach((cue) => { cue.images = []; });
    return result;
  }
  function snapshot(input: RouteInput, scenario: string) {
    demoOnly(input.data_mode);
    for (const [, latitude] of input.geometry.coordinates) if (latitude < -90 || latitude > 90) fail(422, 'INVALID_COORDINATES', 'GeoJSON uses [longitude, latitude]; latitude must be between -90 and 90.');
    const length = input.geometry.coordinates.slice(1).reduce((sum, point, i) => sum + meters(input.geometry.coordinates[i]!, point), 0);
    if (length > limits.max_route_length_m) fail(413, 'ROUTE_TOO_LARGE', 'Route exceeds 50 km.');
    if (new Set(input.maneuvers.map((m) => m.maneuver_id)).size !== input.maneuvers.length) fail(422, 'INVALID_REQUEST', 'Maneuver IDs must be unique in one revision.');
    if (scenario === 'snapshot_too_large') fail(413, 'SNAPSHOT_TOO_LARGE', 'Snapshot cannot fit limits; request a shorter route.');
    const now = clock();
    const hazards = fixtures.hazards.filter((h) => h.alert_eligible && Date.parse(h.expires_at) > now.getTime());
    const turnCues: { maneuver_id: string; cue: typeof fixtures.cue }[] = [];
    const fallbacks: { maneuver_id: string; reason: string }[] = [];
    const warnings = new Set<string>();
    for (const maneuver of input.maneuvers) {
      if (maneuver.approach_bearing == null || maneuver.exit_bearing == null || scenario === 'no_cue') {
        fallbacks.push({ maneuver_id: maneuver.maneuver_id, reason: scenario === 'no_cue' ? 'NO_ELIGIBLE_CUE' : 'MISSING_BEARING' });
        continue;
      }
      // Scripted matching for fixtures only. Production must do route/heading matching.
      const cue = structuredClone(fixtures.cue);
      if (['no_images', 'mapillary_down'].includes(scenario)) { cue.images = []; warnings.add('LANDMARK_IMAGES_UNAVAILABLE'); }
      else if (input.offline) { cue.images = []; warnings.add('NO_OFFLINE_IMAGE'); }
      turnCues.push({ maneuver_id: maneuver.maneuver_id, cue });
    }
    return { snapshot_id: randomUUID(), data_mode: input.data_mode, route_revision: input.route_revision,
      policy_version: policy.policy_version, generated_at: now.toISOString(),
      expires_at: new Date(now.getTime() + limits.snapshot_ttl_seconds * 1000).toISOString(), complete: true,
      hazards: structuredClone(hazards), turn_cues: turnCues, cue_fallbacks: fallbacks, warnings: [...warnings] };
  }
  return {
    config: () => structuredClone(policy), report, verification, getHazard, listHazards, getLandmark, snapshot,
    me: (actor: string) => ({ contributor_id: actor, role: 'rider', disabled: false }),
    ownReport(id: string, actor: string) {
      const found = [...reports.values()].find((item) => item.receipt.report_id === id && item.actor === actor);
      if (!found) return fail(404, 'NOT_FOUND', 'Report not found.');
      return { receipt: structuredClone(found.receipt), observation: structuredClone(found.observation), photos: [] };
    },
  };
}
export type MockService = ReturnType<typeof createMockService>;
