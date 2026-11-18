import { randomUUID } from 'node:crypto';
import express from 'express';
import { contributionRoutes } from './modules/contributions/routes.js';
import type { Pool } from 'pg';
import { catalogRoutes } from './modules/catalog/catalog.routes.js';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import type { AppConfig } from './config/env.js';
import type { DatabaseCheck } from './modules/health/health.service.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { errorHandler, notFound } from './http/errors.js';
import { logger, type Logger } from './shared/logger.js';
import openapi from './docs/openapi.json' with { type: 'json' };
import { authRoutes } from './modules/auth/auth.routes.js';
import { createTokenVerifier } from './modules/auth/auth.verifier.js';
import { createContributorRepository } from './modules/auth/auth.repository.js';
import type { AuthDependencies } from './modules/auth/auth.types.js';

export function createApp(config: AppConfig, checkDatabase: DatabaseCheck, log: Logger = logger,
  auth: AuthDependencies = { verifyToken: createTokenVerifier(config), resolveContributor: createContributorRepository(undefined) }, pool?: Pool) {
  const app = express();
  app.disable('x-powered-by');
  // Disable forced HTTPS upgrades only for local HTTP development.
  app.use(helmet({
    contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': config.NODE_ENV === 'production' ? [] : null } },
    strictTransportSecurity: config.NODE_ENV === 'production',
  }));
  app.use((_request, response, next) => {
    response.locals.requestId = randomUUID();
    response.set('X-Request-Id', response.locals.requestId);
    next();
  });
  app.use(cors({
    origin: config.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    exposedHeaders: ['X-Request-Id','Idempotency-Replayed','Retry-After'],
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/health', healthRoutes(checkDatabase));
  app.use('/api/v1', authRoutes(auth));
  app.use('/api/v1', contributionRoutes(auth,pool,config.DATA_MODE));
  app.use('/api/v1', catalogRoutes(pool,config.DATA_MODE));
  app.get('/openapi.json', (_request, response) => { response.json(openapi); });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi, {
    customSiteTitle: 'StreetEye API — BE-05 Auth + BE-04 business contract',
    swaggerOptions: { validatorUrl: null, supportedSubmitMethods: ['get','post'] },
  }));
  app.use(notFound);
  app.use(errorHandler(log));
  return app;
}
