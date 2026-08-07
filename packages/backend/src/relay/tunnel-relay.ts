import crypto from 'node:crypto';
import { Duplex } from 'node:stream';
import type { RelayAuthorizationRepository } from './authorization-repository.js';
import {
  type DatabaseTunnelMessage,
  RELAY_IDLE_TIMEOUT_MS,
  RELAY_MAX_CHUNK_BYTES,
  type RelayManagedDatabaseLane,
  type RelayNodeType,
  type RelayStream,
  type RelayTunnelLane,
} from './protocol.js';

const MAX_SAFE_MESSAGE_LENGTH = 256;
const MAX_TUNNEL_SESSIONS_PER_BINDING = 16;
const MAX_TUNNEL_SESSIONS_PER_SOURCE_NODE = 64;
const MAX_TUNNEL_SESSIONS_PER_DATABASE_NODE = 256;
const MAX_TUNNEL_SESSIONS_FROM_APP = 64;
const TUNNEL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DATABASE_TUNNEL_CAPABILITY_V2_PREFIX = 'database_tunnel_v2:';

export interface RelayTunnelConnection {
  nodeId: string;
  nodeType: RelayNodeType | 'gateway';
  lane: RelayTunnelLane;
  bindingId?: string;
  stream: RelayStream;
  maxChunkBytes: number;
}

interface RelayTunnelSession {
  tunnelId: string;
  bindingId: string;
  managedDatabaseId: string;
  source: RelayTunnelConnection;
  target: RelayTunnelConnection;
  idleTimer?: ReturnType<typeof setTimeout>;
}

type OpenFrame = NonNullable<DatabaseTunnelMessage['open']>;
type DataFrame = NonNullable<DatabaseTunnelMessage['data']>;
type CloseFrame = NonNullable<DatabaseTunnelMessage['close']>;
type ErrorFrame = NonNullable<DatabaseTunnelMessage['error']>;

export function parseDatabaseTunnelCapability(
  capability: string
): Pick<RelayTunnelConnection, 'lane' | 'bindingId'> | null {
  if (!capability.startsWith(DATABASE_TUNNEL_CAPABILITY_V2_PREFIX)) return null;
  const value = capability.slice(DATABASE_TUNNEL_CAPABILITY_V2_PREFIX.length);
  if (value === 'interactive' || value === 'monitoring') return { lane: value };
  const bindingId = value.startsWith('data:') ? value.slice('data:'.length) : '';
  return UUID_RE.test(bindingId) ? { lane: 'data', bindingId } : null;
}

function safeProtocolMessage(message: string): string {
  return message.replace(/[\r\n\t]/g, ' ').slice(0, MAX_SAFE_MESSAGE_LENGTH);
}

class AppTunnelDuplex extends Duplex {
  private tunnelClosed = false;

  constructor(
    readonly relayStream: RelayStream,
    private readonly send: (data: Buffer, callback: (error?: Error | null) => void) => void,
    private readonly closeTunnel: () => void
  ) {
    super();
  }

  _read(): void {
    this.relayStream.resume();
  }

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

export interface RelayTunnelStats {
  connections: number;
  sessions: number;
  activeBindingIds: string[];
}

/** Stateful data-plane engine. It deliberately depends only on the versioned
 * read-only authorization repository and stream primitives, never app state. */
export class StandaloneDatabaseTunnelRelay {
  private readonly connections = new Map<string, Map<string, RelayTunnelConnection>>();
  private readonly sessions = new Map<string, RelayTunnelSession>();

  constructor(private readonly authorization: RelayAuthorizationRepository) {}

  register(connection: RelayTunnelConnection): void {
    const nodeConnections = this.connections.get(connection.nodeId) ?? new Map<string, RelayTunnelConnection>();
    const key = this.connectionKey(connection);
    const previous = nodeConnections.get(key);
    if (previous && previous.stream !== connection.stream) {
      this.disconnect(previous);
      previous.stream.end?.();
    }
    nodeConnections.set(key, connection);
    this.connections.set(connection.nodeId, nodeConnections);
  }

