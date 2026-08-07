import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const peerIdentity = vi.hoisted(() => ({ fingerprintSha256: 'sha256:app' }));

vi.mock('./peer-identity.js', () => ({
  extractRelayPeerCertificateIdentity: () => peerIdentity,
}));

import { RelayControlService } from './control-service.js';

class FakeManagedTunnelStream extends EventEmitter {
  pause = vi.fn();
  resume = vi.fn();
  write = vi.fn(() => true);
  end = vi.fn();
  destroy = vi.fn();
}

describe('RelayControlService app tunnel backpressure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resumes paused gRPC input when the app tunnel writable side drains', async () => {
    let releaseWrite: (() => void) | null = null;
    const driver = new Duplex({
      readableHighWaterMark: 1,
      writableHighWaterMark: 1,
      read() {},
      write(_chunk, _encoding, callback) {
        releaseWrite = callback;
      },
    });
    const relay = { openAppTunnel: vi.fn().mockResolvedValue(driver), revokeBinding: vi.fn() };
    const service = new RelayControlService({
      relayVersion: '1',
      authorization: {} as never,
      relay: relay as never,
      appProxy: {} as never,
      identity: () => ({ trust: { appRelayClientFingerprint: 'sha256:app' } }) as never,
      reloadIdentity: vi.fn(),
    });
    const stream = new FakeManagedTunnelStream();

    service.handlers().OpenManagedDatabaseTunnel(stream as never);
    stream.emit('data', {
      open: {
        managedDatabaseId: '33333333-3333-4333-8333-333333333333',
        lane: 'interactive',
        maxChunkBytes: 1024 * 1024,
      },
    });
    await vi.waitFor(() => expect(stream.write).toHaveBeenCalledWith({ ready: { maxChunkBytes: 1024 * 1024 } }));
    stream.pause.mockClear();
    stream.resume.mockClear();

    stream.emit('data', { data: { data: Buffer.from('query') } });
    expect(stream.pause).toHaveBeenCalledOnce();
    expect(stream.resume).not.toHaveBeenCalled();

    expect(releaseWrite).not.toBeNull();
    (releaseWrite as unknown as () => void)();
    await vi.waitFor(() => expect(stream.resume).toHaveBeenCalledOnce());
    driver.destroy();
  });
});
