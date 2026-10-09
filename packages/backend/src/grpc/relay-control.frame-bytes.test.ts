import { describe, expect, it } from 'vitest';
import { frameBytes } from './relay-control.client.js';

describe('frameBytes', () => {
  it('hands a received frame on without copying it', () => {
    const decoded = Buffer.from('relay frame payload');
    expect(frameBytes(decoded)).toBe(decoded);

    const backing = new Uint8Array(64).fill(7);
    const view = backing.subarray(8, 40);
    const bytes = frameBytes(view);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.byteLength).toBe(32);
    backing[8] = 9;
    expect(bytes[0]).toBe(9);
  });
});
