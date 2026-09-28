import { describe, expect, it } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { isNodeNotConnectedError } from './node-connection-errors.js';

describe('isNodeNotConnectedError', () => {
  it('recognizes the registry error however a caller wrapped it', () => {
    expect(isNodeNotConnectedError(new Error('Node 4e011525-904d-4ce2-82ff-25e7d4ad672c is not connected'))).toBe(true);
    expect(
      isNodeNotConnectedError(
        new AppError(
          500,
          'NGINX_TLS_BUNDLE_FAILED',
          'Failed to safely activate the TLS proxy configuration: Node 4e011525-904d-4ce2-82ff-25e7d4ad672c is not connected'
        )
      )
    ).toBe(true);
    expect(isNodeNotConnectedError(new AppError(409, 'NODE_NOT_CONNECTED', 'Node is not connected'))).toBe(true);
    expect(isNodeNotConnectedError('Node node-1 is not connected')).toBe(true);
  });

  it('keeps every other failure a real failure', () => {
    expect(isNodeNotConnectedError(new Error('nginx: [emerg] unknown directive'))).toBe(false);
    expect(
      isNodeNotConnectedError(new AppError(500, 'NGINX_TLS_BUNDLE_FAILED', 'Daemon TLS bundle apply failed'))
    ).toBe(false);
    expect(isNodeNotConnectedError(new Error('Docker node is not connected to the network'))).toBe(false);
    expect(isNodeNotConnectedError(undefined)).toBe(false);
  });
});
