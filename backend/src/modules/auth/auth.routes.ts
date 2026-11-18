import { Router } from 'express';
import { getMe } from './auth.controller.js';
import { requireAuth } from './auth.middleware.js';
import type { AuthDependencies } from './auth.types.js';

export function authRoutes(dependencies: AuthDependencies) {
  const router = Router();
  router.get('/me', requireAuth(dependencies), getMe);
  return router;
}
