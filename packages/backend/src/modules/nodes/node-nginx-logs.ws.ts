import { eq } from 'drizzle-orm';
import type { WSContext } from 'hono/ws';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { proxyHosts } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { resolveWebSocketCredential, type WebSocketCredential } from '@/modules/auth/websocket-auth.js';
import { logRelay, type RelayedLogEntry } from '@/modules/monitoring/log-relay.service.js';
import { requestNginxHostLogHistory, subscribeNginxHostLogs } from '@/modules/monitoring/nginx-log-subscriptions.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { User } from '@/types.js';

const logger = createChildLogger('NodeNginxLogStream');
const HISTORY_BATCH_SIZE = 200;

interface NodeNginxLogStreamWSState {
  user: User | null;
  authenticated: boolean;
  streaming: boolean;
  keepaliveInterval: ReturnType<typeof setInterval> | null;
  cleanupSubscriptions: Array<() => void>;
  hostIds: string[];
  loadingMore: boolean;
  pendingWhileLoading: RelayedLogEntry[];
  sentKeys: Set<string>;
  loadedCount: number;
  hasMore: boolean;
}

const wsStates = new WeakMap<WSContext, NodeNginxLogStreamWSState>();

async function authorizeLogAccess(credential: WebSocketCredential | null, nodeId: string): Promise<User | null> {
  const result = await resolveWebSocketCredential(credential, `nodes:logs:${nodeId}`);
  return result?.user ?? null;
}

function send(ws: WSContext, msg: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Connection may already be closed.
  }
}

function logEntryKey(entry: RelayedLogEntry): string {
  return [
    entry.hostId,
    entry.logType,
    entry.timestamp,
    entry.remoteAddr,
    entry.method,
    entry.path,
    entry.status,
    entry.bodyBytesSent,
    entry.raw,
    entry.level,
  ].join('\u0000');
}

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

