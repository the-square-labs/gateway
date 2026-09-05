import { describe, expect, it } from 'vitest';
import { CoreResponsesSseObserver, MAX_CORE_SSE_FRAME_BYTES } from './inference-core-sse-observer.js';

const encode = (value: string) => new TextEncoder().encode(value);

describe('core Responses SSE observer', () => {
  it.each([
    '\n\n',
    '\r\n\r\n',
    '\n\r\n',
    '\r\n\n',
  ])('handles fragmented UTF-8 and delimiter %j after a large nonterminal event', (delimiter) => {
    const observer = new CoreResponsesSseObserver();
    const prefix = `: comment${delimiter}data: ${JSON.stringify({
      type: 'response.output_text.delta',
      delta: '🌍'.repeat(32 * 1024),
    })}${delimiter}`;
    const bytes = encode(prefix);
    for (let offset = 0; offset < bytes.length; offset += 101) {
      expect(observer.observe(bytes.subarray(offset, offset + 101))).toBeNull();
    }
    expect(observer.hasPendingFrame).toBe(false);
    const terminal = encode(`data: {"type":\n data: ignored\ndata: "response.completed"}${delimiter}`);
    for (const byte of terminal.subarray(0, -1)) {
      expect(observer.observe(Uint8Array.of(byte))).toBeNull();
    }
    expect(observer.hasPendingFrame).toBe(true);
    expect(observer.observe(terminal.subarray(-1))).toBe('completed');
    expect(observer.hasPendingFrame).toBe(false);
  });

  it('accepts a complete frame at the core byte limit with fragmented CRLF', () => {
    const observer = new CoreResponsesSseObserver();
    const prefix = 'data: {"type":"response.completed","padding":"';
    const suffix = '"}';
    const bytes = encode(`${prefix}${'x'.repeat(MAX_CORE_SSE_FRAME_BYTES - prefix.length - suffix.length)}${suffix}`);
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
      expect(observer.observe(bytes.subarray(offset, offset + 16 * 1024))).toBeNull();
    }
    expect(observer.observe(encode('\r\n\r'))).toBeNull();
    expect(observer.observe(encode('\n'))).toBe('completed');
  });

  it('bounds an unterminated frame by bytes, not characters', () => {
    const observer = new CoreResponsesSseObserver();
    const chunk = encode('🌍'.repeat(16 * 1024));
    for (let bytes = 0; bytes < MAX_CORE_SSE_FRAME_BYTES; bytes += chunk.byteLength) {
      expect(observer.observe(chunk)).toBeNull();
    }
    expect(() => observer.observe(chunk)).toThrow('SSE frame exceeded');
    observer.clear();
    expect(observer.hasPendingFrame).toBe(false);
    expect(observer.observe(encode('data: {"type":"response.completed"}\n\n'))).toBe('completed');
  });

  it('does not mistake event names, nested types, DONE, or malformed JSON for success', () => {
    const observer = new CoreResponsesSseObserver();
    for (const frame of [
      'event: response.completed\ndata: {broken}\n\n',
      'data: {"response":{"type":"response.completed"}}\n\n',
      'data: [DONE]\n\n',
      ': response.completed\n\n',
    ]) {
      expect(observer.observe(encode(frame))).toBeNull();
    }
    expect(observer.observe(encode('data: {"type":"error"}\n\n'))).toBe('failed');
  });
});
