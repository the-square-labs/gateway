import { describe, expect, it } from 'vitest';
import { parseNodeCommandResult } from './node-service-helpers.js';

describe('node file command results', () => {
  it('answers a path the daemon user may not open with 403, not a dispatch error (F-C4)', () => {
    expect(() => parseNodeCommandResult({ success: false, error: 'open /etc/m88-f.txt: permission denied' })).toThrow(
      expect.objectContaining({ statusCode: 403, code: 'NODE_FILE_PERMISSION_DENIED' })
    );
  });

  it('keeps every other daemon failure a dispatch error', () => {
    expect(() => parseNodeCommandResult({ success: false, error: 'no such file or directory' })).toThrow(
      expect.objectContaining({ statusCode: 502, code: 'DISPATCH_ERROR' })
    );
    expect(parseNodeCommandResult({ success: true, detail: '{"ok":true}' })).toEqual({ ok: true });
  });
});
