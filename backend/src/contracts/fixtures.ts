// Synthetic fixtures for client integration only; never seed these into pilot.
export const fixtureTime = '2026-11-17T03:00:00.000Z';
export const ids = {
  riderA: '00000000-0000-4000-8000-000000000001', riderB: '00000000-0000-4000-8000-000000000002',
  pending: '10000000-0000-4000-8000-000000000001', active: '10000000-0000-4000-8000-000000000002',
  resolved: '10000000-0000-4000-8000-000000000003', expired: '10000000-0000-4000-8000-000000000004',
  disputed: '10000000-0000-4000-8000-000000000005', rejected: '10000000-0000-4000-8000-000000000006',
  report: '20000000-0000-4000-8000-000000000001', event: '30000000-0000-4000-8000-000000000001',
  verification: '40000000-0000-4000-8000-000000000001', landmark: '50000000-0000-4000-8000-000000000001',
  cue: '60000000-0000-4000-8000-000000000001', image: '70000000-0000-4000-8000-000000000001',
  snapshot: '80000000-0000-4000-8000-000000000001', request: '90000000-0000-4000-8000-000000000001',
};
export const position = { longitude: 106.7, latitude: 10.8 };
export function catalog(now = new Date(fixtureTime)) {
  const time = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
  function hazard(id: string, status: string, score: number | null, disputed = false) {
    return { hazard_id: id, previous_hazard_id: null, data_mode: 'demo', hazard_type: 'unknown', severity: 'unknown',
      location: { ...position }, road_ref: null, direction_bearing: null, status, is_disputed: disputed,
      last_observed_at: time(-60), expires_at: time(status === 'expired' ? -1 : 3600), updated_at: time(0),
      confidence_score: score, score_version: score === null ? null : 'fixture-only-not-calibrated',
      computed_at: score === null ? null : time(0), alert_eligible: ['pending', 'active'].includes(status),
      warning_label: status === 'pending' ? 'unverified' : null, photos: [],
    };
  }
  const hazards = [hazard(ids.pending, 'pending', null), hazard(ids.active, 'active', 72),
    hazard(ids.resolved, 'resolved', 20), hazard(ids.expired, 'expired', 10),
    hazard(ids.disputed, 'active', 55, true), hazard(ids.rejected, 'rejected', null)];
  const image = { image_id: ids.image, image_source: 'team_seed', display_order: 1,
    url: '/mock-assets/landmark.svg', url_expires_at: time(3600), attribution: 'StreetEye — ảnh minh họa giả lập',
    captured_at: null, compass_angle: 0, offline_allowed: false, offline_expires_at: null };
  const cue = { cue_id: ids.cue, landmark_id: ids.landmark, data_mode: 'demo', landmark_name_vi: 'Mốc DEMO A (giả lập)',
    turn_location: { ...position }, approach_bearing: 0, exit_bearing: 90, bearing_tolerance_deg: 30,
    instruction_vi: 'Ví dụ thử giao diện: rẽ phải tại mốc DEMO A.', images: [image] };
  return { hazards, cue, landmark: { landmark_id: ids.landmark, data_mode: 'demo', name_vi: cue.landmark_name_vi,
    description_vi: 'Dữ liệu giả lập, không dùng để dẫn đường thực địa.', location: { ...position }, reviewed_at: null, turn_cues: [cue] } };
}

const samples = catalog();
export const examples = {
  manual: { client_event_id: ids.event, data_mode: 'demo', source: 'manual', classification_method: 'timeout',
    hazard_type: 'unknown', position, accuracy_m: 10, observed_at: fixtureTime },
  sensor: { client_event_id: ids.event, data_mode: 'demo', source: 'sensor_confirmed', hazard_type: 'pothole',
    position, accuracy_m: 8, observed_at: fixtureTime, confirmed_at: '2026-11-17T03:05:00.000Z', peak_accel_g: 2.8, speed_kmh: 20 },
  reportReceipt: { report_id: ids.report, client_event_id: ids.event, data_mode: 'demo', source: 'manual', accepted: true,
    eligibility: 'eligible', reason_codes: [], observed_at_raw: fixtureTime, observed_at: fixtureTime, received_at: fixtureTime,
    hazard_id: ids.pending, eligible_for_alert: true },
  verification: { client_event_id: ids.event, data_mode: 'demo', result: 'cleared', position, accuracy_m: 10, observed_at: fixtureTime },
  verificationReceipt: { verification_id: ids.verification, client_event_id: ids.event, data_mode: 'demo', hazard_id: ids.active,
    result: 'cleared', accepted: true, eligibility: 'eligible', reason_codes: [], eligible_for_score: true, effective_at_receipt: true,
    observed_at_raw: fixtureTime, observed_at: fixtureTime, received_at: fixtureTime },
  route: { data_mode: 'demo', route_revision: 'demo-route-rev-1', offline: false,
    geometry: { type: 'LineString', coordinates: [[106.699, 10.799], [106.7, 10.8], [106.701, 10.8]] },
    maneuvers: [{ maneuver_id: 'turn-1', location: position, approach_bearing: 0, exit_bearing: 90 }] },
  snapshot: { snapshot_id: ids.snapshot, data_mode: 'demo', route_revision: 'demo-route-rev-1', policy_version: 'be04-draft-1',
    generated_at: fixtureTime, expires_at: '2026-11-17T03:30:00.000Z', complete: true,
    hazards: samples.hazards.filter((h) => h.alert_eligible), turn_cues: [{ maneuver_id: 'turn-1', cue: samples.cue }], cue_fallbacks: [], warnings: [] },
};
