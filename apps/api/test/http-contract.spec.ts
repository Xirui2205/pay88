import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma.service';
import { requestContextMiddleware } from '../src/common/request-context';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { DepositsController } from '../src/deposits/deposits.controller';
import { DepositsService } from '../src/deposits/deposits.service';
import { WithdrawalsController } from '../src/withdrawals/withdrawals.controller';
import { WithdrawalsService } from '../src/withdrawals/withdrawals.service';
import { MerchantAuthGuard } from '../src/auth/merchant-auth.guard';

describe('HTTP contract', () => {
  let app: INestApplication;

  beforeEach(async () => {
    process.env.CHECKOUT_TOKEN_SECRET = 'test-secret-that-is-more-than-thirty-two-characters';
    process.env.DEVICE_JOB_SIGNING_SECRET = 'test-device-secret-more-than-thirty-two-characters';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ $queryRaw: async () => [{ '?column?': 1 }] })
      .compile();
    app = module.createNestApplication();
    app.use(requestContextMiddleware);
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterEach(async () => app.close());

  it('exposes liveness with the standard envelope and request ID', async () => {
    const response = await request(app.getHttpServer()).get('/health/live').set('x-request-id', 'contract-test');
    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe('contract-test');
    expect(response.body).toMatchObject({ status: 'success', code: 'ok', request_id: 'contract-test', data: { status: 'alive' } });
  });

  it('fails a hosted checkout without leaking internals when its token is absent', async () => {
    const response = await request(app.getHttpServer()).get('/v1/checkout/DEP-1');
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body).toMatchObject({ status: 'error', code: 'forbidden' });
  });
});

describe('public POST response codes', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [DepositsController, WithdrawalsController],
      providers: [
        { provide: DepositsService, useValue: { initialize: async (_auth: unknown, body: { tx_ref: string }) => ({ tx_ref: body.tx_ref }) } },
        { provide: WithdrawalsService, useValue: { create: async (_auth: unknown, body: { reference: string }) => ({ reference: body.reference }) } },
      ],
    })
      .overrideGuard(MerchantAuthGuard)
      .useValue({
        canActivate(context: { switchToHttp(): { getRequest(): Record<string, unknown> } }) {
          context.switchToHttp().getRequest().auth = { merchantId: '11111111-1111-4111-8111-111111111111', environment: 'test', apiKeyId: 'test-key' };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.use(requestContextMiddleware);
    await app.init();
  });

  afterEach(async () => app.close());

  it('returns the documented 200 for transaction initialization', async () => {
    const response = await request(app.getHttpServer()).post('/v1/transaction/initialize').send({
      amount: '500.00',
      currency: 'ETB',
      tx_ref: 'deposit-contract-1',
      customer_id: 'player-42',
      first_name: 'Abebe',
      phone_number: '0912345678',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual({ tx_ref: 'deposit-contract-1' });
  });

  it('returns the documented 200 for transfer creation', async () => {
    const response = await request(app.getHttpServer()).post('/v1/transfers').send({
      account_number: '0912345678',
      expected_name: 'Abebe Kebede',
      customer_id: 'player-42',
      amount: '500.00',
      currency: 'ETB',
      reference: 'withdrawal-contract-1',
      bank_code: 855,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual({ reference: 'withdrawal-contract-1' });
  });
});
