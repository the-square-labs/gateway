import net from 'node:net';
import { type ManagedDatabaseTunnelLane, openGatewayManagedDatabaseTunnel } from '@/grpc/services/database-tunnel.js';

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
  private readonly servers = new Map<string, net.Server>();
  private readonly sockets = new Map<string, Set<net.Socket>>();

  getEndpoint(
    managedDatabaseId: string,
    lane: ManagedDatabaseTunnelLane = 'interactive'
  ): Promise<ManagedDatabaseTunnelEndpoint> {
    const key = `${managedDatabaseId}:${lane}`;
    const existing = this.endpoints.get(key);
    if (existing) return existing;
    const endpoint = this.createEndpoint(key, managedDatabaseId, lane).catch((error) => {
      this.disposeEndpoint(key);
      throw error;
    });
    this.endpoints.set(key, endpoint);
    return endpoint;
  }

  async disposeDatabase(managedDatabaseId: string): Promise<void> {
    const prefix = `${managedDatabaseId}:`;
    for (const key of [...this.endpoints.keys()]) {
      if (key.startsWith(prefix)) this.disposeEndpoint(key);
    }
  }

  async shutdown(): Promise<void> {
    for (const key of [...this.endpoints.keys()]) this.disposeEndpoint(key);
  }

  private async createEndpoint(
    key: string,
    managedDatabaseId: string,
    lane: ManagedDatabaseTunnelLane
  ): Promise<ManagedDatabaseTunnelEndpoint> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      // A failed tunnel open is a normal transient condition while a database
      // node reconnects. The socket error must be consumed locally; otherwise
      // Node promotes it to an uncaughtException and can take down the API.
      socket.on('error', () => {});
      socket.pause();
      void openGatewayManagedDatabaseTunnel(managedDatabaseId, lane)
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
    server.on('error', () => {});
    server.unref();
    this.servers.set(key, server);
    this.sockets.set(key, sockets);
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
    if (!this.endpoints.has(key)) {
      server.close();
      throw new Error('Managed database tunnel listener was disposed before it became ready');
    }
    return { host: '127.0.0.1', port: address.port };
  }

  private disposeEndpoint(key: string): void {
    this.endpoints.delete(key);
    const sockets = this.sockets.get(key);
    this.sockets.delete(key);
    for (const socket of sockets ?? []) socket.destroy();
    const server = this.servers.get(key);
    this.servers.delete(key);
    if (server?.listening) server.close();
  }
}
