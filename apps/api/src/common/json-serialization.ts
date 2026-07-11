import type { INestApplication } from '@nestjs/common';

/** Preserve integer precision by representing native BigInts as decimal strings in JSON. */
export function jsonBigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function stringifyJsonSafe(value: unknown): string {
  const serialized = JSON.stringify(value, jsonBigIntReplacer);
  if (serialized === undefined) throw new TypeError('Value is not JSON serializable');
  return serialized;
}

export function toJsonCompatible(value: unknown): unknown {
  return JSON.parse(stringifyJsonSafe(value)) as unknown;
}

export function configureJsonSerialization(app: INestApplication): void {
  const express = app.getHttpAdapter().getInstance() as {
    set(name: string, value: unknown): void;
  };
  express.set('json replacer', jsonBigIntReplacer);
}
