import type { RequestHandler } from 'express';
import type { HealthService } from './health.service.js';

export function createHealthController(service: HealthService) {
  const live: RequestHandler = (_request, response) => {
    response.set('Cache-Control', 'no-store').json(service.live());
  };
  const ready: RequestHandler = async (_request, response) => {
    const result = await service.ready();
    response.set('Cache-Control', 'no-store').status(result.status === 'ready' ? 200 : 503).json(result);
  };
  return { live, ready };
}
