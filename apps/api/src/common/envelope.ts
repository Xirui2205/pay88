import type { RequestWithContext } from './request-context';

export function success<T>(request: RequestWithContext, data: T, message = 'Success') {
  return {
    status: 'success' as const,
    message,
    code: 'ok' as const,
    data,
    request_id: request.requestId,
  };
}

