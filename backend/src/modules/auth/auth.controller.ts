import type { RequestHandler } from 'express';
import { authenticatedContributor } from './auth.middleware.js';

export const getMe: RequestHandler = (_request, response) => {
  const { contributor_id, role, disabled } = authenticatedContributor(response);
  response.json({ contributor_id, role, disabled });
};
