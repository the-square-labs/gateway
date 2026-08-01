import crypto from 'node:crypto';
import { Duplex } from 'node:stream';
import type { ServerDuplexStream } from '@grpc/grpc-js';
import { and, eq } from 'drizzle-orm';
import { managedDatabaseBindings, managedDatabaseInstances, nodes } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { extractDaemonCertificateIdentity, normalizeCertificateSerial } from '../interceptors/auth.js';
import type { GrpcServerDeps } from '../server.js';

const logger = createChildLogger('GrpcDatabaseTunnel');
const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_SAFE_MESSAGE_LENGTH = 256;
const MAX_TUNNEL_SESSIONS_PER_BINDING = 16;
const MAX_TUNNEL_SESSIONS_PER_SOURCE_NODE = 64;
const MAX_TUNNEL_SESSIONS_PER_DATABASE_NODE = 256;
const MAX_TUNNEL_SESSIONS_FROM_GATEWAY = 64;
export const DATABASE_TUNNEL_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const TUNNEL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DatabaseTunnelHello {
  nodeId: string;
  capability: string;
  maxChunkBytes: number;
}

interface DatabaseTunnelOpen {
  tunnelId: string;
  bindingId: string;
  managedDatabaseId: string;
}

interface DatabaseTunnelData {
  tunnelId: string;
  bindingId: string;
  data: Buffer | Uint8Array;
}

interface DatabaseTunnelClose {
  tunnelId: string;
  bindingId: string;
}

interface DatabaseTunnelError extends DatabaseTunnelClose {
  code: string;
  message: string;
}

export interface DatabaseTunnelMessage {
  hello?: DatabaseTunnelHello;
  ready?: { maxChunkBytes: number };
  open?: DatabaseTunnelOpen;
  data?: DatabaseTunnelData;
  close?: DatabaseTunnelClose;
  error?: DatabaseTunnelError;
}

type DatabaseTunnelStream = ServerDuplexStream<DatabaseTunnelMessage, DatabaseTunnelMessage>;

interface RelayTunnelStream {
  write(message: DatabaseTunnelMessage): boolean;
  pause(): void;
  resume(): void;
  once(event: 'drain', listener: () => void): RelayTunnelStream;
  end?(): void;
}

interface TunnelConnection {
  nodeId: string;
  nodeType: 'docker' | 'databases' | 'gateway';
  stream: RelayTunnelStream;
  maxChunkBytes: number;
}

interface TunnelSession {
  tunnelId: string;
  bindingId: string;
  managedDatabaseId: string;
  source: TunnelConnection;
  target: TunnelConnection;
  idleTimer?: ReturnType<typeof setTimeout>;
}

function safeProtocolMessage(message: string): string {
  return message.replace(/[\r\n\t]/g, ' ').slice(0, MAX_SAFE_MESSAGE_LENGTH);
}

/**
 * A backend-only endpoint for the normal database driver clients. Its frames
 * travel over the same authenticated relay as an application binding; it is
 * never exposed as a daemon or public TCP peer.
 */
class GatewayTunnelDuplex extends Duplex {
  private tunnelClosed = false;

  constructor(
    private readonly send: (data: Buffer, callback: (error?: Error | null) => void) => void,
    private readonly closeTunnel: () => void
  ) {
    super();
  }

  readonly relayStream: RelayTunnelStream = {
    write: (message) => {
      if (message.data) this.push(Buffer.from(message.data.data));
      else if (message.error) this.destroy(new Error(safeProtocolMessage(message.error.message)));
      else if (message.close) this.push(null);
      return true;
    },
    pause: () => {},
    resume: () => {},
    once: () => this.relayStream,
  };

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.send(Buffer.from(chunk), callback);
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
    this.closeTunnel();
  }
}

export class DatabaseTunnelRelay {
  private connections = new Map<string, TunnelConnection>();
  private sessions = new Map<string, TunnelSession>();

  constructor(private readonly deps: Pick<GrpcServerDeps, 'db'>) {}

  register(connection: TunnelConnection): void {
    const previous = this.connections.get(connection.nodeId);
    if (previous && previous.stream !== connection.stream) {
      this.disconnect(connection.nodeId, previous.stream);
      previous.stream.end?.();
    }
    this.connections.set(connection.nodeId, connection);
  }

