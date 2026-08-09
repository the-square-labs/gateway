import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ManagedDatabaseTunnelProxy } from './managed-database-tunnel-proxy.js';

const MANAGED_DATABASE_ID = '44444444-4444-4444-8444-444444444444';

describe('ManagedDatabaseTunnelProxy', () => {
  it('contains a transient tunnel-open failure on its local socket', async () => {
    const openGatewayTunnel = vi.fn().mockRejectedValueOnce(new Error('Managed database node is unavailable'));
    const proxy = new ManagedDatabaseTunnelProxy({ openGatewayTunnel } as never, 'sha256:test');
    const endpoint = await proxy.getEndpoint(MANAGED_DATABASE_ID);
    proxy.setAppCertificateFingerprint('sha256:rotated');

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(endpoint.port, endpoint.host);
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for socket failure')), 1_000);
      socket.once('error', () => {});
      socket.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    expect(openGatewayTunnel).toHaveBeenCalledWith(MANAGED_DATABASE_ID, 'sha256:rotated');
    await proxy.shutdown();
  });

  it('closes all local listeners for a deleted managed database', async () => {
    const proxy = new ManagedDatabaseTunnelProxy(
      { openGatewayTunnel: vi.fn().mockRejectedValue(new Error('unavailable')) } as never,
      'sha256:test'
    );
    const endpoint = await proxy.getEndpoint(MANAGED_DATABASE_ID);

    await proxy.disposeDatabase(MANAGED_DATABASE_ID);

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(endpoint.port, endpoint.host);
      socket.once('connect', () => reject(new Error('Disposed managed database listener still accepted a connection')));
      socket.once('error', () => resolve());
    });

    const replacement = await proxy.getEndpoint(MANAGED_DATABASE_ID);
    expect(replacement.port).toBeGreaterThan(0);
    await proxy.shutdown();
  });
});
