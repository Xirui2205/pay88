import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

export interface RequestWithContext extends Request {
  requestId: string;
  rawBody?: Buffer;
}

export function requestContextMiddleware(
  request: RequestWithContext,
  response: Response,
  next: NextFunction,
): void {
  const candidate = request.header('x-request-id');
  request.requestId = candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : randomUUID();
  response.setHeader('x-request-id', request.requestId);
  next();
}

