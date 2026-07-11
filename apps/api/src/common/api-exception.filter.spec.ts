import type { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ApiExceptionFilter } from './api-exception.filter';

function invoke(exception: unknown) {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const request = { requestId: 'request-1', method: 'POST', originalUrl: '/v1/device/activate' };
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ status, json }) }),
  } as unknown as ArgumentsHost;

  new ApiExceptionFilter().catch(exception, host);
  return { status, json };
}

describe('ApiExceptionFilter Prisma conflicts', () => {
  it('maps a hardware serial uniqueness conflict to an actionable 409', () => {
    const exception = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '6.19.3',
      meta: { target: ['hardwareSerial'] },
    });

    const response = invoke(exception);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'hardware_already_enrolled',
      request_id: 'request-1',
    }));
  });

  it('maps a foreign-key conflict without exposing database internals', () => {
    const exception = new Prisma.PrismaClientKnownRequestError('Foreign key details', {
      code: 'P2003',
      clientVersion: '6.19.3',
    });

    const response = invoke(exception);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'record_in_use' }));
  });
});
