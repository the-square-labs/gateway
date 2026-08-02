import type { WSContext } from 'hono/ws';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { resolveWebSocketCredential, type WebSocketCredential } from '@/modules/auth/websocket-auth.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { type ManagedDatabaseLogTarget, ManagedDatabaseService } from './managed-databases.service.js';

const logger = createChildLogger('ManagedDatabaseLogStream');
const DOCKER_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s/;
const BATCH_SIZE = 200;

interface ManagedLogStreamState {
  authenticated: boolean;
  target: ManagedDatabaseLogTarget | null;
  handlerKey: string | null;
  oldestTimestamp?: string;
  loadingMore: boolean;
  keepaliveInterval: ReturnType<typeof setInterval> | null;
}

const states = new WeakMap<WSContext, ManagedLogStreamState>();

function send(ws: WSContext, message: Record<string, unknown>) {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The socket may already be closed.
  }
}

function extractTimestamp(line: string | undefined): string | undefined {
  return line?.match(DOCKER_TS_RE)?.[1];
}

function decrementTimestamp(timestamp: string): string {
  const match = timestamp.match(/^(.+\.)(\d+)Z$/);
  if (!match) return timestamp;
  const nanos = BigInt(match[2].padEnd(9, '0')) - 1n;
  return nanos < 0n ? timestamp : `${match[1]}${nanos.toString().padStart(9, '0')}Z`;
}

async function authorize(credential: WebSocketCredential | null, databaseId: string) {
  return resolveWebSocketCredential(credential, `databases:view:${databaseId}`);
}

export function createManagedDatabaseLogStreamWSHandlers(
  databaseId: string,
  tail: number,
  credential: WebSocketCredential | null
) {
  const databases = container.resolve(ManagedDatabaseService);
  const dispatch = container.resolve(NodeDispatchService);
  const registry = container.resolve(NodeRegistryService);

  const stopStream = (state: ManagedLogStreamState) => {
    if (!state.handlerKey) return;
    registry.removeLogStreamHandler(state.handlerKey);
    state.handlerKey = null;
    if (!state.target) return;
    void dispatch.stopManagedDatabaseLogStream(state.target.nodeId, state.target.managedDatabaseId).catch((error) => {
      logger.debug('Failed to stop managed database log stream', {
        databaseId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const cleanup = (ws: WSContext) => {
    const state = states.get(ws);
    if (!state) return;
    stopStream(state);
    if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
    states.delete(ws);
  };

  const revalidate = async (ws: WSContext, state: ManagedLogStreamState, emitPong = false) => {
    const auth = await authorize(credential, databaseId);
    if (!auth) {
      state.authenticated = false;
      stopStream(state);
      send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
      ws.close(1008, 'Authentication failed');
      return false;
    }
    if (!state.target || !registry.getNode(state.target.nodeId)) {
      stopStream(state);
      send(ws, { type: 'error', message: 'Database node is not connected' });
      ws.close(1011, 'Node not connected');
      return false;
    }
    if (emitPong) send(ws, { type: 'pong' });
    return true;
  };

  const loadMore = async (ws: WSContext, state: ManagedLogStreamState) => {
    try {
      if (!state.oldestTimestamp) {
        send(ws, { type: 'history', lines: [], hasMore: false });
        return;
      }
      const lines = await databases.getLogs(databaseId, {
        tailLines: BATCH_SIZE,
        follow: false,
        timestamps: true,
        until: decrementTimestamp(state.oldestTimestamp),
      });
      state.oldestTimestamp = extractTimestamp(lines[0]) ?? state.oldestTimestamp;
      send(ws, { type: 'history', lines, hasMore: lines.length >= BATCH_SIZE });
    } catch (error) {
      send(ws, { type: 'error', message: error instanceof Error ? error.message : 'Failed to load more logs' });
    } finally {
      state.loadingMore = false;
    }
  };

  const start = async (ws: WSContext, state: ManagedLogStreamState) => {
    const auth = await authorize(credential, databaseId);
    if (!auth) {
      send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
      ws.close(1008, 'Authentication failed');
      return;
    }
    state.authenticated = true;

    const target = await databases.resolveLogTarget(databaseId);
    state.target = target;
    if (!registry.getNode(target.nodeId)) {
      send(ws, { type: 'error', message: 'Database node is not connected' });
      ws.close(1011, 'Node not connected');
      return;
    }

    const initialLines = await databases.getLogs(databaseId, {
      tailLines: tail,
      follow: false,
      timestamps: true,
    });
    state.oldestTimestamp = extractTimestamp(initialLines[0]);
    send(ws, { type: 'initial', lines: initialLines, hasMore: initialLines.length >= tail });

    const handlerKey = `${target.nodeId}:${target.containerId}`;
    state.handlerKey = handlerKey;
    registry.registerLogStreamHandler(handlerKey, (lines, ended) => {
      void (async () => {
        if (!(await revalidate(ws, state))) return;
        if (ended) {
          send(ws, { type: 'logs_ended' });
          ws.close(1000, 'Log stream ended');
          return;
        }
        send(ws, { type: 'new', lines });
      })();
    });

    const result = await dispatch.sendManagedDatabaseLogsCommand(target.nodeId, target.managedDatabaseId, {
      tailLines: 0,
      follow: true,
      timestamps: true,
      since: extractTimestamp(initialLines.at(-1)),
    });
    if (!result.success) {
      registry.removeLogStreamHandler(handlerKey);
      state.handlerKey = null;
      send(ws, { type: 'error', message: result.error || 'Failed to start log stream' });
      ws.close(1011, 'Stream start failed');
      return;
    }
    send(ws, { type: 'connected', streaming: true });
  };

  return {
    onOpen(_event: Event, ws: WSContext) {
      const state: ManagedLogStreamState = {
        authenticated: false,
        target: null,
        handlerKey: null,
        loadingMore: false,
        keepaliveInterval: null,
      };
      states.set(ws, state);
      state.keepaliveInterval = setInterval(() => void revalidate(ws, state, true), 30_000);
      start(ws, state).catch((error) => {
        logger.error('Managed database log stream start failed', {
          databaseId,
          error: error instanceof Error ? error.message : String(error),
        });
        send(ws, { type: 'error', message: error instanceof Error ? error.message : 'Failed to open database logs' });
        ws.close(1011, 'Stream start failed');
      });
    },

    onMessage(event: MessageEvent, ws: WSContext) {
      const state = states.get(ws);
      if (!state) return;
      try {
        const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        if (message?.type === 'ping') send(ws, { type: 'pong' });
        if (message?.type === 'load_more' && state.authenticated && !state.loadingMore) {
          state.loadingMore = true;
          void revalidate(ws, state).then((allowed) => {
            if (allowed) return loadMore(ws, state);
          });
        }
      } catch {
        // Ignore invalid client frames.
      }
    },

    onClose(_event: unknown, ws: WSContext) {
      cleanup(ws);
    },

    onError(_event: Event, ws: WSContext) {
      cleanup(ws);
    },
  };
}
