import * as grpc from '@grpc/grpc-js';
import type { RelayAuthorizationRepository, RelayNodeIdentity } from './authorization-repository.js';
import type { RelayIdentitySnapshot } from './identity.js';
import { extractRelayPeerCertificateIdentity } from './peer-identity.js';

export const RELAY_FORWARDED_METADATA = {
  nodeId: 'x-wiolett-relay-node-id',
  certificateSerial: 'x-wiolett-relay-cert-serial',
  nodeType: 'x-wiolett-relay-node-type',
} as const;
const RELAY_METADATA_PREFIX = 'x-wiolett-relay-';

type UnaryCallback = (error: grpc.ServiceError | null, value?: unknown) => void;
type AnyCall = grpc.ServerUnaryCall<unknown, unknown> | grpc.ServerDuplexStream<unknown, unknown>;

export function statusError(code: grpc.status, message: string): grpc.ServiceError {
  return Object.assign(new Error(message), { code, details: message, metadata: new grpc.Metadata() });
}

export function buildForwardedMetadata(source: grpc.Metadata, identity?: RelayNodeIdentity & { serialNumber: string }) {
  const metadata = source.clone();
  for (const key of Object.keys(metadata.getMap())) {
    if (key.toLowerCase().startsWith(RELAY_METADATA_PREFIX)) metadata.remove(key);
  }
  if (identity) {
    metadata.set(RELAY_FORWARDED_METADATA.nodeId, identity.nodeId);
    metadata.set(RELAY_FORWARDED_METADATA.certificateSerial, identity.serialNumber);
    metadata.set(RELAY_FORWARDED_METADATA.nodeType, identity.nodeType);
  }
  return metadata;
}

export class AppGrpcProxy {
  private clients: Record<string, any> = {};
  private readonly activeBidiClosers = new Set<(error?: Error) => void>();

  constructor(
    private readonly gatewayV1: any,
    private readonly target: string,
    private readonly authorization: RelayAuthorizationRepository,
    identity: RelayIdentitySnapshot
  ) {
    this.replaceIdentity(identity);
  }

  replaceIdentity(identity: RelayIdentitySnapshot): void {
    this.close();
    const credentials = grpc.credentials.createSsl(
      identity.systemCa,
      identity.relayClientPrivateKey,
      identity.relayClientCertificate
    );
    const options = {
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 10_000,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.max_send_message_length': 512 * 1024 * 1024,
      'grpc.max_receive_message_length': 512 * 1024 * 1024,
    };
    this.clients = {
      enrollment: new this.gatewayV1.NodeEnrollment(this.target, credentials, options),
      control: new this.gatewayV1.NodeControl(this.target, credentials, options),
      logs: new this.gatewayV1.LogStream(this.target, credentials, options),
      migration: new this.gatewayV1.MigrationTransfer(this.target, credentials, options),
    };
  }

  async isReady(timeoutMs = 1_000): Promise<boolean> {
    const client = this.clients.enrollment;
    return new Promise((resolve) => {
      client.waitForReady(Date.now() + timeoutMs, (error: Error | undefined) => resolve(!error));
    });
  }

  close(): void {
    const unavailable = statusError(grpc.status.UNAVAILABLE, 'Gateway app gRPC is restarting');
    for (const close of [...this.activeBidiClosers]) close(unavailable);
    this.activeBidiClosers.clear();
    for (const client of Object.values(this.clients)) client.close?.();
    this.clients = {};
  }

  enrollmentHandlers() {
    return {
      Enroll: (call: grpc.ServerUnaryCall<unknown, unknown>, callback: UnaryCallback) =>
        this.forwardUnary(this.clients.enrollment, 'Enroll', call, callback, false),
      RenewCertificate: (call: grpc.ServerUnaryCall<unknown, unknown>, callback: UnaryCallback) =>
        this.forwardUnary(this.clients.enrollment, 'RenewCertificate', call, callback, true),
    };
  }

  controlHandlers() {
    return {
      CommandStream: (call: grpc.ServerDuplexStream<unknown, unknown>) =>
        this.forwardBidi(this.clients.control, 'CommandStream', call),
    };
  }

  logHandlers() {
    return {
      StreamLogs: (call: grpc.ServerDuplexStream<unknown, unknown>) =>
        this.forwardBidi(this.clients.logs, 'StreamLogs', call),
    };
  }

  migrationHandlers() {
    return {
      Transfer: (call: grpc.ServerDuplexStream<unknown, unknown>) =>
        this.forwardBidi(this.clients.migration, 'Transfer', call),
    };
  }

  private async authenticate(call: AnyCall): Promise<(RelayNodeIdentity & { serialNumber: string }) | null> {
    const certificate = extractRelayPeerCertificateIdentity(call);
    if (!certificate) return null;
    const node = await this.authorization.authenticateNode(certificate.commonName, certificate.serialNumber);
    return node ? { ...node, serialNumber: certificate.serialNumber } : null;
  }

  private forwardUnary(
    client: any,
    method: string,
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: UnaryCallback,
    requireIdentity: boolean
  ): void {
    void (async () => {
      const identity = requireIdentity ? await this.authenticate(call) : undefined;
      if (requireIdentity && !identity) {
        callback(statusError(grpc.status.UNAUTHENTICATED, 'Authorized daemon certificate required'));
        return;
      }
      const metadata = buildForwardedMetadata(call.metadata, identity ?? undefined);
      client[method](call.request, metadata, (error: grpc.ServiceError | null, response: unknown) =>
        callback(error, response)
      );
    })().catch(() => callback(statusError(grpc.status.UNAVAILABLE, 'Relay authorization unavailable')));
  }

  private forwardBidi(client: any, method: string, call: grpc.ServerDuplexStream<unknown, unknown>): void {
    let upstream: grpc.ClientDuplexStream<unknown, unknown> | null = null;
    let closed = false;
    call.pause();
    const close = (error?: Error) => {
      if (closed) return;
      closed = true;
      this.activeBidiClosers.delete(close);
      if (error) {
        upstream?.cancel();
        // grpc-js converts an error event into the final non-OK gRPC status.
        // destroy(error) marks the Duplex as destroyed before its _final path
        // can send that status, which can leave the daemon call hanging.
        call.emit('error', error);
      } else {
        upstream?.end();
      }
    };
    this.activeBidiClosers.add(close);
    call.once('error', () => close());
    call.once('cancelled', () => close());
    call.once('end', () => {
      upstream?.end();
      if (!upstream) {
        closed = true;
        this.activeBidiClosers.delete(close);
      }
    });

    void (async () => {
      const identity = await this.authenticate(call);
      if (!identity) throw statusError(grpc.status.UNAUTHENTICATED, 'Authorized daemon certificate required');
      if (closed) return;
      const appStream = client[method](buildForwardedMetadata(call.metadata, identity)) as grpc.ClientDuplexStream<
        unknown,
        unknown
      >;
      upstream = appStream;
      appStream.on('data', (message: unknown) => {
        if (!call.write(message)) appStream.pause();
      });
      call.on('drain', () => appStream.resume());
      appStream.on('end', () => {
        closed = true;
        this.activeBidiClosers.delete(close);
        call.end();
      });
      appStream.on('error', (error: Error) => close(error));
      call.on('data', (message: unknown) => {
        if (!appStream.write(message)) call.pause();
      });
      appStream.on('drain', () => call.resume());
      call.resume();
    })().catch((error) => close(error instanceof Error ? error : statusError(grpc.status.UNAVAILABLE, 'Relay failed')));
  }
}