function logEntryTime(entry: RelayedLogEntry): number {
  const nginxMatch = entry.timestamp.match(
    /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s+([+-])(\d{2})(\d{2})$/
  );
  if (nginxMatch) {
    const [, day, month, year, hour, minute, second, sign, offsetHour, offsetMinute] = nginxMatch;
    const utcMs = Date.UTC(Number(year), MONTHS[month] ?? 0, Number(day), Number(hour), Number(minute), Number(second));
    const offsetMs = (Number(offsetHour) * 60 + Number(offsetMinute)) * 60_000;
    return sign === '+' ? utcMs - offsetMs : utcMs + offsetMs;
  }

  const errorMatch = entry.raw.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (errorMatch) {
    const [, year, month, day, hour, minute, second] = errorMatch;
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  }

  const parsed = Date.parse(entry.timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortLogs(entries: RelayedLogEntry[]): RelayedLogEntry[] {
  return [...entries].sort((a, b) => {
    const byTime = logEntryTime(a) - logEntryTime(b);
    if (byTime !== 0) return byTime;
    return logEntryKey(a).localeCompare(logEntryKey(b));
  });
}

function dedupeLogs(entries: RelayedLogEntry[]): RelayedLogEntry[] {
  const seen = new Set<string>();
  const result: RelayedLogEntry[] = [];
  for (const entry of entries) {
    const key = logEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

async function resolveNodeHostIds(nodeId: string): Promise<string[]> {
  const db = container.resolve(TOKENS.DrizzleClient) as DrizzleClient;
  const hosts = await db.select({ id: proxyHosts.id }).from(proxyHosts).where(eq(proxyHosts.nodeId, nodeId));
  return hosts.map((host) => host.id);
}

async function loadNodeHistory(
  registry: NodeRegistryService,
  nodeId: string,
  hostIds: string[],
  perHostTail: number
): Promise<{ ok: true; entries: RelayedLogEntry[] } | { ok: false; message: string }> {
  const results = await Promise.all(
    hostIds.map((hostId) => requestNginxHostLogHistory(registry, nodeId, hostId, perHostTail))
  );
  const firstError = results.find((result) => !result.ok);
  if (firstError && results.every((result) => !result.ok)) return firstError;

  const entries = results.flatMap((result) => (result.ok ? result.entries : []));
  return { ok: true, entries: sortLogs(dedupeLogs(entries)) };
}

export function createNodeNginxLogStreamWSHandlers(
  nodeId: string,
  tail: number,
  credential: WebSocketCredential | null
) {
  const registry = container.resolve(NodeRegistryService);

  return {
    onOpen(_event: Event, ws: WSContext) {
      const state: NodeNginxLogStreamWSState = {
        user: null,
        authenticated: false,
        streaming: false,
        keepaliveInterval: null,
        cleanupSubscriptions: [],
        hostIds: [],
        loadingMore: false,
        pendingWhileLoading: [],
        sentKeys: new Set(),
        loadedCount: 0,
        hasMore: true,
      };
      wsStates.set(ws, state);

      state.keepaliveInterval = setInterval(() => {
        void revalidateLogAccess(ws, state, credential, nodeId, true);
      }, 30_000);

      authenticateAndStartStream(ws, state, credential, nodeId, tail, registry).catch((err) => {
        logger.error('Node nginx log stream start failed', {
          nodeId,
          error: err instanceof Error ? err.message : String(err),
        });
        send(ws, { type: 'error', message: 'Failed to start nginx log stream' });
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
          // Nothing older is left: answer without reading the node's logs again for every request.
          if (!state.hasMore) {
            send(ws, { type: 'history', entries: [], hasMore: false });
            return;
          }
          if (!(await revalidateLogAccess(ws, state, credential, nodeId))) return;
          state.loadingMore = true;
          handleLoadMore(ws, state, nodeId, registry).catch((err) => {
            state.loadingMore = false;
            logger.error('Node nginx log load_more failed', {
              nodeId,
              error: err instanceof Error ? err.message : String(err),
            });
            send(ws, { type: 'error', message: 'Failed to load more nginx logs' });
          });
        }
      } catch {
        // ignore invalid JSON
      }
    },

    onClose(_event: unknown, ws: WSContext) {
      cleanup(ws);
      logger.info('Node nginx log stream WS closed', { nodeId });
    },

    onError(_error: Event, ws: WSContext) {
      cleanup(ws);
      logger.error('Node nginx log stream WS error', { nodeId });
    },
  };

  function cleanup(ws: WSContext) {
    const state = wsStates.get(ws);
    if (!state) return;
    if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
    for (const cleanupSubscription of state.cleanupSubscriptions) cleanupSubscription();
    wsStates.delete(ws);
  }
}

async function authenticateAndStartStream(
  ws: WSContext,
  state: NodeNginxLogStreamWSState,
  credential: WebSocketCredential | null,
  nodeId: string,
  tail: number,
  registry: NodeRegistryService
): Promise<void> {
  const user = await authorizeLogAccess(credential, nodeId);
  if (!user) {
    send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
    ws.close(1008, 'Authentication failed');
    return;
  }

  const hostIds = await resolveNodeHostIds(nodeId);
  state.user = user;
  state.authenticated = true;
  state.hostIds = hostIds;

  if (hostIds.length === 0) {
    state.hasMore = false;
    send(ws, { type: 'initial', entries: [], hasMore: false });
    send(ws, { type: 'connected', streaming: true, hostCount: 0 });
    return;
  }

  const visibleHostIds = new Set(hostIds);
  const onLog = (entry: RelayedLogEntry) => {
    if (entry.nodeId !== nodeId) return;
    if (!visibleHostIds.has(entry.hostId)) return;
    if (state.loadingMore) {
      state.pendingWhileLoading.push(entry);
      return;
    }
    if (!state.streaming) return;

    const key = logEntryKey(entry);
    if (state.sentKeys.has(key)) return;
    state.sentKeys.add(key);
    state.loadedCount += 1;
    send(ws, { type: 'new', entries: [entry] });
  };

  logRelay.on('log', onLog);
  state.cleanupSubscriptions.push(() => logRelay.off('log', onLog));

  for (const hostId of hostIds) {
    const subscription = subscribeNginxHostLogs(registry, nodeId, hostId, 0);
    if (!subscription.ok) {
      logger.warn('Failed to subscribe node nginx host logs', { nodeId, hostId, message: subscription.message });
      continue;
    }
    state.cleanupSubscriptions.push(subscription.cleanup);
  }

  state.loadingMore = true;
  state.pendingWhileLoading = [];
  const initialResult = await loadNodeHistory(registry, nodeId, hostIds, tail + 1);
  if (!initialResult.ok) {
    state.loadingMore = false;
    state.pendingWhileLoading = [];
    send(ws, { type: 'error', message: initialResult.message });
    ws.close(1011, 'Initial fetch failed');
    return;
  }

  const initialEntries = initialResult.entries.slice(-tail);
  for (const entry of initialEntries) state.sentKeys.add(logEntryKey(entry));
  state.loadedCount = initialEntries.length;
  state.hasMore = initialResult.entries.length >= tail;
  const snapshotKeys = new Set(initialResult.entries.map(logEntryKey));
  const liveEntries = state.pendingWhileLoading.filter((entry) => !snapshotKeys.has(logEntryKey(entry)));
  state.pendingWhileLoading = [];
  state.loadingMore = false;
  send(ws, { type: 'initial', entries: initialEntries, hasMore: state.hasMore });

  state.streaming = true;
  send(ws, { type: 'connected', streaming: true, hostCount: hostIds.length });
  sendLiveEntries(ws, state, liveEntries);
}

async function handleLoadMore(
  ws: WSContext,
  state: NodeNginxLogStreamWSState,
  nodeId: string,
  registry: NodeRegistryService
) {
  try {
    if (state.hostIds.length === 0) {
      state.hasMore = false;
      send(ws, { type: 'history', entries: [], hasMore: false });
      return;
    }

    state.pendingWhileLoading = [];
    const perHostTail = state.loadedCount + HISTORY_BATCH_SIZE + 1;
    const result = await loadNodeHistory(registry, nodeId, state.hostIds, perHostTail);
    if (!result.ok) {
      send(ws, { type: 'error', message: result.message });
      return;
    }

    const unseen = result.entries.filter((entry) => !state.sentKeys.has(logEntryKey(entry)));
    const entries = unseen.slice(-HISTORY_BATCH_SIZE);
    for (const entry of entries) state.sentKeys.add(logEntryKey(entry));
    state.loadedCount += entries.length;
    state.hasMore = unseen.length >= HISTORY_BATCH_SIZE;
    send(ws, { type: 'history', entries, hasMore: state.hasMore });

    const snapshotKeys = new Set(result.entries.map(logEntryKey));
    const liveEntries = state.pendingWhileLoading.filter((entry) => !snapshotKeys.has(logEntryKey(entry)));
    sendLiveEntries(ws, state, liveEntries);
  } finally {
    state.pendingWhileLoading = [];
    state.loadingMore = false;
  }
}

function sendLiveEntries(ws: WSContext, state: NodeNginxLogStreamWSState, entries: RelayedLogEntry[]) {
  const uniqueEntries: RelayedLogEntry[] = [];
  for (const entry of entries) {
    const key = logEntryKey(entry);
    if (state.sentKeys.has(key)) continue;
    state.sentKeys.add(key);
    uniqueEntries.push(entry);
  }
  if (uniqueEntries.length === 0) return;
  state.loadedCount += uniqueEntries.length;
  send(ws, { type: 'new', entries: uniqueEntries });
}

async function revalidateLogAccess(
  ws: WSContext,
  state: NodeNginxLogStreamWSState,
  credential: WebSocketCredential | null,
  nodeId: string,
  emitPong = false
): Promise<boolean> {
  const user = await authorizeLogAccess(credential, nodeId);
  if (!user) {
    state.authenticated = false;
    for (const cleanupSubscription of state.cleanupSubscriptions) cleanupSubscription();
    state.cleanupSubscriptions = [];
    send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
    ws.close(1008, 'Authentication failed');
    return false;
  }
  state.user = user;
  state.authenticated = true;
  if (emitPong) send(ws, { type: 'pong' });
  return true;
}
