import type { Duplex } from 'node:stream';
import * as grpc from '@grpc/grpc-js';
import type { AppGrpcProxy } from './app-proxy.js';
import type { RelayAuthorizationRepository, RelayAuthorizationRepositoryError } from './authorization-repository.js';
import type { RelayIdentitySnapshot } from './identity.js';
import { extractRelayPeerCertificateIdentity } from './peer-identity.js';
import {
  RELAY_DATABASE_CONTRACT_VERSION,
  RELAY_MAX_CHUNK_BYTES,
  RELAY_PROTOCOL_VERSION,
  type RelayManagedDatabaseTunnelMessage,
} from './protocol.js';
import type { StandaloneDatabaseTunnelRelay } from './tunnel-relay.js';

type UnaryCallback = (error: grpc.ServiceError | null, value?: unknown) => void;
type ManagedTunnelStream = grpc.ServerDuplexStream<
  RelayManagedDatabaseTunnelMessage,
  RelayManagedDatabaseTunnelMessage
>;

function serviceError(code: grpc.status, message: string): grpc.ServiceError {
  return Object.assign(new Error(message), { code, details: message, metadata: new grpc.Metadata() });
}

export interface RelayControlServiceOptions {
  relayVersion: string;
  authorization: RelayAuthorizationRepository;
  relay: StandaloneDatabaseTunnelRelay;
  appProxy: AppGrpcProxy;
  identity: () => RelayIdentitySnapshot;
  reloadIdentity: () => Promise<boolean>;
}

export class RelayControlService {
  private lastHealthyAt = 0;

  constructor(private readonly options: RelayControlServiceOptions) {}

  handlers() {
    return {
      GetHealth: (call: grpc.ServerUnaryCall<Record<string, never>, unknown>, callback: UnaryCallback) =>
        this.getHealth(call, callback),
      RevokeBinding: (call: grpc.ServerUnaryCall<{ bindingId: string }, unknown>, callback: UnaryCallback) =>
        this.revokeBinding(call, callback),
      OpenManagedDatabaseTunnel: (stream: ManagedTunnelStream) => this.openManagedDatabaseTunnel(stream),
      ReloadIdentity: (call: grpc.ServerUnaryCall<Record<string, never>, unknown>, callback: UnaryCallback) =>
        this.reloadIdentity(call, callback),
    };
  }

  private isAuthorizedService(call: unknown, allowRelaySelf: boolean): boolean {
    const peer = extractRelayPeerCertificateIdentity(call as never);
    if (!peer) return false;
    const trust = this.options.identity().trust;
    return (
      peer.fingerprintSha256 === trust.appRelayClientFingerprint ||
      (allowRelaySelf && peer.fingerprintSha256 === trust.relayAppClientFingerprint)
    );
  }

  private getHealth(call: grpc.ServerUnaryCall<Record<string, never>, unknown>, callback: UnaryCallback): void {
    if (!this.isAuthorizedService(call, true)) {
      callback(serviceError(grpc.status.PERMISSION_DENIED, 'Relay service identity required'));
      return;
    }
    void Promise.allSettled([this.options.authorization.checkContract(), this.options.appProxy.isReady()]).then(
      ([database, app]) => {
        const dataPlaneHealthy = database.status === 'fulfilled';
        const appProxyHealthy = app.status === 'fulfilled' && app.value;
        if (dataPlaneHealthy) this.lastHealthyAt = Date.now();
        let reason = '';
        if (!dataPlaneHealthy) {
          const failure = database.reason as RelayAuthorizationRepositoryError | undefined;
          reason = failure?.reason ?? 'database_unavailable';
        } else if (!appProxyHealthy) reason = 'app_grpc_unavailable';
        callback(null, {
          relayVersion: this.options.relayVersion,
          protocolVersion: RELAY_PROTOCOL_VERSION,
          databaseContractVersion: RELAY_DATABASE_CONTRACT_VERSION,
          liveness: true,
          readiness: dataPlaneHealthy,
          dataPlaneHealthy,
          appProxyHealthy,
          reason,
          lastHealthyAtUnixMs: String(this.lastHealthyAt),
        });
      }
    );
  }

