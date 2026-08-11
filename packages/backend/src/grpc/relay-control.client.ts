import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Duplex } from 'node:stream';
import * as grpc from '@grpc/grpc-js';
import { loadRelayV1Proto } from './relay-proto.js';

export const RELAY_MAX_FRAME_BYTES = 1024 * 1024;

export interface SignedRelayGrant {
  keyId: string;
  payload: Buffer;
  signature: Buffer;
}

export interface RelayPolicySnapshot {
  revision: string;
  gatewayInstanceId: string;
  publicKeys: Array<{ keyId: string; publicKey: Buffer }>;
  endpoints: Array<{
    endpointId: string;
    generation: string;
    subjectKind: string;
    subjectId: string;
    certificateSha256: string;
    maxConcurrentSessions: number;
  }>;
  routes: Array<{
    routeId: string;
    generation: string;
    sourceKind: string;
    sourceId: string;
    sourceCertificateSha256: string;
    targetEndpointId: string;
    maxConcurrentSessions: number;
    maxFrameBytes: number;
    disableIdleTimeout: boolean;
    trafficClass: 'proxy' | 'database';
  }>;
  admissionPolicy: {
    enabled: boolean;
    proxyTargetPressurePercent: number;
    databaseReservePercent: number;
    hardPressurePercent: number;
  };
}

interface RelayTunnelMessage {
  open?: { grant: SignedRelayGrant };
  ready?: { maxFrameBytes: number };
  data?: { data: Buffer | Uint8Array };
  halfClose?: Record<string, never>;
  close?: Record<string, never>;
  error?: { code: string; message: string };
}

class RelayTunnelDuplex extends Duplex {
  private tunnelClosed = false;
  private inboundPaused = false;

  constructor(
    private readonly stream: grpc.ClientDuplexStream<RelayTunnelMessage, RelayTunnelMessage>,
    private readonly maxFrameBytes: number
  ) {
    super();
    stream.on('data', (message) => {
      if (message.data) {
        if (!this.push(Buffer.from(message.data.data))) {
          this.inboundPaused = true;
          stream.pause();
        }
      } else if (message.error) this.destroy(new Error(message.error.message.slice(0, 256)));
      else if (message.close || message.halfClose) this.push(null);
    });
    stream.once('end', () => this.push(null));
    stream.once('error', (error) => this.destroy(error));
  }

  _read(): void {
    if (!this.inboundPaused) return;
    this.inboundPaused = false;
    this.stream.resume();
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (chunk.byteLength <= 0 || chunk.byteLength > this.maxFrameBytes) {
      callback(new Error('Relay frame exceeds the negotiated limit'));
      return;
    }
    try {
      if (this.stream.write({ data: { data: Buffer.from(chunk) } })) callback();
      else this.stream.once('drain', callback);
    } catch (error) {
      callback(error instanceof Error ? error : new Error('Relay write failed'));
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    if (!this.tunnelClosed) this.stream.write({ halfClose: {} });
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.tunnelClosed) {
      this.tunnelClosed = true;
      try {
        this.stream.write({ close: {} });
        this.stream.end();
      } catch {
        this.stream.cancel();
      }
    }
    callback(error);
  }
}

export interface RelayHealthResponse {
  buildVersion: string;
  protocolMajor: number;
  appliedRevision: string;
  keyIds: string[];
  registeredEndpoints: string;
  activeTunnels: string;
  liveness: boolean;
  readiness: boolean;
  reason: string;
  activeProxyTunnels?: string;
  activeDatabaseTunnels?: string;
  throttledProxyTotal?: string;
  throttledDatabaseTotal?: string;
  pressurePercent?: number;
  cpuPressurePercent?: number;
  memoryPressurePercent?: number;
  fdPressurePercent?: number;
  admissionState?: string;
  memoryRssBytes?: string;
  heapInUseBytes?: string;
  memoryLimitBytes?: string;
  openFileDescriptors?: string;
  fileDescriptorLimit?: string;
}

export interface RelayRouteRuntimeResponse {
  routeId: string;
  activeTunnels: string;
  openedTotal: string;
  completedTotal: string;
  failedTotal: string;
  throttledTotal: string;
  sourceToTargetBytes: string;
  targetToSourceBytes: string;
  setupLatencyP95Microseconds: string;
  averageDurationMilliseconds: string;
  lastActivityUnixMilliseconds: string;
  metricsSinceUnixMilliseconds: string;
}

export interface RelayControlClientOptions {
  target: string;
  systemCaPath: string;
  certificatePath: string;
  privateKeyPath: string;
}

export class RelayControlClient {
  private admin: any;
  private broker: any;
  private pendingIdentityReload?: { operationId: string; admin: any; broker: any };
  private identityReloadConvergence?: Promise<boolean>;
  private pendingIdentityCommit?: string;

  constructor(private readonly options: RelayControlClientOptions) {
    ({ admin: this.admin, broker: this.broker } = this.createClients());
  }

  private createClients(): { admin: any; broker: any } {
    const relayV1 = loadRelayV1Proto();
    const credentials = grpc.credentials.createSsl(
      readFileSync(this.options.systemCaPath),
      readFileSync(this.options.privateKeyPath),
      readFileSync(this.options.certificatePath)
    );
    const options = {
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 10_000,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.max_send_message_length': 16 * 1024 * 1024,
      'grpc.max_receive_message_length': 16 * 1024 * 1024,
    };
    return {
      admin: new relayV1.RelayAdmin(this.options.target, credentials, options),
      broker: new relayV1.TunnelBroker(this.options.target, credentials, options),
    };
  }

