import { photoPaths } from './photos.js';
import foundation from '../docs/health.openapi.json' with { type: 'json' };
import { examples, catalog, ids } from './fixtures.js';
import { schemas, policy, ref } from './schemas.js';

type ExampleMap = Record<string, { value: unknown; summary?: string }>;
export interface ApiResponse {
  description: string;
  headers: Record<string, unknown>;
  content: { 'application/json': { schema: object; examples: ExampleMap } };
}
export interface ApiOperation {
  tags: string[]; operationId: string; summary: string; description: string;
  security: object[]; parameters: object[]; responses: Record<string, ApiResponse>;
  requestBody?: object;
  'x-implementation': string;
  'x-mock-scenarios': string[];
}
const headers = {
  'X-Request-Id': { $ref: '#/components/headers/RequestId' },
  'Cache-Control': { schema: { type: 'string', enum: ['no-store'] }, description: 'Client quản lý cache snapshot theo expires_at; HTTP response không cache tự động.' },
};
function response(description: string, schema: string, values: Record<string, unknown>, extra: object = {}): ApiResponse {
  return { description, headers: { ...headers, ...extra }, content: { 'application/json': {
    schema: ref(schema), examples: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value }])) } } };
}
const errorCodes: Record<string, string[]> = {
  '400': ['INVALID_JSON', 'INVALID_REQUEST'], '401': ['UNAUTHENTICATED'], '403': ['FORBIDDEN'], '404': ['NOT_FOUND'],
  '409': ['IDEMPOTENCY_CONFLICT'], '413': ['PAYLOAD_TOO_LARGE', 'ROUTE_TOO_LARGE', 'SNAPSHOT_TOO_LARGE'],
  '415': ['UNSUPPORTED_MEDIA_TYPE', 'UNSUPPORTED_ENCODING'],
  '422': ['INVALID_REQUEST', 'INVALID_COORDINATES', 'INVALID_TIMESTAMP', 'OUTSIDE_PILOT'],
  '429': ['RATE_LIMITED'], '500': ['INTERNAL_ERROR'], '503': ['SERVICE_UNAVAILABLE'],
};
function errors(statuses: string[]) {
  return Object.fromEntries(statuses.map((status) => [status, response(`Lỗi HTTP ${status}; xem mã ổn định trong body.`, 'Error',
    Object.fromEntries(errorCodes[status]!.map((code) => [code, { error: { code, message: `Ví dụ: ${code}`, requestId: ids.request } }])),
    status === '429' || status === '503' ? { 'Retry-After': { schema: { type: 'integer', minimum: 1 }, description: 'Số giây chờ trước khi retry.' } }
      : status === '401' ? { 'WWW-Authenticate': { schema: { type: 'string' }, example: 'Bearer' } } : {})]));
}
const query = (name: string) => Object.entries(schemas[name]!.properties as Record<string, object>).map(([key, schema]) =>
  ({ name: key, in: 'query', required: (schemas[name]!.required as string[]).includes(key), schema }));
const idParam = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
const retryHeaders = {
  'Idempotency-Replayed': { schema: { type: 'boolean' }, description: 'false ở 201, true ở 200. Body receipt giữ nguyên lần đầu; header X-Request-Id luôn mới.' },
};
const sharedErrors = ['400', '403', '422', '429', '500', '503'];
function operation(id: string, tag: string, summary: string, description: string, responses: Record<string, ApiResponse>, options: {
  auth?: boolean; body?: string; examples?: Record<string, unknown>; parameters?: object[]; scenarios?: string[]; errors?: string[];
} = {}): ApiOperation {
  const scenarios = ['default', ...(options.scenarios ?? []), 'rate_limited', 'unavailable'];
  return { operationId: id, tags: [tag], summary, description, security: options.auth ? [{ bearerAuth: [] }] : [],
    'x-implementation': 'implemented', 'x-mock-scenarios': scenarios,
    parameters: [...(options.parameters ?? []), { name: 'X-Mock-Scenario', in: 'header', required: false,
      description: 'CHỈ mock port 3001; không phải tham số nghiệp vụ. Production bỏ qua header này.', schema: { type: 'string', enum: scenarios } }],
    ...(options.body ? { requestBody: { required: true, content: { 'application/json': { schema: ref(options.body),
      examples: Object.fromEntries(Object.entries(options.examples ?? {}).map(([name, value]) => [name, { value }])) } } } } : {}),
    responses: { ...responses, ...errors([...new Set([...sharedErrors, ...(options.auth ? ['401', '403'] : []), ...(options.errors ?? [])])]) },
  };
}
const sample = catalog();
const reportIneligible = { ...examples.reportReceipt, eligibility: 'ineligible', reason_codes: ['STALE_OBSERVATION'], hazard_id: null, eligible_for_alert: false };
const reportReview = { ...examples.reportReceipt, eligibility: 'needs_review', reason_codes: ['MISSING_ACCURACY'], hazard_id: null, eligible_for_alert: false };
const closedVerification = { ...examples.verificationReceipt, hazard_id: ids.resolved,
  eligibility: 'ineligible', reason_codes: ['HAZARD_CLOSED'], eligible_for_score: false, effective_at_receipt: false };