  private revokeBinding(call: grpc.ServerUnaryCall<{ bindingId: string }, unknown>, callback: UnaryCallback): void {
    if (!this.isAuthorizedService(call, false)) {
      callback(serviceError(grpc.status.PERMISSION_DENIED, 'App relay identity required'));
      return;
    }
    this.options.relay.revokeBinding(call.request.bindingId);
    callback(null, { accepted: true });
  }

  private reloadIdentity(call: grpc.ServerUnaryCall<Record<string, never>, unknown>, callback: UnaryCallback): void {
    if (!this.isAuthorizedService(call, false)) {
      callback(serviceError(grpc.status.PERMISSION_DENIED, 'App relay identity required'));
      return;
    }
    void this.options
      .reloadIdentity()
      .then((reloaded) => callback(null, { reloaded }))
      .catch(() => callback(serviceError(grpc.status.FAILED_PRECONDITION, 'Relay identity reload failed')));
  }

  private openManagedDatabaseTunnel(stream: ManagedTunnelStream): void {
    if (!this.isAuthorizedService(stream, false)) {
      stream.destroy(serviceError(grpc.status.PERMISSION_DENIED, 'App relay identity required'));
      return;
    }
    let driver: Duplex | null = null;
    let opened = false;
    let closed = false;
    let inputPaused = false;
    stream.pause();
    const close = () => {
      if (closed) return;
      closed = true;
      driver?.destroy();
    };
    stream.once('error', close);
    stream.once('end', () => {
      driver?.end();
      stream.end();
      close();
    });
    stream.on('data', (message: RelayManagedDatabaseTunnelMessage) => {
      if (closed) return;
      if (!opened) {
        const open = message.open;
        if (
          !open ||
          (open.lane !== 'interactive' && open.lane !== 'monitoring') ||
          !Number.isInteger(open.maxChunkBytes) ||
          open.maxChunkBytes <= 0
        ) {
          stream.destroy(serviceError(grpc.status.INVALID_ARGUMENT, 'First relay tunnel frame must be a valid open'));
          return;
        }
        opened = true;
        stream.pause();
        void this.options.relay
          .openAppTunnel(open.managedDatabaseId, open.lane)
          .then((tunnel) => {
            if (closed) {
              tunnel.destroy();
              return;
            }
            driver = tunnel;
            driver.on('data', (data: Buffer) => {
              if (!stream.write({ data: { data } })) driver?.pause();
            });
            stream.on('drain', () => driver?.resume());
            driver.on('end', () => {
              stream.write({ close: {} });
              stream.end();
              close();
            });
            driver.on('error', (error) => {
              stream.write({ error: { code: 'TUNNEL_FAILED', message: error.message.slice(0, 256) } });
              stream.end();
              close();
            });
            stream.write({ ready: { maxChunkBytes: Math.min(RELAY_MAX_CHUNK_BYTES, open.maxChunkBytes) } });
            stream.resume();
          })
          .catch((error) => {
            stream.write({
              error: {
                code: 'TUNNEL_UNAVAILABLE',
                message: (error instanceof Error ? error.message : 'Managed database tunnel unavailable').slice(0, 256),
              },
            });
            stream.end();
            close();
          });
        return;
      }
      if (!driver) return;
      if (message.data) {
        const data = Buffer.from(message.data.data);
        if (data.byteLength <= 0 || data.byteLength > RELAY_MAX_CHUNK_BYTES) {
          stream.destroy(serviceError(grpc.status.RESOURCE_EXHAUSTED, 'Relay tunnel frame exceeds the limit'));
          return;
        }
        if (!driver.write(data) && !inputPaused) {
          inputPaused = true;
          stream.pause();
          driver.once('drain', () => {
            inputPaused = false;
            if (!closed) stream.resume();
          });
        }
      } else if (message.close) {
        driver.end();
      } else if (message.error) {
        driver.destroy(new Error(message.error.message.slice(0, 256)));
      } else {
        stream.destroy(serviceError(grpc.status.INVALID_ARGUMENT, 'Unexpected relay tunnel frame'));
      }
    });
    stream.resume();
  }
}
