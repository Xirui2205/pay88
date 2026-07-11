import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithContext>();
    const response = context.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'internal_error';
    let message = 'An internal error occurred';
    let details: unknown;
    let shouldLog = false;

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
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2002') {
      status = HttpStatus.CONFLICT;
      const target = Array.isArray(exception.meta?.target)
        ? exception.meta.target.map(String)
        : [String(exception.meta?.target ?? '')];
      const hardwareConflict = target.some((field) => field.includes('hardwareSerial'));
      code = hardwareConflict ? 'hardware_already_enrolled' : 'unique_record_conflict';
      message = hardwareConflict
        ? 'This handset is already attached to another phone record; delete the failed enrollment or recover the existing phone before retrying'
        : 'A record with the same unique identity already exists';
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2003') {
      status = HttpStatus.CONFLICT;
      code = 'record_in_use';
      message = 'This record is still referenced by operational history and cannot be removed';
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2025') {
      status = HttpStatus.NOT_FOUND;
      code = 'not_found';
      message = 'The requested record was not found';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = status === 404 ? 'not_found' : status === 401 ? 'unauthorized' : 'http_error';
      message = exception.message;
      details = exception.getResponse();
    } else if (process.env.NODE_ENV === 'test' && exception instanceof Error) {
      details = { debug: exception.message };
      shouldLog = true;
    } else {
      shouldLog = true;
    }

    if (shouldLog) {
      const error = exception instanceof Error ? exception : new Error('Non-Error exception');
      this.logger.error(
        `Unhandled request exception request_id=${request.requestId ?? 'unknown'} method=${request.method ?? 'unknown'} path=${request.originalUrl ?? request.url ?? 'unknown'} name=${error.name} message=${error.message}`,
        error.stack,
      );
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
