import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ManagedStorageTunnelProxy } from './managed-storage-tunnel-proxy.js';

const MANAGED_STORAGE_ID = '44444444-4444-4444-8444-444444444444';

describe('ManagedStorageTunnelProxy', () => {
  it('contains a transient tunnel-open failure on its local socket', async () => {
    const openStorageGatewayTunnel = vi.fn().mockRejectedValueOnce(new Error('Managed storage cluster is unavailable'));
    const proxy = new ManagedStorageTunnelProxy({ openStorageGatewayTunnel } as never, 'sha256:test');
    const endpoint = await proxy.getEndpoint(MANAGED_STORAGE_ID);
    proxy.setAppCertificateFingerprint('sha256:rotated');

    // A failed open must die on this socket alone. Left unhandled, Node
    // promotes the socket error to an uncaughtException and takes the API down
    // whenever a storage node is mid-reconnect.
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(endpoint.port, endpoint.host);
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for socket failure')), 1_000);
      socket.once('error', () => {});
      socket.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    expect(openStorageGatewayTunnel).toHaveBeenCalledWith(MANAGED_STORAGE_ID, 'sha256:rotated');
    await proxy.shutdown();
  });

  it('closes all local listeners for a deleted cluster', async () => {
    const proxy = new ManagedStorageTunnelProxy(
      { openStorageGatewayTunnel: vi.fn().mockRejectedValue(new Error('unavailable')) } as never,
      'sha256:test'
    );
    const endpoint = await proxy.getEndpoint(MANAGED_STORAGE_ID);

    await proxy.disposeCluster(MANAGED_STORAGE_ID);

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(endpoint.port, endpoint.host);
      socket.once('connect', () => reject(new Error('Disposed cluster listener still accepted a connection')));
      socket.once('error', () => resolve());
    });

    await proxy.shutdown();
  });

  it('fails closed when no relay is wired in', async () => {
    const proxy = new ManagedStorageTunnelProxy();
    const endpoint = await proxy.getEndpoint(MANAGED_STORAGE_ID);

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(endpoint.port, endpoint.host);
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for socket failure')), 1_000);
      socket.once('error', () => {});
      socket.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    await proxy.shutdown();
  });
});
