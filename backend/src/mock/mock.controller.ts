import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { createValidator } from '../contracts/validation.js';
import { ids } from '../contracts/fixtures.js';
import type { ApiOperation } from '../contracts/openapi.js';
import type { MockService, ReportInput, VerificationInput, RouteInput, HazardQuery } from './mock.service.js';

const bodyValidator = createValidator();
const queryValidator = createValidator(true);
function parse<T>(name: string, value: unknown, query = false): T {
  const validate = (query ? queryValidator : bodyValidator)(name);
  if (!validate(value)) {
    const errors = validate.errors ?? [];
    const timestamp = errors.some((e) => /observed_at|confirmed_at/.test(e.instancePath));
    const coordinate = errors.some((e) => /position|coordinates|latitude|longitude/.test(e.instancePath));
    const tooLarge = name === 'RouteSnapshotRequest' && errors.some((e) => e.keyword === 'maxItems');
    throw new AppError(tooLarge ? 413 : 422, tooLarge ? 'ROUTE_TOO_LARGE' : timestamp ? 'INVALID_TIMESTAMP' : coordinate ? 'INVALID_COORDINATES' : 'INVALID_REQUEST',
      'Request does not match the API contract. Check required fields, types, ranges and subtype fields.');
  }
  return value as T;
}
function id(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== 'string' || !z.uuid().safeParse(value).success) throw new AppError(422, 'INVALID_REQUEST', 'Path ID must be a UUID.');
  return value.toLowerCase();
}
const scenario = (response: Response) => String(response.locals.mockScenario);
const actor = (response: Response) => String(response.locals.mockActor);
const mode = (request: Request) => parse<{ data_mode: string }>('ModeQuery', { ...request.query }, true).data_mode;
function receipt(response: Response, result: { status: number; body: unknown }) {
  response.set('Idempotency-Replayed', String(result.status === 200)).status(result.status).json(result.body);
}

export function mockGate(operation: ApiOperation): RequestHandler {
  return (request, response, next) => {
    if (operation.security.length) {
      const token = request.get('Authorization');
      const mapped = token === 'Bearer mock-rider-a' ? ids.riderA : token === 'Bearer mock-rider-b' ? ids.riderB : undefined;
      if (!mapped) {
        response.set('WWW-Authenticate', 'Bearer');
        throw new AppError(401, 'UNAUTHENTICATED', 'Mock requires Bearer mock-rider-a or mock-rider-b; do not send real tokens.');
      }
      response.locals.mockActor = mapped;
    }
    const selected = request.get('X-Mock-Scenario') ?? 'default';
    if (!operation['x-mock-scenarios'].includes(selected)) throw new AppError(422, 'INVALID_REQUEST', 'Unknown mock scenario for this operation.');
    if (selected === 'rate_limited' || selected === 'unavailable') {
      response.set('Retry-After', selected === 'rate_limited' ? '30' : '5');
      throw new AppError(selected === 'rate_limited' ? 429 : 503, selected === 'rate_limited' ? 'RATE_LIMITED' : 'SERVICE_UNAVAILABLE', 'Scripted mock failure.');
    }
    response.locals.mockScenario = selected;
    if (operation.requestBody && !request.is('application/json')) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
    next();
  };
}

export function mockControllers(service: MockService): Record<string, RequestHandler> {
  return {
    getClientConfig: (_request, response) => { response.json(service.config()); },
    getCurrentContributor: (_request, response) => { response.json(service.me(actor(response))); },
    createReport: (request, response) => {
      const body: unknown = request.body;
      if (body && typeof body === 'object' && ('source' in body && body.source === 'seed'
        || ['contributor_id', 'auth_user_id', 'role', 'hazard_id', 'status', 'confidence_score', 'payload_hash', 'eligibility', 'received_at', 'score'].some((key) => key in body))) {
        throw new AppError(403, 'FORBIDDEN', 'Seed and server-owned fields cannot be supplied through this endpoint.');
      }
      receipt(response, service.report(parse<ReportInput>('ReportRequest', body), actor(response), scenario(response)));
    },
    getOwnReport: (request, response) => { response.json(service.ownReport(id(request, 'report_id'), actor(response))); },
    listHazards: (request, response) => { response.json(service.listHazards(parse<HazardQuery>('HazardListQuery', { ...request.query }, true))); },
    getHazard: (request, response) => { response.json(service.getHazard(id(request, 'hazard_id'), mode(request))); },
    createVerification: (request, response) => {
      receipt(response, service.verification(parse<VerificationInput>('VerificationRequest', request.body), id(request, 'hazard_id'), actor(response), scenario(response)));
    },
    getLandmark: (request, response) => { response.json(service.getLandmark(id(request, 'landmark_id'), mode(request), scenario(response))); },
    createRouteSnapshot: (request, response) => { response.json(service.snapshot(parse<RouteInput>('RouteSnapshotRequest', request.body), scenario(response))); },
  };
}
