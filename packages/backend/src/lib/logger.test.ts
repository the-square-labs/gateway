import { describe, expect, it } from 'vitest';
import { serializeLogError, serializeMetadataErrors } from './logger.js';

class TransientReconcileError extends Error {
  override name = 'TransientReconcileError';
}

describe('log error serialization', () => {
  it('keeps the message, name, enumerable fields and cause of an Error in metadata', () => {
    const error = Object.assign(new Error('HTTP shutdown exceeded the deadline', { cause: new Error('socket') }), {
      code: 'E_SHUTDOWN',
    });
    const info = serializeMetadataErrors().transform({ level: 'error', message: 'Graceful shutdown failed', error });

    const serialized = JSON.parse(JSON.stringify(info)).error;
    expect(serialized).toMatchObject({
      name: 'Error',
      message: 'HTTP shutdown exceeded the deadline',
      code: 'E_SHUTDOWN',
      cause: { name: 'Error', message: 'socket' },
    });
    expect(serialized.stack).toContain('HTTP shutdown exceeded the deadline');
  });

  it('serializes an Error subclass with its message and omits the stack below error level', () => {
    const info = serializeMetadataErrors().transform({
      level: 'warn',
      message: 'Failed to reconcile',
      error: new TransientReconcileError('Node storage-1 is not connected'),
    });

    expect(JSON.parse(JSON.stringify(info)).error).toEqual({
      name: 'TransientReconcileError',
      message: 'Node storage-1 is not connected',
    });
  });

  it('stops following causes after a bounded depth', () => {
    let error = new Error('root');
    for (let index = 0; index < 10; index++) error = new Error(`level ${index}`, { cause: error });
    let current: unknown = serializeLogError(error, false);
    let depth = 0;
    while (current && typeof current === 'object' && 'cause' in current) {
      current = (current as { cause: unknown }).cause;
      depth++;
    }
    expect(depth).toBe(4);
    expect(current).toBe('Error: level 5');
  });
});
