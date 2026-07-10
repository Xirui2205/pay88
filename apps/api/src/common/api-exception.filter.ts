import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { ApiException } from './api-exception';
import type { RequestWithContext } from './request-context';

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithContext>();
    const response = context.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'internal_error';
    let message = 'An internal error occurred';
    let details: unknown;

    if (exception instanceof ApiException) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      code = 'validation_error';
      message = 'The request payload is invalid';
      details = exception.flatten();
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = status === 404 ? 'not_found' : status === 401 ? 'unauthorized' : 'http_error';
      message = exception.message;
      details = exception.getResponse();
    } else if (process.env.NODE_ENV === 'test' && exception instanceof Error) {
      details = { debug: exception.message };
    }

    response.status(status).json(
      jsonSafe({
        status: 'error',
        message,
        code,
        data: details ?? null,
        request_id: request.requestId ?? 'unknown',
      }),
    );
  }
}