  close(): void {
    this.admin.close();
    this.broker.close();
    this.pendingIdentityReload?.admin.close();
    this.pendingIdentityReload?.broker.close();
    this.pendingIdentityReload = undefined;
  }

  async getHealth(timeoutMs = 2_000): Promise<RelayHealthResponse> {
    await this.convergePendingIdentityReload(timeoutMs).catch(() => undefined);
    await this.flushPendingIdentityCommit(timeoutMs).catch(() => undefined);
    return this.unary('GetHealth', {}, timeoutMs) as Promise<RelayHealthResponse>;
  }

  async getRouteRuntime(routeId: string, timeoutMs = 2_000): Promise<RelayRouteRuntimeResponse> {
    await this.convergePendingIdentityReload(timeoutMs).catch(() => undefined);
    await this.flushPendingIdentityCommit(timeoutMs).catch(() => undefined);
    return this.unary('GetRouteRuntime', { routeId }, timeoutMs) as Promise<RelayRouteRuntimeResponse>;
  }

  async applySnapshot(
    snapshot: RelayPolicySnapshot,
    timeoutMs = 5_000
  ): Promise<{ appliedRevision: string; unchanged: boolean }> {
    await this.convergePendingIdentityReload(timeoutMs).catch(() => undefined);
    await this.flushPendingIdentityCommit(timeoutMs).catch(() => undefined);
    return this.unary('ApplySnapshot', snapshot, timeoutMs) as Promise<{ appliedRevision: string; unchanged: boolean }>;
  }

  async reloadIdentity(timeoutMs = 2_000): Promise<boolean> {
    if (!this.pendingIdentityReload) {
      const next = this.createClients();
      this.pendingIdentityReload = { operationId: randomUUID(), admin: next.admin, broker: next.broker };
    }
    return this.convergePendingIdentityReload(timeoutMs);
  }

  private async convergePendingIdentityReload(timeoutMs: number): Promise<boolean> {
    if (!this.pendingIdentityReload) return true;
    if (this.identityReloadConvergence) return this.identityReloadConvergence;
    const convergence = this.performIdentityReloadConvergence(timeoutMs);
    this.identityReloadConvergence = convergence;
    try {
      return await convergence;
    } finally {
      if (this.identityReloadConvergence === convergence) this.identityReloadConvergence = undefined;
    }
  }

  private async performIdentityReloadConvergence(timeoutMs: number): Promise<boolean> {
    const pending = this.pendingIdentityReload;
    if (!pending) return true;
    const result = (await this.unary('ReloadIdentity', { operationId: pending.operationId }, timeoutMs)) as {
      reloaded?: boolean;
    };
    if (result.reloaded !== true) {
      pending.admin.close();
      pending.broker.close();
      if (this.pendingIdentityReload === pending) this.pendingIdentityReload = undefined;
      return false;
    }
    const previousAdmin = this.admin;
    const previousBroker = this.broker;
    this.admin = pending.admin;
    this.broker = pending.broker;
    if (this.pendingIdentityReload === pending) this.pendingIdentityReload = undefined;
    previousAdmin.close();
    previousBroker.close();
    this.pendingIdentityCommit = pending.operationId;
    // Commit is explicitly operation-bound and uses the candidate identity.
    // A lost response is safe and retried by later admin operations.
    await this.flushPendingIdentityCommit(timeoutMs).catch(() => undefined);
    return true;
  }

  openTunnel(grant: SignedRelayGrant, timeoutMs = 5_000): Promise<Duplex> {
    const stream = this.broker.OpenTunnel() as grpc.ClientDuplexStream<RelayTunnelMessage, RelayTunnelMessage>;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stream.cancel();
        reject(new Error('Relay tunnel open timed out'));
      }, timeoutMs);
      timer.unref?.();
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      stream.once('error', fail);
      stream.on('data', (message) => {
        if (settled) return;
        if (message.ready) {
          const maxFrameBytes = Math.min(RELAY_MAX_FRAME_BYTES, Number(message.ready.maxFrameBytes) || 0);
          if (maxFrameBytes <= 0) {
            fail(new Error('Relay returned an invalid frame limit'));
            return;
          }
          settled = true;
          clearTimeout(timer);
          stream.off('error', fail);
          resolve(new RelayTunnelDuplex(stream, maxFrameBytes));
        } else if (message.error) fail(new Error(message.error.message.slice(0, 256)));
        else fail(new Error('Relay returned an invalid open response'));
      });
      stream.write({ open: { grant } });
    });
  }

  private unary(method: string, request: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.admin[method](request, { deadline: Date.now() + timeoutMs }, (error: Error | null, response: unknown) =>
        error ? reject(error) : resolve(response)
      );
    });
  }

  private async flushPendingIdentityCommit(timeoutMs: number): Promise<void> {
    const operationId = this.pendingIdentityCommit;
    if (!operationId) return;
    const result = (await this.unary('CommitIdentityRotation', { operationId }, timeoutMs)) as {
      committed?: boolean;
    };
    if (result.committed === true && this.pendingIdentityCommit === operationId) {
      this.pendingIdentityCommit = undefined;
    }
  }
}
