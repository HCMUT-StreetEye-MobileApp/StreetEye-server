import { Router } from 'express';
import { createHealthController } from './health.controller.js';
import { createHealthService, type DatabaseCheck } from './health.service.js';

export function healthRoutes(checkDatabase: DatabaseCheck) {
  const router = Router();
  const controller = createHealthController(createHealthService(checkDatabase));
  router.get('/', controller.live);
  router.get('/ready', controller.ready);
  return router;
}
