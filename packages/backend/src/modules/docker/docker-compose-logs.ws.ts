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

    onMessage(event: MessageEvent, ws: WSContext) {
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'ping') send(ws, { type: 'pong' });
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
    for (const key of state.handlerKeys) {
      registry.removeLogStreamHandler(key);
    }
    if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
    wsStates.delete(ws);
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
      if (result.success && result.detail) {
        const lines: string[] = JSON.parse(result.detail);
        for (const line of lines) {
          // Lines have timestamp prefix: "2026-01-01T00:00:00.000Z log content"
          const spaceIdx = line.indexOf(' ');
          const ts = spaceIdx > 0 ? line.slice(0, spaceIdx) : '';
          allLines.push({ ts, line: `${service} | ${line}` });
        }
      }
    } catch {
      /* skip container */
    }
  }

  // Sort by timestamp
  allLines.sort((a, b) => a.ts.localeCompare(b.ts));
  send(ws, { type: 'initial', lines: allLines.map((l) => l.line) });

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
    dispatch
      .sendDockerLogsCommand(nodeId, cid, {
        tailLines: 0,
        follow: true,
        timestamps: true,
        since: newestTs,
      })
      .catch(() => {});
  }

  logger.info('Compose log stream started', { nodeId, project, containers: composeContainers.length });
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