  disconnect(connection: RelayTunnelConnection): void {
    const nodeConnections = this.connections.get(connection.nodeId);
    const key = this.connectionKey(connection);
    if (nodeConnections?.get(key)?.stream === connection.stream) {
      nodeConnections.delete(key);
      if (nodeConnections.size === 0) this.connections.delete(connection.nodeId);
    }
    for (const session of [...this.sessions.values()]) {
      if (session.source !== connection && session.target !== connection) continue;
      const peer = session.source === connection ? session.target : session.source;
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

  revokeBinding(bindingId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.bindingId !== bindingId) continue;
      this.removeSession(session);
      const frame: DatabaseTunnelMessage = {
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

  async reconcileBindings(): Promise<void> {
    const active = this.getActiveBindingIds();
    if (active.length === 0) return;
    const ready = await this.authorization.readyBindingIds(active);
    for (const bindingId of active) {
      if (!ready.has(bindingId)) this.revokeBinding(bindingId);
    }
  }

  getStats(): RelayTunnelStats {
    let connections = 0;
    for (const item of this.connections.values()) connections += item.size;
    return { connections, sessions: this.sessions.size, activeBindingIds: this.getActiveBindingIds() };
  }

  async handleOpen(source: RelayTunnelConnection, open: OpenFrame): Promise<void> {
    if (source.nodeType !== 'docker' || source.lane !== 'data' || source.bindingId !== open.bindingId) {
      this.writeError(source, open, 'BINDING_NOT_AUTHORIZED', 'Database tunnel binding does not match this stream');
      return;
    }
    if (!TUNNEL_ID_RE.test(open.tunnelId) || !UUID_RE.test(open.bindingId) || !UUID_RE.test(open.managedDatabaseId)) {
      this.writeError(source, open, 'INVALID_OPEN', 'Database tunnel identifiers are invalid');
      return;
    }
    if (this.sessions.has(open.tunnelId)) {
      this.writeError(source, open, 'TUNNEL_EXISTS', 'Database tunnel identifier is already active');
      return;
    }

    const authorized = await this.authorization.authorizeBinding(open.bindingId, open.managedDatabaseId, source.nodeId);
    if (!authorized) {
      this.writeError(source, open, 'BINDING_NOT_AUTHORIZED', 'Database binding is not active for this node');
      return;
    }
    if (!this.isRegistered(source)) return;
    const target = this.getConnection(authorized.databaseNodeId, 'data', authorized.bindingId);
    if (!target || target.nodeType !== 'databases') {
      this.writeError(source, open, 'DATABASE_NODE_UNAVAILABLE', 'Managed database node is unavailable');
      return;
    }
    if (this.sessionCount((session) => session.bindingId === authorized.bindingId) >= MAX_TUNNEL_SESSIONS_PER_BINDING) {
      this.writeError(source, open, 'RESOURCE_EXHAUSTED', 'Database binding session limit reached');
      return;
    }
    if (
      this.sessionCount((session) => session.source.nodeId === source.nodeId) >= MAX_TUNNEL_SESSIONS_PER_SOURCE_NODE
    ) {
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

    const session: RelayTunnelSession = {
      tunnelId: open.tunnelId,
      bindingId: authorized.bindingId,
      managedDatabaseId: authorized.managedDatabaseId,
      source,
      target,
    };
    this.addSession(session);
    if (!this.write(target, { open })) {
      this.removeSession(session);
      this.writeError(source, open, 'DATABASE_NODE_UNAVAILABLE', 'Managed database node is unavailable');
    }
  }

  async openAppTunnel(managedDatabaseId: string, lane: RelayManagedDatabaseLane = 'interactive'): Promise<Duplex> {
    if (!UUID_RE.test(managedDatabaseId)) throw new Error('Managed database identifier is invalid');
    const managed = await this.authorization.authorizeManagedDatabase(managedDatabaseId);
    if (!managed) throw new Error('Managed database is not ready');
    const target = this.getConnection(managed.databaseNodeId, lane);
    if (!target || target.nodeType !== 'databases') throw new Error('Managed database node is unavailable');
    if (this.sessionCount((session) => session.source.nodeType === 'gateway') >= MAX_TUNNEL_SESSIONS_FROM_APP) {
      throw new Error('Gateway managed database tunnel capacity reached');
    }
    if (
      this.sessionCount((session) => session.target.nodeId === managed.databaseNodeId) >=
      MAX_TUNNEL_SESSIONS_PER_DATABASE_NODE
    ) {
      throw new Error('Managed database node tunnel capacity reached');
    }

    const open: OpenFrame = {
      tunnelId: crypto.randomBytes(18).toString('base64url'),
      bindingId: crypto.randomUUID(),
      managedDatabaseId,
    };
    let session: RelayTunnelSession | null = null;
    let client!: AppTunnelDuplex;
    let readableBlocked = false;
    let readableDrain: (() => void) | null = null;
    const relayStream: RelayStream = {
      write: (message) => {
        if (message.data) {
          const accepted = client.push(Buffer.from(message.data.data));
          readableBlocked = !accepted;
          return accepted;
        }
        if (message.error) client.destroy(new Error(safeProtocolMessage(message.error.message)));
        else if (message.close) client.push(null);
        return true;
      },
      pause: () => {},
      resume: () => {
        if (!readableBlocked) return;
        readableBlocked = false;
        const listener = readableDrain;
        readableDrain = null;
        listener?.();
      },
      once: (_event, listener) => {
        if (readableBlocked) readableDrain = listener;
        else queueMicrotask(listener);
        return relayStream;
      },
    };
    client = new AppTunnelDuplex(
      relayStream,
      (data, callback) => {
        if (!session) return callback(new Error('Managed database tunnel is not open'));
        this.handleAppData(session, data, callback);
      },
      () => {
        if (session) this.handleAppClose(session);
      }
    );
    const source: RelayTunnelConnection = {
      nodeId: `gateway:${open.tunnelId}`,
      nodeType: 'gateway',
      lane,
      stream: relayStream,
      maxChunkBytes: RELAY_MAX_CHUNK_BYTES,
    };
    session = { tunnelId: open.tunnelId, bindingId: open.bindingId, managedDatabaseId, source, target };
    this.addSession(session);
    if (!this.write(target, { open })) {
      this.removeSession(session);
      client.destroy(new Error('Managed database node is unavailable'));
    }
    return client;
  }

  handleData(sender: RelayTunnelConnection, data: DataFrame): void {
    const session = this.sessions.get(data.tunnelId);
    if (!session || session.bindingId !== data.bindingId) {
      this.writeError(sender, data, 'TUNNEL_NOT_FOUND', 'Database tunnel is not active');
      return;
    }
    const recipient = session.source === sender ? session.target : session.target === sender ? session.source : null;
    if (!recipient) {
      this.writeError(sender, data, 'TUNNEL_NOT_AUTHORIZED', 'Database tunnel is not authorized for this node');
      return;
    }
    this.refreshIdleTimer(session);
    const size = data.data?.byteLength ?? 0;
    if (size <= 0 || size > sender.maxChunkBytes || size > recipient.maxChunkBytes || size > RELAY_MAX_CHUNK_BYTES) {
      this.terminate(session, sender, 'FRAME_TOO_LARGE', 'Database tunnel data frame exceeds the negotiated limit');
      return;
    }
    try {
      if (!recipient.stream.write({ data })) {
        sender.stream.pause();
        recipient.stream.once('drain', () => {
          if (this.sessions.get(session.tunnelId) === session) sender.stream.resume();
        });
      }
    } catch {
      this.terminate(session, sender, 'PEER_DISCONNECTED', 'Database tunnel peer disconnected');
    }
  }

  handleClose(sender: RelayTunnelConnection, close: CloseFrame): void {
    const session = this.sessions.get(close.tunnelId);
    if (!session || session.bindingId !== close.bindingId) return;
    const peer = session.source === sender ? session.target : session.target === sender ? session.source : null;
    if (!peer) return;
    this.removeSession(session);
    this.write(peer, { close });
  }

  handleError(sender: RelayTunnelConnection, error: ErrorFrame): void {
    const session = this.sessions.get(error.tunnelId);
    if (!session || session.bindingId !== error.bindingId) return;
    const peer = session.source === sender ? session.target : session.target === sender ? session.source : null;
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

  private getActiveBindingIds(): string[] {
    return [
      ...new Set(
        [...this.sessions.values()]
          .filter((session) => session.source.nodeType === 'docker')
          .map((session) => session.bindingId)
      ),
    ];
  }

  private handleAppData(session: RelayTunnelSession, data: Buffer, callback: (error?: Error | null) => void): void {
    if (this.sessions.get(session.tunnelId) !== session) {
      callback(new Error('Managed database tunnel closed'));
      return;
    }
    if (
      data.byteLength <= 0 ||
      data.byteLength > RELAY_MAX_CHUNK_BYTES ||
      data.byteLength > session.target.maxChunkBytes
    ) {
      this.terminate(session, session.source, 'FRAME_TOO_LARGE', 'Database tunnel data frame exceeds the limit');
      callback(new Error('Managed database tunnel data frame exceeds the negotiated limit'));
      return;
    }
    this.refreshIdleTimer(session);
    try {
      if (
        session.target.stream.write({
          data: { tunnelId: session.tunnelId, bindingId: session.bindingId, data },
        })
      ) {
        callback();
      } else {
        session.target.stream.once('drain', () =>
          callback(this.sessions.get(session.tunnelId) === session ? null : new Error('Managed database tunnel closed'))
        );
      }
    } catch {
      this.terminate(session, session.source, 'PEER_DISCONNECTED', 'Managed database node is unavailable');
      callback(new Error('Managed database node is unavailable'));
    }
  }

  private handleAppClose(session: RelayTunnelSession): void {
    if (!this.removeSession(session)) return;
    this.write(session.target, { close: { tunnelId: session.tunnelId, bindingId: session.bindingId } });
  }

  private terminate(session: RelayTunnelSession, sender: RelayTunnelConnection, code: string, message: string): void {
    if (!this.removeSession(session)) return;
    const frame: DatabaseTunnelMessage = {
      error: { tunnelId: session.tunnelId, bindingId: session.bindingId, code, message },
    };
    this.write(sender, frame);
    this.write(sender === session.source ? session.target : session.source, frame);
  }

  private addSession(session: RelayTunnelSession): void {
    this.sessions.set(session.tunnelId, session);
    this.refreshIdleTimer(session);
  }

  private removeSession(session: RelayTunnelSession): boolean {
    if (this.sessions.get(session.tunnelId) !== session) return false;
    this.sessions.delete(session.tunnelId);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    return true;
  }

  private refreshIdleTimer(session: RelayTunnelSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(
      () => this.terminate(session, session.source, 'IDLE_TIMEOUT', 'Database tunnel session was idle for too long'),
      RELAY_IDLE_TIMEOUT_MS
    );
    session.idleTimer.unref?.();
  }

  private sessionCount(predicate: (session: RelayTunnelSession) => boolean): number {
    let count = 0;
    for (const session of this.sessions.values()) if (predicate(session)) count += 1;
    return count;
  }

  private writeError(
    connection: RelayTunnelConnection,
    ids: Pick<OpenFrame, 'tunnelId' | 'bindingId'>,
    code: string,
    message: string
  ): void {
    this.write(connection, { error: { tunnelId: ids.tunnelId, bindingId: ids.bindingId, code, message } });
  }

  private write(connection: RelayTunnelConnection, message: DatabaseTunnelMessage): boolean {
    try {
      return connection.stream.write(message);
    } catch {
      return false;
    }
  }

  private connectionKey(connection: Pick<RelayTunnelConnection, 'lane' | 'bindingId'>): string {
    return connection.lane === 'data' ? `data:${connection.bindingId ?? ''}` : connection.lane;
  }

  private getConnection(nodeId: string, lane: RelayTunnelLane, bindingId?: string): RelayTunnelConnection | undefined {
    const key = lane === 'data' ? `data:${bindingId ?? ''}` : lane;
    return this.connections.get(nodeId)?.get(key);
  }

  private isRegistered(connection: RelayTunnelConnection): boolean {
    return this.connections.get(connection.nodeId)?.get(this.connectionKey(connection)) === connection;
  }
}
