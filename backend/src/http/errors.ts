import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from '../shared/logger.js';

export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export const notFound: RequestHandler = (_request, _response, next) => {
  next(new AppError(404, 'NOT_FOUND', 'Endpoint not found.'));
};

export function errorHandler(log: Logger): ErrorRequestHandler {
  return (error: unknown, _request, response, next) => {
    if (response.headersSent) { next(error); return; }
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred.';
    const bodyError = error as { type?: unknown } | null;
    if (error instanceof AppError) {
      ({ status, code, message } = error);
    } else if (bodyError?.type === 'entity.parse.failed') {
      status = 400; code = 'INVALID_JSON'; message = 'Request body must be valid JSON.';
    } else if (bodyError?.type === 'entity.too.large') {
      status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'JSON body exceeds the 1 MB limit.';
    } else if (bodyError?.type === 'charset.unsupported' || bodyError?.type === 'encoding.unsupported') {
      status = 415; code = 'UNSUPPORTED_ENCODING'; message = 'Unsupported request body encoding.';
    }
    if (status >= 500) log('http.unexpected_error', { requestId: response.locals.requestId });
    if (status === 429) response.set('Retry-After','60');
    if (status === 401 && !response.hasHeader('WWW-Authenticate')) response.set('WWW-Authenticate', 'Bearer realm="StreetEye"');
    response.status(status).json({ error: { code, message, requestId: response.locals.requestId } });
  };
}