  disconnect(nodeId: string, stream: RelayTunnelStream): void {
    if (this.connections.get(nodeId)?.stream === stream) this.connections.delete(nodeId);
    for (const session of [...this.sessions.values()]) {
      if (session.source.stream !== stream && session.target.stream !== stream) continue;
      const peer = session.source.stream === stream ? session.target : session.source;
      this.removeSession(session);
      this.write(peer, {
        error: {
          tunnelId: session.tunnelId,
          bindingId: session.bindingId,
          code: 'PEER_DISCONNECTED',
          message: 'Database tunnel peer disconnected',
        },
      });
    }
  }

  /**
   * Immediately terminate every live stream for a binding. This is used by
   * binding deletion so revocation does not wait for Docker cleanup or a
   * source-daemon command round-trip.
   */
  revokeBinding(bindingId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.bindingId !== bindingId) continue;
      this.removeSession(session);
      const frame = {
        error: {
          tunnelId: session.tunnelId,
          bindingId: session.bindingId,
          code: 'BINDING_REVOKED',
          message: 'Database binding was removed',
        },
      };
      this.write(session.source, frame);
      this.write(session.target, frame);
    }
  }

  async handleOpen(sourceNodeId: string, open: DatabaseTunnelOpen): Promise<void> {
    const source = this.connections.get(sourceNodeId);
    if (!source || source.nodeType !== 'docker') return;
    if (!TUNNEL_ID_RE.test(open.tunnelId) || !UUID_RE.test(open.bindingId) || !UUID_RE.test(open.managedDatabaseId)) {
      this.writeError(source, open, 'INVALID_OPEN', 'Database tunnel identifiers are invalid');
      return;
    }
    if (this.sessions.has(open.tunnelId)) {
      this.writeError(source, open, 'TUNNEL_EXISTS', 'Database tunnel identifier is already active');
      return;
    }

    const [authorized] = await this.deps.db
      .select({
        bindingId: managedDatabaseBindings.id,
        targetNodeId: managedDatabaseBindings.targetNodeId,
        bindingStatus: managedDatabaseBindings.status,
        managedDatabaseId: managedDatabaseInstances.id,
        databaseNodeId: managedDatabaseInstances.nodeId,
        databaseStatus: managedDatabaseInstances.status,
      })
      .from(managedDatabaseBindings)
      .innerJoin(managedDatabaseInstances, eq(managedDatabaseBindings.managedDatabaseId, managedDatabaseInstances.id))
      .where(
        and(
          eq(managedDatabaseBindings.id, open.bindingId),
          eq(managedDatabaseBindings.managedDatabaseId, open.managedDatabaseId)
        )
      )
      .limit(1);

    if (
      !authorized ||
      authorized.targetNodeId !== sourceNodeId ||
      authorized.bindingStatus !== 'ready' ||
      authorized.databaseStatus !== 'ready'
    ) {
      this.writeError(source, open, 'BINDING_NOT_AUTHORIZED', 'Database binding is not active for this node');
      return;
    }

    if (this.connections.get(sourceNodeId) !== source) return;

    const target = this.connections.get(authorized.databaseNodeId);
    if (!target || target.nodeType !== 'databases') {
      this.writeError(source, open, 'DATABASE_NODE_UNAVAILABLE', 'Managed database node is unavailable');
      return;
    }

    if (this.sessionCount((session) => session.bindingId === authorized.bindingId) >= MAX_TUNNEL_SESSIONS_PER_BINDING) {
      this.writeError(source, open, 'RESOURCE_EXHAUSTED', 'Database binding session limit reached');
      return;
    }
    if (this.sessionCount((session) => session.source.nodeId === sourceNodeId) >= MAX_TUNNEL_SESSIONS_PER_SOURCE_NODE) {
      this.writeError(source, open, 'RESOURCE_EXHAUSTED', 'Source node database tunnel session limit reached');
      return;
    }
    if (
      this.sessionCount((session) => session.target.nodeId === authorized.databaseNodeId) >=
      MAX_TUNNEL_SESSIONS_PER_DATABASE_NODE
    ) {
      this.writeError(source, open, 'RESOURCE_EXHAUSTED', 'Database node tunnel session limit reached');
      return;
    }

    const session: TunnelSession = {
      tunnelId: open.tunnelId,
      bindingId: authorized.bindingId,
      managedDatabaseId: authorized.managedDatabaseId,
      source,
      target,
    };
    this.addSession(session);
    try {
      const accepted = target.stream.write({ open });
      if (!accepted) {
        source.stream.pause();
        target.stream.once('drain', () => {
          if (this.sessions.get(session.tunnelId) === session) source.stream.resume();
        });
      }
    } catch {
      this.removeSession(session);
      this.writeError(source, open, 'DATABASE_NODE_UNAVAILABLE', 'Managed database node is unavailable');
    }
  }

  async openGatewayTunnel(managedDatabaseId: string): Promise<Duplex> {
    if (!UUID_RE.test(managedDatabaseId)) throw new Error('Managed database identifier is invalid');
    const [managed] = await this.deps.db
      .select({
        id: managedDatabaseInstances.id,
        nodeId: managedDatabaseInstances.nodeId,
        status: managedDatabaseInstances.status,
      })
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.id, managedDatabaseId))
      .limit(1);
    if (!managed || managed.status !== 'ready') throw new Error('Managed database is not ready');

    const target = this.connections.get(managed.nodeId);
    if (!target || target.nodeType !== 'databases') throw new Error('Managed database node is unavailable');
    if (this.sessionCount((session) => session.source.nodeType === 'gateway') >= MAX_TUNNEL_SESSIONS_FROM_GATEWAY) {
      throw new Error('Gateway managed database tunnel capacity reached');
    }
    if (
      this.sessionCount((session) => session.target.nodeId === managed.nodeId) >= MAX_TUNNEL_SESSIONS_PER_DATABASE_NODE
    ) {
      throw new Error('Managed database node tunnel capacity reached');
    }

    const open: DatabaseTunnelOpen = {
      tunnelId: crypto.randomBytes(18).toString('base64url'),
      bindingId: crypto.randomUUID(),
      managedDatabaseId,
    };
    let session: TunnelSession | null = null;
    const client = new GatewayTunnelDuplex(
      (data, callback) => {
        if (!session) {
          callback(new Error('Managed database tunnel is not open'));
          return;
        }
        this.handleGatewayData(session, data, callback);
      },
      () => {
        if (session) this.handleGatewayClose(session);
      }
    );
    const source: TunnelConnection = {
      nodeId: `gateway:${open.tunnelId}`,
      nodeType: 'gateway',
      stream: client.relayStream,
      maxChunkBytes: MAX_CHUNK_BYTES,
    };
    session = { tunnelId: open.tunnelId, bindingId: open.bindingId, managedDatabaseId, source, target };
    this.addSession(session);
    if (!this.write(target, { open })) {
      this.removeSession(session);
      client.destroy(new Error('Managed database node is unavailable'));
    }
    return client;
  }

  handleData(nodeId: string, data: DatabaseTunnelData): void {
    const session = this.sessions.get(data.tunnelId);
    const sender = this.connections.get(nodeId);
    if (!sender || !session || session.bindingId !== data.bindingId) {
      if (sender) this.writeError(sender, data, 'TUNNEL_NOT_FOUND', 'Database tunnel is not active');
      return;
    }
    const recipient =
      session.source.nodeId === nodeId ? session.target : session.target.nodeId === nodeId ? session.source : null;
    if (!recipient) {
      this.writeError(sender, data, 'TUNNEL_NOT_AUTHORIZED', 'Database tunnel is not authorized for this node');
      return;
    }
    this.refreshIdleTimer(session);
    const size = data.data?.byteLength ?? 0;
    if (size <= 0 || size > sender.maxChunkBytes || size > recipient.maxChunkBytes || size > MAX_CHUNK_BYTES) {
      this.terminate(session, sender, 'FRAME_TOO_LARGE', 'Database tunnel data frame exceeds the negotiated limit');
      return;
    }

    let accepted = false;
    try {
      accepted = recipient.stream.write({ data });
    } catch {
      this.terminate(session, sender, 'PEER_DISCONNECTED', 'Database tunnel peer disconnected');
      return;
    }
    if (!accepted) {
      sender.stream.pause();
      recipient.stream.once('drain', () => {
        if (this.sessions.get(session.tunnelId) === session) sender.stream.resume();
      });
    }
  }

  handleClose(nodeId: string, close: DatabaseTunnelClose): void {
    const session = this.sessions.get(close.tunnelId);
    if (!session || session.bindingId !== close.bindingId) return;
    const peer =
      session.source.nodeId === nodeId ? session.target : session.target.nodeId === nodeId ? session.source : null;
    if (!peer) return;
    this.removeSession(session);
    this.write(peer, { close });
  }

  handleError(nodeId: string, error: DatabaseTunnelError): void {
    const session = this.sessions.get(error.tunnelId);
    if (!session || session.bindingId !== error.bindingId) return;
    const peer =
      session.source.nodeId === nodeId ? session.target : session.target.nodeId === nodeId ? session.source : null;
    if (!peer) return;
    this.removeSession(session);
    this.write(peer, {
      error: {
        tunnelId: error.tunnelId,
        bindingId: error.bindingId,
        code: /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'PEER_ERROR',
        message: safeProtocolMessage(error.message || 'Database tunnel peer failed'),
      },
    });
  }

  private handleGatewayData(session: TunnelSession, data: Buffer, callback: (error?: Error | null) => void): void {
    if (this.sessions.get(session.tunnelId) !== session) {
      callback(new Error('Managed database tunnel is not active'));
      return;
    }
    if (data.byteLength <= 0 || data.byteLength > MAX_CHUNK_BYTES || data.byteLength > session.target.maxChunkBytes) {
      this.terminate(
        session,
        session.source,
        'FRAME_TOO_LARGE',
        'Database tunnel data frame exceeds the negotiated limit'
      );
      callback(new Error('Managed database tunnel data frame exceeds the negotiated limit'));
      return;
    }
    this.refreshIdleTimer(session);
    try {
      const accepted = session.target.stream.write({
        data: { tunnelId: session.tunnelId, bindingId: session.bindingId, data },
      });
      if (accepted) callback();
      else {
        session.target.stream.once('drain', () => {
          callback(
            this.sessions.get(session.tunnelId) === session ? null : new Error('Managed database tunnel closed')
          );
        });
      }
    } catch {
      this.terminate(session, session.source, 'PEER_DISCONNECTED', 'Managed database node is unavailable');
      callback(new Error('Managed database node is unavailable'));
    }
  }

  private handleGatewayClose(session: TunnelSession): void {
    if (!this.removeSession(session)) return;
    this.write(session.target, { close: { tunnelId: session.tunnelId, bindingId: session.bindingId } });
  }

  private terminate(session: TunnelSession, sender: TunnelConnection, code: string, message: string): void {
    if (!this.removeSession(session)) return;
    const frame = { error: { tunnelId: session.tunnelId, bindingId: session.bindingId, code, message } };
    this.write(sender, frame);
    this.write(sender === session.source ? session.target : session.source, frame);
  }

  private addSession(session: TunnelSession): void {
    this.sessions.set(session.tunnelId, session);
    this.refreshIdleTimer(session);
  }

  private removeSession(session: TunnelSession): boolean {
    if (this.sessions.get(session.tunnelId) !== session) return false;
    this.sessions.delete(session.tunnelId);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    return true;
  }

  private refreshIdleTimer(session: TunnelSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      this.terminate(session, session.source, 'IDLE_TIMEOUT', 'Database tunnel session was idle for too long');
    }, DATABASE_TUNNEL_IDLE_TIMEOUT_MS);
    session.idleTimer.unref?.();
  }

  private sessionCount(matches: (session: TunnelSession) => boolean): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (matches(session)) count += 1;
    }
    return count;
  }

  private writeError(
    connection: TunnelConnection,
    ids: Pick<DatabaseTunnelOpen, 'tunnelId' | 'bindingId'>,
    code: string,
    message: string
  ): void {
    this.write(connection, { error: { tunnelId: ids.tunnelId, bindingId: ids.bindingId, code, message } });
  }

  private write(connection: TunnelConnection, message: DatabaseTunnelMessage): boolean {
    try {
      return connection.stream.write(message);
    } catch {
      return false;
    }
  }
}

