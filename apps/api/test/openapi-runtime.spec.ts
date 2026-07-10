import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureMaintainedOpenApi } from '../src/openapi-contract';

describe('runtime OpenAPI contract', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const module = await Test.createTestingModule({}).compile();
    app = module.createNestApplication();
    configureMaintainedOpenApi(app);
    await app.init();
  });

  afterEach(async () => app.close());

  it('serves the maintained 3.1 schemas, security, and standard responses', async () => {
    const response = await request(app.getHttpServer()).get('/docs/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe('3.1.0');
    expect(response.body.security).toContainEqual({ merchantSecretKey: [] });
    expect(response.body.components.schemas.InitializeTransactionRequest).toBeDefined();
    expect(response.body.components.schemas.ErrorEnvelope).toBeDefined();
    expect(response.body.paths['/v1/transaction/initialize'].post.responses['200']).toBeDefined();
    expect(response.body.paths['/v1/transfers'].post.responses['200']).toBeDefined();
  });
});
