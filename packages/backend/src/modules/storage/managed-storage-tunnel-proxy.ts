import net from 'node:net';
import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('ManagedStorageTunnelProxy');

import type { RelayPolicyService } from '@/services/relay-policy.service.js';

export interface ManagedStorageTunnelEndpoint {
  host: '127.0.0.1';
  port: number;
}

/**
 * Bridges the S3 client to a managed MinIO container over the authenticated
 * daemon tunnel: a loopback-only listener whose connections are piped to the
 * cluster's node. No listener is reachable outside the Gateway process host,
 * so a managed cluster needs no publicly reachable S3 port for the UI path.
 */
export class ManagedStorageTunnelProxy {
  private readonly endpoints = new Map<string, Promise<ManagedStorageTunnelEndpoint>>();
  private readonly servers = new Map<string, net.Server>();
  private readonly sockets = new Map<string, Set<net.Socket>>();

  constructor(
    private readonly relayPolicy?: Pick<RelayPolicyService, 'openStorageGatewayTunnel'>,
    private appCertificateFingerprint?: string
  ) {}

  setAppCertificateFingerprint(fingerprint: string): void {
    this.appCertificateFingerprint = fingerprint;
  }

  getEndpoint(managedStorageId: string): Promise<ManagedStorageTunnelEndpoint> {
    const existing = this.endpoints.get(managedStorageId);
    if (existing) return existing;
    const endpoint = this.createEndpoint(managedStorageId).catch((error) => {
      this.disposeEndpoint(managedStorageId);
      throw error;
    });
    this.endpoints.set(managedStorageId, endpoint);
    return endpoint;
  }

  async disposeCluster(managedStorageId: string): Promise<void> {
    this.disposeEndpoint(managedStorageId);
  }

  async shutdown(): Promise<void> {
    for (const key of [...this.endpoints.keys()]) this.disposeEndpoint(key);
  }

  private async createEndpoint(managedStorageId: string): Promise<ManagedStorageTunnelEndpoint> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      // A failed tunnel open is a normal transient condition while a storage
      // node reconnects. The socket error must be consumed locally; otherwise
      // Node promotes it to an uncaughtException and can take down the API.
      socket.on('error', () => {});
      socket.pause();
      const openTunnel =
        this.relayPolicy && this.appCertificateFingerprint
          ? this.relayPolicy.openStorageGatewayTunnel(managedStorageId, this.appCertificateFingerprint)
          : Promise.reject(new Error('Gateway relay is unavailable'));
      void openTunnel
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
        .catch((error) => {
          logger.warn('Managed storage tunnel failed', {
            managedStorageId,
            error: error instanceof Error ? error.message : String(error),
          });
          socket.destroy(error instanceof Error ? error : new Error('Managed storage tunnel failed'));
        });
    });
    server.on('error', () => {});
    server.unref();
    this.servers.set(managedStorageId, server);
    this.sockets.set(managedStorageId, sockets);
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
      throw new Error('Managed storage tunnel listener did not expose a TCP endpoint');
    }
    if (!this.endpoints.has(managedStorageId)) {
      server.close();
      throw new Error('Managed storage tunnel listener was disposed before it became ready');
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
