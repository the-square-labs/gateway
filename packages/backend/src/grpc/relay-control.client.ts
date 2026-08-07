import { readFileSync } from 'node:fs';
import { Duplex } from 'node:stream';
import * as grpc from '@grpc/grpc-js';
import { loadRelayProto } from '@/relay/proto.js';
import { RELAY_MAX_CHUNK_BYTES, type RelayManagedDatabaseLane } from '@/relay/protocol.js';

interface RelayManagedTunnelMessage {
  open?: { managedDatabaseId: string; lane: string; maxChunkBytes: number };
  ready?: { maxChunkBytes: number };
  data?: { data: Buffer | Uint8Array };
  close?: Record<string, never>;
  error?: { code: string; message: string };
}

class RelayManagedTunnelDuplex extends Duplex {
  private tunnelClosed = false;
  private inboundPaused = false;

  constructor(private readonly stream: grpc.ClientDuplexStream<RelayManagedTunnelMessage, RelayManagedTunnelMessage>) {
    super();
    stream.on('data', (message) => {
      if (message.data) {
        if (!this.push(Buffer.from(message.data.data))) {
          this.inboundPaused = true;
          stream.pause();
        }
      } else if (message.error) this.destroy(new Error(message.error.message.slice(0, 256)));
      else if (message.close) this.push(null);
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
    if (chunk.byteLength <= 0 || chunk.byteLength > RELAY_MAX_CHUNK_BYTES) {
      callback(new Error('Managed database relay frame exceeds the negotiated limit'));
      return;
    }
    try {
      if (this.stream.write({ data: { data: Buffer.from(chunk) } })) callback();
      else this.stream.once('drain', callback);
    } catch (error) {
      callback(error instanceof Error ? error : new Error('Managed database relay write failed'));
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    this.closeOnce();
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.closeOnce();
    callback(error);
  }

  private closeOnce(): void {
    if (this.tunnelClosed) return;
    this.tunnelClosed = true;
    try {
      this.stream.write({ close: {} });
      this.stream.end();
    } catch {
      this.stream.cancel();
    }
  }
}

export interface RelayHealthResponse {
  relayVersion: string;
  protocolVersion: number;
  databaseContractVersion: number;
  liveness: boolean;
  readiness: boolean;
  dataPlaneHealthy: boolean;
  appProxyHealthy: boolean;
  reason: string;
  lastHealthyAtUnixMs: string;
}

export interface RelayControlClientOptions {
  target: string;
  systemCaPath: string;
  certificatePath: string;
  privateKeyPath: string;
}

export class RelayControlClient {
  private client: any;

  constructor(private readonly options: RelayControlClientOptions) {
    this.client = this.createClient();
  }

  private createClient(): any {
    const gatewayV1 = loadRelayProto();
    const credentials = grpc.credentials.createSsl(
      readFileSync(this.options.systemCaPath),
      readFileSync(this.options.privateKeyPath),
      readFileSync(this.options.certificatePath)
    );
    return new gatewayV1.GatewayRelayControl(this.options.target, credentials, {
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 10_000,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.max_send_message_length': 2 * 1024 * 1024,
      'grpc.max_receive_message_length': 2 * 1024 * 1024,
    });
  }

  close(): void {
    this.client.close();
  }

  getHealth(timeoutMs = 2_000): Promise<RelayHealthResponse> {
    return this.unary('GetHealth', {}, timeoutMs) as Promise<RelayHealthResponse>;
  }

  async revokeBinding(bindingId: string, timeoutMs = 1_000): Promise<boolean> {
    const result = (await this.unary('RevokeBinding', { bindingId }, timeoutMs)) as { accepted?: boolean };
    return result.accepted === true;
  }

  async reloadIdentity(timeoutMs = 2_000): Promise<boolean> {
    try {
      const result = (await this.unary('ReloadIdentity', {}, timeoutMs)) as { reloaded?: boolean };
      return result.reloaded === true;
    } finally {
      const previous = this.client;
      this.client = this.createClient();
      previous.close();
    }
  }

  openManagedDatabaseTunnel(
    managedDatabaseId: string,
    lane: RelayManagedDatabaseLane = 'interactive',
    timeoutMs = 5_000
  ): Promise<Duplex> {
    const stream = this.client.OpenManagedDatabaseTunnel() as grpc.ClientDuplexStream<
      RelayManagedTunnelMessage,
      RelayManagedTunnelMessage
    >;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stream.cancel();
        reject(new Error('Managed database relay tunnel open timed out'));
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
          settled = true;
          clearTimeout(timer);
          stream.off('error', fail);
          resolve(new RelayManagedTunnelDuplex(stream));
        } else if (message.error) {
          fail(new Error(message.error.message.slice(0, 256)));
        } else {
          fail(new Error('Managed database relay returned an invalid open response'));
        }
      });
      stream.write({ open: { managedDatabaseId, lane, maxChunkBytes: RELAY_MAX_CHUNK_BYTES } });
    });
  }

  private unary(method: string, request: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.client[method](request, { deadline: Date.now() + timeoutMs }, (error: Error | null, response: unknown) =>
        error ? reject(error) : resolve(response)
      );
    });
  }
}
