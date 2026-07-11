import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureJsonSerialization, stringifyJsonSafe } from './json-serialization';

@Controller('bigint-response')
class BigIntResponseController {
  @Get()
  response() {
    return {
      id: 'group-1',
      dailyLimitMinor: 15_000_000n,
      nested: { walletCeilingMinor: 7_500_000n },
    };
  }
}

describe('API JSON BigInt serialization', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const module = await Test.createTestingModule({ controllers: [BigIntResponseController] }).compile();
    app = module.createNestApplication();
    configureJsonSerialization(app);
    await app.init();
  });

  afterEach(async () => app.close());

  it('returns exact decimal strings instead of throwing during Express serialization', async () => {
    const response = await request(app.getHttpServer()).get('/bigint-response');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: 'group-1',
      dailyLimitMinor: '15000000',
      nested: { walletCeilingMinor: '7500000' },
    });
  });

  it('uses the same exact representation at non-HTTP serialization boundaries', () => {
    expect(stringifyJsonSafe({ amountMinor: 9_007_199_254_740_993n, nested: [2n] })).toBe(
      '{"amountMinor":"9007199254740993","nested":["2"]}',
    );
  });
});
