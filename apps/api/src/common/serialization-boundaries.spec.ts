import { afterEach, describe, expect, it } from 'vitest';
import { DeviceSigningService } from '../devices/device-signing.service';
import { MessageBusService } from '../infra/message-bus.service';

describe('non-HTTP JSON boundaries', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('signs the exact decimal representation of a BigInt payload', () => {
    process.env.NODE_ENV = 'test';
    const signing = new DeviceSigningService();
    const envelope = signing.signJson({ amountMinor: 9_007_199_254_740_993n });

    expect(JSON.parse(Buffer.from(envelope.payload_base64, 'base64').toString('utf8'))).toEqual({
      amountMinor: '9007199254740993',
    });
  });

  it('normalizes local message-bus payloads exactly like the RabbitMQ JSON round-trip', async () => {
    const bus = new MessageBusService({} as never);
    const received = new Promise<unknown>((resolve) => {
      const unsubscribe = bus.subscribeLocal('test.bigint', (payload) => {
        unsubscribe();
        resolve(payload);
      });
    });

    await bus.publish('test.bigint', { amountMinor: 9_007_199_254_740_993n });

    await expect(received).resolves.toEqual({ amountMinor: '9007199254740993' });
  });
});