let activeRelay: DatabaseTunnelRelay | null = null;

export function revokeDatabaseTunnelBinding(bindingId: string): void {
  activeRelay?.revokeBinding(bindingId);
}

export async function openGatewayManagedDatabaseTunnel(managedDatabaseId: string): Promise<Duplex> {
  if (!activeRelay) throw new Error('Managed database tunnel relay is unavailable');
  return activeRelay.openGatewayTunnel(managedDatabaseId);
}

export function createDatabaseTunnelHandlers(deps: GrpcServerDeps) {
  const relay = new DatabaseTunnelRelay(deps);
  activeRelay = relay;
  return {
    Tunnel(stream: DatabaseTunnelStream) {
      let nodeId: string | null = null;
      let nodeType: 'docker' | 'databases' | null = null;
      let authenticatedNodeId: string | null = null;
      let closed = false;
      let processing = Promise.resolve();
      stream.pause();

      const close = () => {
        if (closed) return;
        closed = true;
        if (nodeId) relay.disconnect(nodeId, stream);
      };
      stream.on('end', () => {
        close();
        stream.end();
      });
      stream.on('error', close);
      stream.on('data', (message: DatabaseTunnelMessage) => {
        if (closed) return;
        processing = processing
          .then(async () => {
            if (!nodeId) {
              const hello = message.hello;
              if (
                !hello ||
                hello.nodeId !== authenticatedNodeId ||
                hello.capability !== 'database_tunnel_v1' ||
                !Number.isInteger(hello.maxChunkBytes) ||
                hello.maxChunkBytes <= 0
              ) {
                throw new Error('invalid database tunnel hello');
              }
              if (!nodeType) throw new Error('database tunnel node type is unavailable');

              // Keep authenticated daemon streams available before their first
              // binding is ready. Gating this on a ready binding deadlocks
              // provisioning: creating that binding needs this stream first.
              // Data-plane authorization remains enforced by handleOpen for
              // the exact ready binding and target node.
              nodeId = hello.nodeId;
              const maxChunkBytes = Math.min(MAX_CHUNK_BYTES, hello.maxChunkBytes);
              relay.register({ nodeId, nodeType, stream, maxChunkBytes });
              stream.write({ ready: { maxChunkBytes } });
              logger.debug('Database tunnel stream opened', { nodeId, nodeType });
              return;
            }
            if (message.open) await relay.handleOpen(nodeId, message.open);
            else if (message.data) relay.handleData(nodeId, message.data);
            else if (message.close) relay.handleClose(nodeId, message.close);
            else if (message.error) relay.handleError(nodeId, message.error);
            else throw new Error('unexpected database tunnel frame');
          })
          .catch((error) => {
            logger.warn('Database tunnel stream rejected', {
              nodeId,
              error: error instanceof Error ? error.message : String(error),
            });
            close();
            stream.end();
          });
      });

      void (async () => {
        const identity = extractDaemonCertificateIdentity(stream as never);
        if (!identity) throw new Error('missing authorized daemon certificate');
        const connected = deps.registry.getNode(identity.nodeId);
        if (!connected || (connected.type !== 'docker' && connected.type !== 'databases')) {
          throw new Error('node does not support managed database tunnels');
        }
        const [node] = await deps.db
          .select({ certificateSerial: nodes.certificateSerial, status: nodes.status, type: nodes.type })
          .from(nodes)
          .where(eq(nodes.id, identity.nodeId))
          .limit(1);
        if (
          !node ||
          node.status === 'pending' ||
          node.type !== connected.type ||
          (node.type !== 'docker' && node.type !== 'databases') ||
          !node.certificateSerial ||
          normalizeCertificateSerial(node.certificateSerial) !== identity.serialNumber
        ) {
          throw new Error('daemon certificate does not match the enrolled tunnel node');
        }
        authenticatedNodeId = identity.nodeId;
        nodeType = node.type;
        stream.resume();
      })().catch((error) => {
        logger.warn('Database tunnel stream authentication rejected', {
          error: error instanceof Error ? error.message : String(error),
        });
        close();
        stream.end();
      });
    },
  };
}
