import net from 'node:net';
import { openGatewayManagedDatabaseTunnel } from '@/grpc/services/database-tunnel.js';

export interface ManagedDatabaseTunnelEndpoint {
  host: '127.0.0.1';
  port: number;
}

/**
 * Keeps the database drivers on their normal TCP interfaces while routing
 * private managed instances through the authenticated daemon tunnel. No
 * listener is reachable outside the Gateway process host.
 */
export class ManagedDatabaseTunnelProxy {
  private readonly endpoints = new Map<string, Promise<ManagedDatabaseTunnelEndpoint>>();

  getEndpoint(managedDatabaseId: string): Promise<ManagedDatabaseTunnelEndpoint> {
    const existing = this.endpoints.get(managedDatabaseId);
    if (existing) return existing;
    const endpoint = this.createEndpoint(managedDatabaseId).catch((error) => {
      this.endpoints.delete(managedDatabaseId);
      throw error;
    });
    this.endpoints.set(managedDatabaseId, endpoint);
    return endpoint;
  }

  private async createEndpoint(managedDatabaseId: string): Promise<ManagedDatabaseTunnelEndpoint> {
    const server = net.createServer((socket) => {
      // A failed tunnel open is a normal transient condition while a database
      // node reconnects. The socket error must be consumed locally; otherwise
      // Node promotes it to an uncaughtException and can take down the API.
      socket.on('error', () => {});
      socket.pause();
      void openGatewayManagedDatabaseTunnel(managedDatabaseId)
        .then((tunnel) => {
          const closePeer = () => {
            if (!tunnel.destroyed) tunnel.destroy();
            if (!socket.destroyed) socket.destroy();
          };
          socket.once('error', closePeer);
          tunnel.once('error', closePeer);
          socket.pipe(tunnel).pipe(socket);
          socket.resume();
        })
        .catch((error) => socket.destroy(error instanceof Error ? error : new Error('Managed database tunnel failed')));
    });
    server.unref();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Managed database tunnel listener did not expose a TCP endpoint');
    }
    return { host: '127.0.0.1', port: address.port };
  }
}
