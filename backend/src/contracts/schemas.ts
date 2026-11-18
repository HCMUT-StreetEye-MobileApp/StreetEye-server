import type { SchemaObject } from 'ajv';

export const limits = {
  max_request_bytes: 1048576, max_route_points: 2000, max_maneuvers: 200,
  max_route_length_m: 50000, max_snapshot_hazards: 500, max_snapshot_cues: 200,
  max_page_size: 200, snapshot_ttl_seconds: 1800,
};
export const ref = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });
const text = (maxLength = 200): SchemaObject => ({ type: 'string', minLength: 1, maxLength });
const enumeration = (...values: string[]): SchemaObject => ({ type: 'string', enum: values });
const number = (minimum: number, maximum?: number): SchemaObject => ({ type: 'number', minimum, ...(maximum === undefined ? {} : { maximum }) });
const integer = (minimum = 0, maximum?: number): SchemaObject => ({ ...number(minimum, maximum), type: 'integer' });
const nullable = (schema: SchemaObject): SchemaObject => ({ ...schema, nullable: true, ...(schema.enum ? { enum: [...schema.enum, null] } : {}) });
const array = (items: SchemaObject, maxItems = 500): SchemaObject => ({ type: 'array', items, maxItems });
export const object = (properties: Record<string, SchemaObject>, required = Object.keys(properties)): SchemaObject =>
  ({ type: 'object', additionalProperties: false, required, properties });
const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const timestamp: SchemaObject = { type: 'string', format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$',
  description: 'ISO 8601 UTC, tối đa milliseconds, ví dụ 2026-11-17T03:00:00.000Z.' };
const bearing: SchemaObject = { type: 'number', minimum: 0, maximum: 360, exclusiveMaximum: true };
const bool: SchemaObject = { type: 'boolean' };
const mode = enumeration('demo', 'pilot');
const hazardType = enumeration('pothole', 'flood', 'roadwork', 'unknown');
const severity = enumeration('unknown', 'low', 'medium', 'high');
const eligibility = enumeration('eligible', 'ineligible', 'needs_review');
const position = object({ longitude: number(-180, 180), latitude: number(-90, 90) });
const observation = {
  client_event_id: uuid, data_mode: mode, position: ref('Position'), observed_at: timestamp,
  accuracy_m: nullable(number(0)),
};
const reportProperties = {
  ...observation, hazard_type: { ...hazardType, default: 'unknown' }, severity: { ...severity, default: 'unknown' },
  heading_deg: nullable(bearing),
};
const reportRequired = ['client_event_id', 'data_mode', 'position', 'observed_at', 'source'];
const resultCommon = {
  client_event_id: uuid, data_mode: mode, accepted: { type: 'boolean', enum: [true] },
  eligibility, reason_codes: array(enumeration('STALE_OBSERVATION', 'LOW_LOCATION_ACCURACY', 'MISSING_ACCURACY',
    'NEEDS_REVIEW', 'HAZARD_CLOSED', 'TOO_FAR'), 6),
  observed_at_raw: timestamp, observed_at: timestamp, received_at: timestamp,
};

