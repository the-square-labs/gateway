import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { openGatewayManagedDatabaseTunnel } from '@/grpc/services/database-tunnel.js';
import { ManagedDatabaseTunnelProxy } from './managed-database-tunnel-proxy.js';

vi.mock('@/grpc/services/database-tunnel.js', () => ({
  openGatewayManagedDatabaseTunnel: vi.fn(),
}));

const MANAGED_DATABASE_ID = '44444444-4444-4444-8444-444444444444';

describe('ManagedDatabaseTunnelProxy', () => {
  it('contains a transient tunnel-open failure on its local socket', async () => {
    vi.mocked(openGatewayManagedDatabaseTunnel).mockRejectedValueOnce(
      new Error('Managed database node is unavailable')
    );
    const proxy = new ManagedDatabaseTunnelProxy();
    const endpoint = await proxy.getEndpoint(MANAGED_DATABASE_ID);

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(endpoint.port, endpoint.host);
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for socket failure')), 1_000);
      socket.once('error', () => {});
      socket.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    expect(openGatewayManagedDatabaseTunnel).toHaveBeenCalledWith(MANAGED_DATABASE_ID, 'interactive');
    await proxy.shutdown();
  });

  it('closes all local listeners for a deleted managed database', async () => {
    const proxy = new ManagedDatabaseTunnelProxy();
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
