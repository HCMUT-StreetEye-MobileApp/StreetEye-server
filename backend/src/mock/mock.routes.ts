import { Router } from 'express';
import { businessPaths } from '../contracts/openapi.js';
import { mockControllers, mockGate } from './mock.controller.js';
import type { MockService } from './mock.service.js';

export function mockRoutes(service: MockService) {
  const router = Router();
  const controllers = mockControllers(service);
  for (const [path, methods] of Object.entries(businessPaths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const controller = controllers[operation.operationId];
      if (!controller || !['get', 'post'].includes(method)) throw new Error('Mock route missing controller.');
      router[method as 'get' | 'post'](path.replace(/\{(\w+)\}/g, ':$1'), mockGate(operation), controller);
    }
  }
  return router;
}
