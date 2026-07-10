import { describe, expect, it } from 'vitest';
import { advisorySchema, extractOutputText } from './name-advisory-dispatch.service';

describe('OpenClaw name advisory boundary', () => {
  it('extracts and validates the closed decision vocabulary', () => {
    const text = extractOutputText({ output: [{ content: [{ type: 'output_text', text: '{"decision":"uncertain","explanation":"word order differs"}' }] }] });
    expect(advisorySchema.parse(JSON.parse(text)).decision).toBe('uncertain');
  });

  it('rejects an AI attempt to return an execution decision', () => {
    expect(() => advisorySchema.parse({ decision: 'approve_and_send', explanation: 'unsafe' })).toThrow();
  });
});
