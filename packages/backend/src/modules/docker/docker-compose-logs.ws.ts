import type { WSContext } from 'hono/ws';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import {
  resolveWebSocketCredentialForScopeBase,
  type WebSocketAuthResult,
  type WebSocketCredential,
} from '@/modules/auth/websocket-auth.js';
import { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { dockerScopedNodeIds, hasDockerResourceScope } from './docker-access-resource.service.js';

const logger = createChildLogger('ComposeLogStream');
const DOCKER_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s/;
const HISTORY_BATCH_SIZE = 200;

interface ComposeLogContainer {
  id: string;
  service: string;
}

async function authorizeComposeLogAccess(
  credential: WebSocketCredential | null,
  nodeId: string,
  projectId: string | null,
  resourceIds: string[] = []
): Promise<{ result: WebSocketAuthResult; mode: 'compose' | 'legacy-container' } | null> {
  if (projectId) {
    const composeResult = await resolveWebSocketCredentialForScopeBase(credential, 'docker:compose:view');
    if (composeResult && hasDockerResourceScope(composeResult.scopes, 'docker:compose:view', nodeId, projectId)) {
      return { result: composeResult, mode: 'compose' };
    }
  }

  const result = await resolveWebSocketCredentialForScopeBase(credential, 'docker:containers:view');
  if (!result) return null;
  if (
    !hasDockerResourceScope(result.scopes, 'docker:containers:view', nodeId, '') &&
    !dockerScopedNodeIds(result.scopes, ['docker:containers:view']).includes(nodeId)
  ) {
    return null;
  }
  if (
    resourceIds.length > 0 &&
    !resourceIds.every((resourceId) =>
      hasDockerResourceScope(result.scopes, 'docker:containers:view', nodeId, resourceId)
    )
  ) {
    return null;
  }
  return { result, mode: 'legacy-container' };
}

function send(ws: WSContext, msg: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* */
  }
}

interface ComposeLogState {
  authenticated: boolean;
  handlerKeys: string[];
  keepaliveInterval: ReturnType<typeof setInterval> | null;
  credential: WebSocketCredential | null;
  scopeResourceIds: string[];
  projectId: string | null;
  containers: ComposeLogContainer[];
  oldestTimestamp: string | undefined;
  loadingMore: boolean;
  streaming: boolean;
}

const wsStates = new WeakMap<WSContext, ComposeLogState>();

/**
 * WebSocket handler for streaming aggregated compose project logs.
 * Fetches all containers with matching com.docker.compose.project label,
 * then streams logs from all of them with container name prefixes.
 */
export function createComposeLogsWSHandlers(nodeId: string, project: string, credential: WebSocketCredential | null) {
  const dispatch = container.resolve(NodeDispatchService);
  const registry = container.resolve(NodeRegistryService);
  const dockerService = container.resolve(DockerManagementService);

  return {
    onOpen(_event: Event, ws: WSContext) {
      const state: ComposeLogState = {
        authenticated: false,
        handlerKeys: [],
        keepaliveInterval: null,
        credential,
        scopeResourceIds: [],
        projectId: null,
        containers: [],
        oldestTimestamp: undefined,
        loadingMore: false,
        streaming: false,
      };
      wsStates.set(ws, state);

      state.keepaliveInterval = setInterval(() => {
        void revalidateComposeLogAccess(ws, state, nodeId, true);
      }, 30_000);

      startComposeStream(ws, state, credential, nodeId, project, dispatch, registry, dockerService).catch((err) => {
        logger.error('Compose log stream failed', { error: err instanceof Error ? err.message : String(err) });
        try {
          ws.close();
        } catch {
          /* */
        }
      });
    },

    async onMessage(event: MessageEvent, ws: WSContext) {
      const state = wsStates.get(ws);
      if (!state) return;
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      try {
        const msg = JSON.parse(raw);
        if (msg?.type === 'ping') send(ws, { type: 'pong' });
        if (msg?.type === 'load_more') {
          if (!state.authenticated || state.loadingMore) return;
          if (!(await revalidateComposeLogAccess(ws, state, nodeId))) return;
          if (!state.oldestTimestamp) {
            send(ws, { type: 'history', lines: [], hasMore: false });
            return;
          }
          state.loadingMore = true;
          void loadMore(ws, state, nodeId, dispatch).catch((error) => {
            state.loadingMore = false;
            logger.error('Compose log history fetch failed', {
              nodeId,
              project,
              error: error instanceof Error ? error.message : String(error),
            });
            send(ws, { type: 'error', message: 'Failed to load more logs' });
          });
        }
        if (msg?.type === 'stop' && state.streaming) {
          stopFollowing(state, registry);
          send(ws, { type: 'stopped' });
        }
      } catch {
        /* */
      }
    },

    onClose(_event: unknown, ws: WSContext) {
      cleanup(ws, registry);
    },

    onError(_error: Event, ws: WSContext) {
      cleanup(ws, registry);
    },
  };
}

