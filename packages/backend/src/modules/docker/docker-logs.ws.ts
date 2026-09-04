import type { WSContext } from 'hono/ws';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { resolveWebSocketCredentialForScopeBase, type WebSocketCredential } from '@/modules/auth/websocket-auth.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { User } from '@/types.js';
import { DockerAvailabilityService } from './availability/docker-availability.service.js';
import { DockerManagementService } from './docker.service.js';
import { hasDockerResourceScope } from './docker-access-resource.service.js';
import { inspectUserContainer } from './docker-internal-containers.js';

const logger = createChildLogger('DockerLogStream');

async function authorizeLogAccess(
  credential: WebSocketCredential | null,
  nodeId: string,
  resourceId: string
): Promise<User | null> {
  const result = await resolveWebSocketCredentialForScopeBase(credential, 'docker:containers:view');
  if (!result) return null;
  return hasDockerResourceScope(result.scopes, 'docker:containers:view', nodeId, resourceId) ? result.user : null;
}

function send(ws: WSContext, msg: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Connection may already be closed
  }
}

/** Docker timestamp regex: e.g. 2026-04-02T17:05:07.123456789Z */
const DOCKER_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s/;

/**
 * Subtract 1 nanosecond from a Docker timestamp to make until exclusive.
 * Docker's until is inclusive on the exact nanosecond.
 */
function decrementTimestamp(ts: string): string {
  // Format: 2026-04-02T10:13:20.595432459Z
  const match = ts.match(/^(.+\.)(\d+)Z$/);
  if (!match) return ts;
  const prefix = match[1];
  let nanos = match[2].padEnd(9, '0');
  const n = BigInt(nanos) - 1n;
  if (n < 0n) return ts; // edge case — don't wrap
  nanos = n.toString().padStart(9, '0');
  return `${prefix}${nanos}Z`;
}

/**
 * Extract the Docker timestamp from the first line of a batch (oldest).
 * Returns the raw Docker timestamp string or undefined.
 */
function extractOldestTimestamp(lines: string[]): string | undefined {
  if (lines.length === 0) return undefined;
  const match = lines[0].match(DOCKER_TS_RE);
  return match ? match[1] : undefined;
}

/**
 * Extract the Docker timestamp from the last line of a batch (newest).
 * Returns the raw Docker timestamp string or undefined.
 */
function extractNewestTimestamp(lines: string[]): string | undefined {
  if (lines.length === 0) return undefined;
  const match = lines[lines.length - 1].match(DOCKER_TS_RE);
  return match ? match[1] : undefined;
}

interface LogStreamWSState {
  user: User | null;
  authenticated: boolean;
  streaming: boolean;
  unsubscribe: (() => void) | null;
  keepaliveInterval: ReturnType<typeof setInterval> | null;
  /** Oldest timestamp seen (for load_more pagination) */
  oldestTimestamp: string | undefined;
  /** Whether a load_more request is in-flight */
  loadingMore: boolean;
  scopeResourceId: string | null;
  scopeNodeId: string | null;
}

const wsStates = new WeakMap<WSContext, LogStreamWSState>();

function releaseLogHandler(state: LogStreamWSState): void {
  state.unsubscribe?.();
  state.unsubscribe = null;
  state.streaming = false;
}

function cleanupLogStream(ws: WSContext, state: LogStreamWSState): void {
  releaseLogHandler(state);
  if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
  if (wsStates.get(ws) === state) wsStates.delete(ws);
}

/**
 * Create WebSocket handlers for Docker container log streaming.
 *
 * New unified flow:
 * 1. Client connects with the session cookie and ?tail=200
 * 2. onOpen authenticates, fetches initial logs (non-follow), sends them as { type: "initial" }
 * 3. Then starts follow stream — new lines arrive as { type: "new" }
 * 4. Client sends { type: "load_more" } — backend fetches 200 older lines with until=<oldest_ts>,
 *    sends { type: "history" }
 * 5. On WS close, everything is cleaned up
 */