export const schemas: Record<string, SchemaObject> = {
  Position: position,
  Error: object({ error: object({ code: text(80), message: text(500), requestId: uuid }) }),
  Contributor: object({ contributor_id: uuid, role: enumeration('rider', 'maintainer'), disabled: bool }),
  ManualReportRequest: {
    ...object({ ...reportProperties, source: enumeration('manual'), classification_method: enumeration('chosen', 'timeout') },
      [...reportRequired, 'classification_method']),
    description: 'Quick Flag: timeout phải đi cùng hazard_type=unknown (hoặc bỏ qua để dùng unknown). Không nhận trường server hay subtype khác.',
  },
  SensorReportRequest: {
    ...object({ ...reportProperties, source: enumeration('sensor_confirmed'), confirmed_at: timestamp,
      peak_accel_g: nullable(number(0)), speed_kmh: nullable(number(0)) }, [...reportRequired, 'confirmed_at']),
    description: 'Chỉ gửi sau xác nhận; confirmed_at >= observed_at. Không gửi raw sensor stream/candidate.',
  },
  ReportRequest: { oneOf: [ref('ManualReportRequest'), ref('SensorReportRequest')],
    discriminator: { propertyName: 'source', mapping: { manual: '#/components/schemas/ManualReportRequest', sensor_confirmed: '#/components/schemas/SensorReportRequest' } } },
  ReportReceipt: object({ ...resultCommon, report_id: uuid, source: enumeration('manual', 'sensor_confirmed'),
    hazard_id: nullable(uuid), eligible_for_alert: bool }),
  Report: object({ receipt: ref('ReportReceipt'), observation: ref('ReportRequest'), photos: array(ref('ReportPhoto'), 20) }),
  ReportPhoto: object({ photo_no: integer(1), mime_type: enumeration('image/jpeg', 'image/png', 'image/webp'),
    captured_at: nullable(timestamp), uploaded_at: timestamp, caption: nullable(text(1000)),
    moderation_status: enumeration('pending', 'approved', 'rejected'),
    url: nullable({ type: 'string', format: 'uri-reference' }), url_expires_at: nullable(timestamp) }),
  PublicReportPhoto: object({ report_id: uuid, photo_no: integer(1), mime_type: enumeration('image/jpeg', 'image/png', 'image/webp'),
    captured_at: nullable(timestamp), uploaded_at: timestamp, caption: nullable(text(1000)),
    moderation_status: enumeration('approved'), url: { type: 'string', format: 'uri-reference' }, url_expires_at: timestamp }),
  VerificationRequest: object({ ...observation, result: enumeration('still_present', 'cleared') },
    ['client_event_id', 'data_mode', 'position', 'observed_at', 'result']),
  VerificationReceipt: object({ ...resultCommon, verification_id: uuid, hazard_id: uuid,
    result: enumeration('still_present', 'cleared'), eligible_for_score: bool, effective_at_receipt: bool }),
  Hazard: object({
    hazard_id: uuid, previous_hazard_id: nullable(uuid), data_mode: mode, hazard_type: hazardType, severity,
    location: ref('Position'), road_ref: nullable(text(200)), direction_bearing: nullable(bearing),
    status: enumeration('pending', 'active', 'resolved', 'expired', 'rejected'), is_disputed: bool,
    last_observed_at: timestamp, expires_at: timestamp, updated_at: timestamp,
    confidence_score: nullable(number(0, 100)), score_version: nullable(text(80)), computed_at: nullable(timestamp),
    alert_eligible: bool, warning_label: nullable(enumeration('unverified')),
    photos: array(ref('PublicReportPhoto'), 20),
  }),
  HazardListQuery: object({ data_mode: mode, min_longitude: number(-180, 180), min_latitude: number(-90, 90),
    max_longitude: number(-180, 180), max_latitude: number(-90, 90), limit: { ...integer(1, limits.max_page_size), default: 100 },
    longitude: number(-180,180), latitude: number(-90,90), radius_m: number(1,50000), cursor: text(1024) }, ['data_mode', 'min_longitude', 'min_latitude', 'max_longitude', 'max_latitude']),
  ModeQuery: object({ data_mode: mode }),
  HazardList: object({ data_mode: mode, generated_at: timestamp, hazards: array(ref('Hazard'), limits.max_page_size), next_cursor: nullable(text(1024)) }),
  LandmarkImage: object({
    image_id: uuid, image_source: enumeration('mapillary', 'team_seed'), display_order: integer(1),
    url: { type: 'string', format: 'uri-reference' }, url_expires_at: timestamp,
    attribution: text(500), captured_at: nullable(timestamp), compass_angle: nullable(bearing),
    offline_allowed: bool, offline_expires_at: nullable(timestamp),
  }),
  TurnCue: object({ cue_id: uuid, landmark_id: uuid, data_mode: mode, landmark_name_vi: text(200),
    turn_location: ref('Position'), approach_bearing: bearing, exit_bearing: bearing,
    bearing_tolerance_deg: { type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 180 },
    instruction_vi: text(500), images: array(ref('LandmarkImage'), 10) }),
  Landmark: object({ landmark_id: uuid, data_mode: mode, name_vi: text(200), description_vi: nullable(text(1000)),
    location: ref('Position'), reviewed_at: nullable(timestamp), turn_cues: array(ref('TurnCue'), limits.max_snapshot_cues) }),
  Maneuver: object({ maneuver_id: text(100), location: ref('Position'),
    approach_bearing: nullable(bearing), exit_bearing: nullable(bearing) }, ['maneuver_id', 'location']),
  RouteGeometry: { ...object({ type: enumeration('LineString'), coordinates: {
    type: 'array', minItems: 2, maxItems: limits.max_route_points,
    items: { type: 'array', minItems: 2, maxItems: 2, items: number(-180, 180) },
    description: '[longitude,latitude], WGS84. Latitude phải trong [-90,90]; kiểm tra ngữ nghĩa ở service vì OAS 3.0 không mô tả tuple riêng từng phần tử.',
  } }), description: 'Không nhận altitude. Tổng chiều dài <= 50 km; không lưu thành lịch sử hành trình.' },
  RouteSnapshotRequest: object({ data_mode: mode, route_revision: text(100), geometry: ref('RouteGeometry'),
    maneuvers: array(ref('Maneuver'), limits.max_maneuvers), offline: { ...bool, default: false } },
  ['data_mode', 'route_revision', 'geometry', 'maneuvers']),
  MatchedCue: object({ maneuver_id: text(100), cue: ref('TurnCue') }),
  CueFallback: object({ maneuver_id: text(100), reason: enumeration('NO_ELIGIBLE_CUE', 'MISSING_BEARING') }),
  RouteSnapshot: object({ snapshot_id: uuid, data_mode: mode, route_revision: text(100), policy_version: text(80),
    generated_at: timestamp, expires_at: timestamp, complete: { type: 'boolean', enum: [true] },
    hazards: array(ref('Hazard'), limits.max_snapshot_hazards), turn_cues: array(ref('MatchedCue'), limits.max_snapshot_cues),
    cue_fallbacks: array(ref('CueFallback'), limits.max_maneuvers),
    warnings: array(enumeration('LANDMARK_IMAGES_UNAVAILABLE', 'NO_OFFLINE_IMAGE'), 2) }),
  ClientConfig: object({ api_version: text(20), policy_version: text(80), confidence_policy_status: enumeration('draft'),
    limits: object(Object.fromEntries(Object.keys(limits).map((key) => [key, integer(1)]))),
    experimental: object({ max_accuracy_m: number(0), future_clock_skew_seconds: integer(), route_corridor_m: number(0),
      quick_flag_timeout_seconds: integer(1), verification_timeout_seconds: integer(1) }) }),
};

export const policy = {
  api_version: 'v1', policy_version: 'be04-draft-1', confidence_policy_status: 'draft', limits,
  experimental: { max_accuracy_m: 30, future_clock_skew_seconds: 300, route_corridor_m: 50,
    quick_flag_timeout_seconds: 4, verification_timeout_seconds: 5 },
};