function cleanup(ws: WSContext, registry: NodeRegistryService) {
  const state = wsStates.get(ws);
  if (state) {
    stopFollowing(state, registry);
    if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
    wsStates.delete(ws);
  }
}

function stopFollowing(state: ComposeLogState, registry: NodeRegistryService): void {
  for (const key of state.handlerKeys) registry.removeLogStreamHandler(key);
  state.handlerKeys = [];
  state.streaming = false;
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

function parseLogLines(detail: string): string[] {
  if (!detail) return [];
  try {
    const parsed = JSON.parse(detail);
    return Array.isArray(parsed) ? parsed.filter((line): line is string => typeof line === 'string') : [];
  } catch {
    return [];
  }
}

async function startComposeStream(
  ws: WSContext,
  state: ComposeLogState,
  credential: WebSocketCredential | null,
  nodeId: string,
  project: string,
  dispatch: NodeDispatchService,
  registry: NodeRegistryService,
  dockerService: DockerManagementService
): Promise<void> {
  const projectRecord = await container.resolve(DockerComposeService).findByName(nodeId, project);
  state.projectId = projectRecord?.id ?? null;
  const authorization = await authorizeComposeLogAccess(credential, nodeId, state.projectId);
  if (!authorization) {
    send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
    ws.close(1008, 'Auth failed');
    return;
  }
  const { result: auth, mode: authorizationMode } = authorization;
  state.authenticated = true;

  const node = registry.getNode(nodeId);
  if (!node) {
    send(ws, { type: 'error', message: 'Node not connected' });
    ws.close(1011, 'Node offline');
    return;
  }

  // Find all containers in this compose project
  let allContainers: any[];
  try {
    allContainers = await dockerService.listContainers(nodeId);
    if (!Array.isArray(allContainers)) allContainers = [];
  } catch {
    send(ws, { type: 'error', message: 'Failed to list containers' });
    ws.close(1011, 'List failed');
    return;
  }

  const composeContainers = allContainers.filter((c: any) => {
    const labels = c.labels ?? c.Labels ?? {};
    const resourceId = String(c.scopeResourceId ?? '');
    if (labels['com.docker.compose.project'] !== project || !resourceId) return false;
    return (
      authorizationMode === 'compose' ||
      hasDockerResourceScope(auth.scopes, 'docker:containers:view', nodeId, resourceId)
    );
  });

  if (composeContainers.length === 0) {
    send(ws, { type: 'error', message: `No containers found for compose project "${project}"` });
    ws.close(1011, 'No containers');
    return;
  }
  state.scopeResourceIds = composeContainers.map((item: any) => String(item.scopeResourceId));
  state.containers = composeContainers.map((item: any) => {
    const id = String(item.id ?? item.Id);
    const name = String(item.name ?? item.Name ?? id.slice(0, 12));
    return {
      id,
      service: String((item.labels ?? item.Labels)?.['com.docker.compose.service'] ?? name),
    };
  });

  send(ws, {
    type: 'connected',
    project,
    containers: composeContainers.map((c: any) => ({
      id: c.id ?? c.Id,
      name: c.name ?? c.Name ?? '',
      service: (c.labels ?? c.Labels)?.['com.docker.compose.service'] ?? '',
      state: c.state ?? c.State ?? '',
    })),
  });

  // Fetch initial logs from each container (last 50 lines each), merge by timestamp
  const allLines: Array<{ ts: string; line: string }> = [];
  let initialHasMore = false;
  for (const c of composeContainers) {
    const cid = c.id ?? c.Id;
    const cname = c.name ?? c.Name ?? cid.slice(0, 12);
    const service = (c.labels ?? c.Labels)?.['com.docker.compose.service'] ?? cname;
    try {
      const result = await dispatch.sendDockerLogsCommand(nodeId, cid, {
        tailLines: 50,
        follow: false,
        timestamps: true,
      });
      if (!result.success) {
        send(ws, { type: 'error', message: result.error || 'Failed to fetch initial logs' });
        ws.close(1011, 'Initial fetch failed');
        return;
      }
      const containerLines = parseLogLines(result.detail);
      initialHasMore ||= containerLines.length >= 50;
      for (const line of containerLines) {
        allLines.push({ ts: extractTimestamp(line) ?? '', line: `${service} | ${line}` });
      }
    } catch (error) {
      send(ws, { type: 'error', message: error instanceof Error ? error.message : 'Failed to fetch initial logs' });
      ws.close(1011, 'Initial fetch failed');
      return;
    }
  }

  // Sort by timestamp
  allLines.sort((a, b) => a.ts.localeCompare(b.ts));
  state.oldestTimestamp = allLines.find((line) => line.ts)?.ts;
  send(ws, { type: 'initial', lines: allLines.map((l) => l.line), hasMore: initialHasMore });

  // Start follow streams for each container
  const newestTs = allLines.length > 0 ? allLines[allLines.length - 1].ts : undefined;
  for (const c of composeContainers) {
    const cid = c.id ?? c.Id;
    const cname = c.name ?? c.Name ?? cid.slice(0, 12);
    const service = (c.labels ?? c.Labels)?.['com.docker.compose.service'] ?? cname;
    const handlerKey = `${nodeId}:${cid}`;

    const handler = (lines: string[], ended?: boolean) => {
      void (async () => {
        if (!(await revalidateComposeLogAccess(ws, state, nodeId))) return;
        if (ended) {
          send(ws, { type: 'logs_ended', service });
          ws.close(1012, 'Compose container log stream ended');
          return;
        }
        if (lines.length > 0) {
          send(ws, { type: 'new', lines: lines.map((l: string) => `${service} | ${l}`) });
        }
      })();
    };

    registry.registerLogStreamHandler(handlerKey, handler);
    state.handlerKeys.push(handlerKey);

    // Start follow
    try {
      const result = await dispatch.sendDockerLogsCommand(nodeId, cid, {
        tailLines: 0,
        follow: true,
        timestamps: true,
        since: newestTs,
      });
      if (!result.success) {
        stopFollowing(state, registry);
        send(ws, { type: 'error', message: result.error || 'Failed to start log stream' });
        ws.close(1011, 'Stream start failed');
        return;
      }
    } catch (error) {
      stopFollowing(state, registry);
      send(ws, { type: 'error', message: error instanceof Error ? error.message : 'Failed to start log stream' });
      ws.close(1011, 'Stream start failed');
      return;
    }
  }

  state.streaming = true;
  logger.info('Compose log stream started', { nodeId, project, containers: composeContainers.length });
}

async function loadMore(
  ws: WSContext,
  state: ComposeLogState,
  nodeId: string,
  dispatch: NodeDispatchService
): Promise<void> {
  try {
    const until = state.oldestTimestamp ? decrementTimestamp(state.oldestTimestamp) : undefined;
    const lines: Array<{ ts: string; line: string }> = [];
    let hasMore = false;

    for (const item of state.containers) {
      const result = await dispatch.sendDockerLogsCommand(nodeId, item.id, {
        tailLines: HISTORY_BATCH_SIZE,
        follow: false,
        timestamps: true,
        until,
      });
      if (!result.success) {
        send(ws, { type: 'error', message: result.error || 'Failed to load more logs' });
        return;
      }
      const containerLines = parseLogLines(result.detail);
      hasMore ||= containerLines.length >= HISTORY_BATCH_SIZE;
      for (const line of containerLines) {
        lines.push({ ts: extractTimestamp(line) ?? '', line: `${item.service} | ${line}` });
      }
    }

    lines.sort((a, b) => a.ts.localeCompare(b.ts));
    state.oldestTimestamp = lines.find((line) => line.ts)?.ts ?? state.oldestTimestamp;
    send(ws, { type: 'history', lines: lines.map((item) => item.line), hasMore });
  } finally {
    state.loadingMore = false;
  }
}

async function revalidateComposeLogAccess(
  ws: WSContext,
  state: ComposeLogState,
  nodeId: string,
  emitPong = false
): Promise<boolean> {
  const auth = await authorizeComposeLogAccess(state.credential, nodeId, state.projectId, state.scopeResourceIds);
  if (!auth) {
    state.authenticated = false;
    stopFollowing(state, container.resolve(NodeRegistryService));
    send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
    try {
      ws.close(1008, 'Authentication failed');
    } catch {
      /* */
    }
    return false;
  }
  if (emitPong) {
    try {
      ws.send(JSON.stringify({ type: 'pong' }));
    } catch {
      if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
    }
  }
  return true;
}
