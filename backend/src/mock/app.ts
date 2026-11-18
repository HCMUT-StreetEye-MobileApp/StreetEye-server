import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApi } from '../contracts/openapi.js';
import { errorHandler, notFound } from '../http/errors.js';
import { healthRoutes } from '../modules/health/health.routes.js';
import { createMockService } from './mock.service.js';
import { mockRoutes } from './mock.routes.js';

export function createMockApp(clock: () => Date = () => new Date()) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': null } }, strictTransportSecurity: false }));
  app.use((_request, response, next) => {
    response.locals.requestId = randomUUID();
    response.set({ 'X-Request-Id': response.locals.requestId, 'X-StreetEye-Mock': 'true', 'Cache-Control': 'no-store' });
    next();
  });
  app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    exposedHeaders: ['X-Request-Id', 'Idempotency-Replayed', 'Retry-After', 'X-StreetEye-Mock'] }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/health', healthRoutes(async () => 'not_configured'));
  const contract = buildOpenApi();
  app.get('/openapi.json', (_request, response) => { response.json(contract); });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(contract, { customSiteTitle: 'StreetEye BE-04 — LOCAL MOCK',
    swaggerOptions: { validatorUrl: null, supportedSubmitMethods: ['get', 'post'] } }));
  app.get('/mock-assets/landmark.svg', (_request, response) => {
    response.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#e8eef5"/><path d="M0 260H640M320 360V80" stroke="#94a3b8" stroke-width="60"/><rect x="370" y="90" width="180" height="110" fill="#2563eb"/><text x="28" y="45" font-size="26" font-family="sans-serif" fill="#0f172a">STREETEYE DEMO — NOT A REAL PLACE</text><text x="400" y="155" font-size="26" font-family="sans-serif" fill="white">DEMO A</text></svg>');
  });
  app.use(mockRoutes(createMockService(clock)));
  app.use(notFound);
  app.use(errorHandler(() => {}));
  return app;
}