export const businessPaths: Record<string, Record<string, ApiOperation>> = {
  '/api/v1/config': { get: operation('getClientConfig', 'Config', 'Giới hạn giao thức và phiên bản policy',
    'Các giá trị experimental là cơ sở BE-01, chưa phải ngưỡng đã nghiệm thu thực địa. Không công bố công thức confidence giả.',
    { '200': response('Cấu hình client', 'ClientConfig', { default: policy }) }) },
  '/api/v1/me': { get: operation('getCurrentContributor', 'Identity', 'Thông tin contributor của phiên hiện tại',
    'BE-05 đã triển khai trên backend thật. Mobile lấy/refresh access token qua Supabase Auth. Backend xác minh ES256/RS256, issuer, audience, expiry và session_id, kiểm tra session/user trong DB rồi provisioning contributor idempotent. Role/disabled lấy từ DB, không tin metadata client. Contributor disabled vẫn được đọc /me nhưng không được ghi. Mock chỉ nhận mock-rider-a hoặc mock-rider-b.',
    { '200': response('Thông tin tối thiểu; không trả auth_user_id/token', 'Contributor', { rider: { contributor_id: ids.riderA, role: 'rider', disabled: false } }) }, { auth: true }) },
  '/api/v1/reports': { post: operation('createReport', 'Reports', 'Gửi Quick Flag hoặc sensor report đã xác nhận',
    '201 lưu lần đầu; 200 retry cùng contributor/client_event_id và payload chuẩn hóa; 409 cùng key khác payload. Actor lấy từ token. source=seed và trường server (score/status/actor/hazard_id/hash) bị từ chối. Không tự gộp chỉ vì gần tọa độ. accepted không đồng nghĩa eligible_for_alert. Không nhận ảnh trong request này.',
    { '201': response('Đã lưu một report; có thể chưa đủ điều kiện cảnh báo', 'ReportReceipt', { accepted: examples.reportReceipt, stale: reportIneligible, missingAccuracy: reportReview }, retryHeaders),
      '200': response('Retry: receipt của lần đầu, không thêm report hay điểm', 'ReportReceipt', { replay: examples.reportReceipt }, retryHeaders) },
    { auth: true, body: 'ReportRequest', examples: { quickFlag: examples.manual, sensorConfirmed: examples.sensor }, errors: ['409', '413', '415'],
      scenarios: ['stale', 'low_accuracy', 'needs_review', 'outside_pilot'] }) },
  '/api/v1/reports/{report_id}': { get: operation('getOwnReport', 'Reports', 'Đọc report của chính contributor',
    'Trả 404 cả khi không tồn tại lẫn thuộc người khác. observation giữ payload quan sát, receipt là ACK ban đầu; không trả payload_hash, storage_key hay actor ID của người khác. Ảnh pending/rejected chỉ chủ sở hữu thấy metadata, url=null.',
    { '200': response('Report của chủ sở hữu', 'Report', { default: { receipt: examples.reportReceipt, observation: examples.manual, photos: [] } }) },
    { auth: true, parameters: [idParam('report_id')], errors: ['404'] }) },
  '/api/v1/hazards': { get: operation('listHazards', 'Hazards', 'Hazard đang mở trong viewport',
    'data_mode và bbox bắt buộc; min < max, không vượt kinh tuyến 180 ở v1. Chỉ pending/active còn hạn; thứ tự hazard_id tăng dần. Cursor opaque gắn với bbox/mode/limit, không đổi filter giữa trang. Danh sách này phục vụ preview; offline dùng route-snapshots nguyên khối.',
    { '200': response('Một trang preview', 'HazardList', { default: { data_mode: 'demo', generated_at: examples.reportReceipt.received_at,
      hazards: sample.hazards.filter((h) => h.alert_eligible), next_cursor: null } }) },
    { parameters: query('HazardListQuery') }) },
  '/api/v1/hazards/{hazard_id}': { get: operation('getHazard', 'Hazards', 'Chi tiết hazard và trạng thái hiện tại',
    'data_mode bắt buộc. resolved/expired vẫn có thể đọc để giải thích marker cũ, alert_eligible=false; rejected trả 404. Điểm 0–100 không phải xác suất. direction_bearing=null là chưa biết, không phải mọi chiều. Chỉ ảnh approved xuất hiện công khai.',
    { '200': response('Chi tiết công khai; không lộ contributor/GPS report gốc', 'Hazard',
      Object.fromEntries(sample.hazards.filter((h) => h.status !== 'rejected').map((h) => [h.is_disputed ? 'disputed' : h.status, h]))) },
    { parameters: [idParam('hazard_id'), ...query('ModeQuery')], errors: ['404'] }) },
  '/api/v1/hazards/{hazard_id}/verifications': { post: operation('createVerification', 'Verifications', 'Ghi nhận vẫn còn / đã hết',
    'Scope idempotency là contributor + loại verification + client_event_id, xuyên các hazard: retry sang hazard khác cũng conflict. Giữ lịch sử; latest eligible theo observed_at, received_at, ID. effective_at_receipt chỉ mô tả lúc nhận. Một cleared không tự resolve. Hazard đã đóng vẫn nhận quan sát với HAZARD_CLOSED; rejected/khác mode trả 404.',
    { '201': response('Sự kiện được lưu; eligibility do server quyết định', 'VerificationReceipt', { accepted: examples.verificationReceipt, closed: closedVerification }, retryHeaders),
      '200': response('Receipt cũ khi retry', 'VerificationReceipt', { replay: examples.verificationReceipt }, retryHeaders) },
    { auth: true, body: 'VerificationRequest', examples: { cleared: examples.verification }, parameters: [idParam('hazard_id')],
      errors: ['404', '409', '413', '415'], scenarios: ['stale', 'low_accuracy', 'needs_review', 'too_far', 'outside_pilot'] }) },
  '/api/v1/landmarks/{landmark_id}': { get: operation('getLandmark', 'Landmarks', 'Mốc và cue đã biên tập',
    'Chỉ landmark/cue active, đủ heading/tolerance. Ảnh chọn riêng từng cue, chỉ approved, theo display_order; mảng rỗng hợp lệ. URL có thể hết hạn; không lưu signed URL làm định danh. Không trả storage_key/provider token. Attribution phải hiển thị; offline_allowed=false cấm tải vào cache offline.',
    { '200': response('Landmark cùng cue/ảnh hợp lệ', 'Landmark', { default: sample.landmark }) },
    { parameters: [idParam('landmark_id'), ...query('ModeQuery')], errors: ['404'], scenarios: ['no_images', 'mapillary_down'] }) },
  '/api/v1/route-snapshots': { post: operation('createRouteSnapshot', 'Routes', 'Tạo snapshot đầy đủ cho một revision tuyến',
    'Truy vấn không persist lịch sử tuyến; không phải routing engine. 200 luôn complete=true, không phân trang/cắt bớt; quá giới hạn trả 413. Echo đúng route_revision. Client chỉ thay cache khi nhận trọn gói và revision vẫn khớp. Hạn hiệu lực=min(snapshot.expires_at,hazard.expires_at). Maneuver thiếu heading không tự ghép cue. offline=true chỉ trả ảnh có quyền offline còn hạn. Thiếu ảnh/Mapillary lỗi dùng cue chữ hoặc routing fallback; không làm hỏng hazards.',
    { '200': response('Snapshot nguyên khối; không có hazard resolved/expired/rejected', 'RouteSnapshot', { default: examples.snapshot,
      noImages: { ...examples.snapshot, turn_cues: [{ maneuver_id: 'turn-1', cue: { ...sample.cue, images: [] } }], warnings: ['LANDMARK_IMAGES_UNAVAILABLE'] },
      noCue: { ...examples.snapshot, turn_cues: [], cue_fallbacks: [{ maneuver_id: 'turn-1', reason: 'NO_ELIGIBLE_CUE' }] } }) },
    { body: 'RouteSnapshotRequest', examples: { demoRoute: examples.route }, errors: ['403', '413', '415'],
      scenarios: ['no_images', 'mapillary_down', 'no_cue', 'snapshot_too_large'] }) },
};

export function buildOpenApi() {
  return { ...foundation, info: { title: 'StreetEye API — BE-05 Auth + BE-04 contract', version: '0.3.0',
    description: 'Production serves health, identity, config, hazards, landmarks and route snapshots. Authenticated contributions, private photos and confidence scoring are implemented.' },
  servers: [{ url: '/', description: 'See operation x-implementation.' }],
  tags: [...foundation.tags, ...['Config', 'Identity', 'Reports', 'Hazards', 'Verifications', 'Landmarks', 'Routes'].map((name) => ({ name }))],
  paths: { ...foundation.paths, ...businessPaths, ...photoPaths },
  components: { ...foundation.components, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
    description: 'Production: Supabase user access token (kể cả anonymous user), không phải anon/publishable key. Mock: mock-rider-a hoặc mock-rider-b.' } },
    schemas: { ...foundation.components.schemas, ...schemas } },
  };
}