export function createDockerLogStreamWSHandlers(
  nodeId: string,
  containerId: string,
  tail: number,
  credential: WebSocketCredential | null
) {
  const dispatch = container.resolve(NodeDispatchService);
  const registry = container.resolve(NodeRegistryService);
  const docker = container.resolve(DockerManagementService);
  const availability = container.resolve(DockerAvailabilityService);

  return {
    onOpen(_event: Event, ws: WSContext) {
      const state: LogStreamWSState = {
        user: null,
        authenticated: false,
        streaming: false,
        unsubscribe: null,
        keepaliveInterval: null,
        oldestTimestamp: undefined,
        loadingMore: false,
        scopeResourceId: null,
        scopeNodeId: null,
      };
      wsStates.set(ws, state);

      state.keepaliveInterval = setInterval(() => {
        void revalidateLogAccess(ws, state, credential, nodeId, true);
      }, 30_000);

      // Authenticate, fetch initial logs, then start follow stream
      authenticateAndStartStream(
        ws,
        state,
        credential,
        nodeId,
        containerId,
        tail,
        dispatch,
        registry,
        docker,
        availability
      ).catch((err) => {
        if (wsStates.get(ws) !== state) return;
        cleanupLogStream(ws, state);
        logger.error('Auth/stream start failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      });
    },

    async onMessage(event: MessageEvent, ws: WSContext) {
      const state = wsStates.get(ws);
      if (!state) return;

      const raw = typeof event.data === 'string' ? event.data : String(event.data);

      try {
        const msg = JSON.parse(raw);
        if (msg?.type === 'ping') {
          send(ws, { type: 'pong' });
        }
        if (msg?.type === 'load_more') {
          if (!state.authenticated || state.loadingMore) return;
          if (!(await revalidateLogAccess(ws, state, credential, nodeId))) return;
          if (wsStates.get(ws) !== state) return;
          if (!state.oldestTimestamp) {
            send(ws, { type: 'history', lines: [], hasMore: false });
            return;
          }
          state.loadingMore = true;
          handleLoadMore(ws, state, nodeId, containerId, dispatch).catch((err) => {
            if (wsStates.get(ws) !== state) return;
            state.loadingMore = false;
            logger.error('load_more failed', {
              error: err instanceof Error ? err.message : String(err),
            });
            send(ws, { type: 'error', message: 'Failed to load more logs' });
          });
        }
        if (msg?.type === 'stop') {
          // Client requested stop — clean up follow stream handler
          if (state.unsubscribe) {
            releaseLogHandler(state);
            send(ws, { type: 'stopped' });
          }
        }
      } catch {
        // ignore invalid JSON
      }
    },

    onClose(_event: unknown, ws: WSContext) {
      cleanup(ws);
      logger.info('Docker log stream WS closed', { nodeId, containerId });
    },

    onError(_error: Event, ws: WSContext) {
      cleanup(ws);
      logger.error('Docker log stream WS error', { nodeId, containerId });
    },
  };

  function cleanup(ws: WSContext) {
    const state = wsStates.get(ws);
    if (state) {
      cleanupLogStream(ws, state);
    }
  }
}

/**
 * Authenticate via session token, fetch initial logs, then start follow stream.
 */
async function authenticateAndStartStream(
  ws: WSContext,
  state: LogStreamWSState,
  credential: WebSocketCredential | null,
  nodeId: string,
  containerId: string,
  tail: number,
  dispatch: NodeDispatchService,
  registry: NodeRegistryService,
  docker: DockerManagementService,
  availability: DockerAvailabilityService
): Promise<void> {
  const initialAuth = await resolveWebSocketCredentialForScopeBase(credential, 'docker:containers:view');
  if (wsStates.get(ws) !== state) return;
  if (!initialAuth) {
    send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
    ws.close(1008, 'Authentication failed');
    return;
  }
  // Generated deployment slots may be inspectable, but their physical identity is
  // not the authorization boundary. Prefer the logical Availability workload.
  const placementIdentity = await availability.resolveRuntimeAccessIdentity(nodeId, containerId).catch(() => null);
  if (wsStates.get(ws) !== state) return;
  const inspect = placementIdentity ? null : await inspectUserContainer(docker, nodeId, containerId).catch(() => null);
  if (wsStates.get(ws) !== state) return;
  const scopeNodeId = placementIdentity?.nodeId ?? nodeId;
  const scopeResourceId = String(placementIdentity?.resourceId ?? inspect?.scopeResourceId ?? '');
  const user =
    scopeResourceId &&
    hasDockerResourceScope(initialAuth.scopes, 'docker:containers:view', scopeNodeId, scopeResourceId)
      ? initialAuth.user
      : null;
  if (!user) {
    send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
    ws.close(1008, 'Authentication failed');
    return;
  }

  state.user = user;
  state.authenticated = true;
  state.scopeResourceId = scopeResourceId;
  state.scopeNodeId = scopeNodeId;

  logger.info('Docker log stream authenticated', { nodeId, containerId, userId: user.id });

  // Verify the node is connected
  const node = registry.getNode(nodeId);
  if (!node) {
    send(ws, { type: 'error', message: `Node ${nodeId} is not connected` });
    ws.close(1011, 'Node not connected');
    return;
  }

  // ── Step 1: Fetch initial logs (non-follow) ──
  let initialLines: string[] = [];
  try {
    const result = await dispatch.sendDockerLogsCommand(nodeId, containerId, {
      tailLines: tail,
      follow: false,
      timestamps: true,
    });
    if (wsStates.get(ws) !== state) return;

    if (!result.success) {
      send(ws, { type: 'error', message: result.error || 'Failed to fetch initial logs' });
      ws.close(1011, 'Initial fetch failed');
      return;
    }

    if (result.detail) {
      try {
        initialLines = JSON.parse(result.detail);
        if (!Array.isArray(initialLines)) initialLines = [];
      } catch {
        initialLines = [];
      }
    }
  } catch (err) {
    if (wsStates.get(ws) !== state) return;
    const message = err instanceof Error ? err.message : 'Failed to fetch initial logs';
    send(ws, { type: 'error', message });
    ws.close(1011, 'Initial fetch failed');
    return;
  }

  // Track oldest timestamp from the first line for pagination
  if (initialLines.length > 0) {
    state.oldestTimestamp = extractOldestTimestamp(initialLines);
  }

  const hasMore = initialLines.length >= tail;
  send(ws, { type: 'initial', lines: initialLines, hasMore });

  // ── Step 2: Start follow stream ──
  if (wsStates.get(ws) !== state) return;
  const handlerKey = `${nodeId}:${containerId}`;

  const unsubscribe = registry.registerLogStreamHandler(handlerKey, (lines: string[], ended?: boolean) => {
    void (async () => {
      if (state.unsubscribe !== unsubscribe) return;
      if (!(await revalidateLogAccess(ws, state, credential, nodeId))) return;
      if (wsStates.get(ws) !== state || state.unsubscribe !== unsubscribe) return;
      if (ended) {
        send(ws, { type: 'logs_ended' });
        ws.close(1012, 'Log stream ended');
        return;
      }
      if (lines.length > 0) {
        send(ws, { type: 'new', lines });
      }
    })();
  });
  state.unsubscribe = unsubscribe;

  // Start follow stream from newest timestamp to avoid duplicates
  // Use since with a tiny offset to skip the last line we already sent
  const newestTs = extractNewestTimestamp(initialLines);
  let result: import('@/grpc/generated/types.js').CommandResult;
  try {
    if (wsStates.get(ws) !== state) return;
    result = await dispatch.sendDockerLogsCommand(nodeId, containerId, {
      tailLines: 0,
      follow: true,
      timestamps: true,
      since: newestTs,
    });
  } catch (err) {
    if (wsStates.get(ws) !== state || state.unsubscribe !== unsubscribe) return;
    releaseLogHandler(state);
    const message = err instanceof Error ? err.message : 'Failed to start log stream';
    send(ws, { type: 'error', message });
    ws.close(1011, 'Stream start failed');
    return;
  }

  if (wsStates.get(ws) !== state || state.unsubscribe !== unsubscribe) return;
  if (!result.success) {
    releaseLogHandler(state);
    send(ws, { type: 'error', message: result.error || 'Failed to start log stream' });
    ws.close(1011, 'Stream start failed');
    return;
  }

  state.streaming = true;
  send(ws, { type: 'connected', streaming: true });
}

/**
 * Handle a "load_more" request — fetch 200 older lines using until=<oldest_timestamp>.
 */
async function handleLoadMore(
  ws: WSContext,
  state: LogStreamWSState,
  nodeId: string,
  containerId: string,
  dispatch: NodeDispatchService
): Promise<void> {
  const BATCH_SIZE = 200;

  try {
    const exclusiveUntil = state.oldestTimestamp ? decrementTimestamp(state.oldestTimestamp) : undefined;
    const result = await dispatch.sendDockerLogsCommand(nodeId, containerId, {
      tailLines: BATCH_SIZE,
      follow: false,
      timestamps: true,
      until: exclusiveUntil,
    });
    if (wsStates.get(ws) !== state) return;

    if (!result.success) {
      send(ws, { type: 'error', message: result.error || 'Failed to load more logs' });
      return;
    }

    let lines: string[] = [];
    if (result.detail) {
      try {
        lines = JSON.parse(result.detail);
        if (!Array.isArray(lines)) lines = [];
      } catch {
        lines = [];
      }
    }

    // Update oldest timestamp from the first line of this batch
    if (lines.length > 0) {
      const ts = extractOldestTimestamp(lines);
      if (ts) {
        state.oldestTimestamp = ts;
      }
    }

    const hasMore = lines.length >= BATCH_SIZE;
    send(ws, { type: 'history', lines, hasMore });
  } finally {
    if (wsStates.get(ws) === state) state.loadingMore = false;
  }
}

async function revalidateLogAccess(
  ws: WSContext,
  state: LogStreamWSState,
  credential: WebSocketCredential | null,
  _nodeId: string,
  emitPong = false
): Promise<boolean> {
  if (wsStates.get(ws) !== state) return false;
  const user =
    state.scopeNodeId && state.scopeResourceId
      ? await authorizeLogAccess(credential, state.scopeNodeId, state.scopeResourceId)
      : null;
  if (wsStates.get(ws) !== state) return false;
  if (!user) {
    state.authenticated = false;
    cleanupLogStream(ws, state);
    send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
    try {
      ws.close(1008, 'Authentication failed');
    } catch {
      /* */
    }
    return false;
  }

  state.user = user;
  if (emitPong) {
    try {
      ws.send(JSON.stringify({ type: 'pong' }));
    } catch {
      if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
    }
  }
  return true;
}
