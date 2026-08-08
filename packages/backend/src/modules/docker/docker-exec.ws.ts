import type { WSContext } from 'hono/ws';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import {
  resolveWebSocketCredential,
  resolveWebSocketCredentialForScopeBase,
  type WebSocketCredential,
} from '@/modules/auth/websocket-auth.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { User } from '@/types.js';
import { DockerManagementService } from './docker.service.js';
import { dockerScopedNodeIds, hasDockerResourceScope } from './docker-access-resource.service.js';

const logger = createChildLogger('DockerExec');
export const DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES = 16 * 1024;

export function isDockerExecPreauthMessageTooLarge(payload: unknown): boolean {
  if (typeof payload === 'string') return Buffer.byteLength(payload, 'utf8') > DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES;
  if (payload instanceof ArrayBuffer) return payload.byteLength > DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES;
  if (ArrayBuffer.isView(payload)) return payload.byteLength > DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES;
  if (typeof Blob !== 'undefined' && payload instanceof Blob) return payload.size > DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES;
  return Buffer.byteLength(String(payload), 'utf8') > DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES;
}

async function authorizeExecAccess(
  credential: WebSocketCredential | null,
  nodeId: string,
  resourceId: string
): Promise<User | null> {
  const result = await resolveWebSocketCredential(credential, `docker:containers:console:${nodeId}/${resourceId}`);
  return result?.user ?? null;
}

function send(ws: WSContext, msg: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Connection may already be closed
  }
}

export async function resolveDockerExecUser(
  docker: Pick<DockerManagementService, 'inspectContainer'>,
  nodeId: string,
  containerId: string
): Promise<string> {
  try {
    const inspectData = await docker.inspectContainer(nodeId, containerId);
    const configuredUser = (inspectData as { Config?: { User?: unknown } } | null | undefined)?.Config?.User;
    return typeof configuredUser === 'string' && configuredUser.trim().length > 0 ? configuredUser.trim() : 'root';
  } catch (error) {
    logger.warn('Failed to inspect container user for Docker exec; falling back to root', {
      nodeId,
      containerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'root';
  }
}

interface ExecWSState {
  user: User | null;
  authenticated: boolean;
  execId: string | null;
  terminalSize: DockerExecTerminalSize | null;
  outputHandler: ((data: any) => void) | null;
  keepaliveInterval: ReturnType<typeof setInterval> | null;
  outputQueue: Promise<void>;
  credential: WebSocketCredential | null;
  scopeResourceId: string | null;
}

export interface DockerExecTerminalSize {
  rows: number;
  cols: number;
}

export function parseDockerExecTerminalSize(rows: unknown, cols: unknown): DockerExecTerminalSize | null {
  if (typeof rows !== 'number' || typeof cols !== 'number') return null;
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) return null;
  if (rows < 1 || rows > 65_535) return null;
  if (cols < 1 || cols > 65_535) return null;
  return { rows, cols };
}

export async function resizeDockerExec(
  dispatch: Pick<NodeDispatchService, 'sendDockerExecCommand'>,
  nodeId: string,
  execId: string,
  size: DockerExecTerminalSize
): Promise<void> {
  const result = await dispatch.sendDockerExecCommand(nodeId, 'resize', {
    // DockerExecCommand reuses container_id as the exec session ID for resize actions.
    containerId: execId,
    rows: size.rows,
    cols: size.cols,
  });
  if (!result.success) {
    throw new Error(result.error || 'Docker exec resize failed');
  }
}

const wsStates = new WeakMap<WSContext, ExecWSState>();

/**
 * Create WebSocket handlers for Docker exec terminal sessions.
 *
 * Flow (persistent sessions):
 * 1. Client connects with the session cookie and ?shell=<shell>
 * 2. onOpen authenticates and asks daemon to create-or-reuse exec for this container
 * 3. Daemon creates a new exec OR reuses existing; sends buffered output first on reuse
 * 4. Daemon streams ExecOutput back; backend forwards to WebSocket
 * 5. Client sends { type: "input", data: "<base64>" } or { type: "resize", rows, cols }
 * 6. On WS disconnect, backend sends "detach" — daemon keeps exec alive, buffers output
 * 7. On reconnect, daemon replays buffered output then resumes live forwarding
 */
export function createDockerExecWSHandlers(
  nodeId: string,
  containerId: string,
  shell: string,
  credential: WebSocketCredential | null
) {
  const dispatch = container.resolve(NodeDispatchService);
  const registry = container.resolve(NodeRegistryService);
  const docker = container.resolve(DockerManagementService);

  return {
    onOpen(_event: Event, ws: WSContext) {
      const state: ExecWSState = {
        user: null,
        authenticated: false,
        execId: null,
        terminalSize: null,
        outputHandler: null,
        keepaliveInterval: null,
        outputQueue: Promise.resolve(),
        credential,
        scopeResourceId: null,
      };
      wsStates.set(ws, state);

      state.keepaliveInterval = setInterval(() => {
        void revalidateExecAccess(ws, state, nodeId, true);
      }, 30_000);

      // Authenticate immediately from the session cookie.
      authenticateAndCreateExec(ws, state, credential, nodeId, containerId, shell, dispatch, registry, docker).catch(
        (err) => {
          logger.error('Auth/exec creation failed', { error: err instanceof Error ? err.message : String(err) });
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
      );
    },

    async onMessage(event: MessageEvent, ws: WSContext) {
      const state = wsStates.get(ws);
      if (!state) return;

      // The credential is supplied during the WebSocket handshake, so no
      // legitimate pre-auth client command needs a large payload. Avoid JSON
      // parsing attacker-controlled megabyte payloads while authentication is
      // still in flight; authenticated terminal input keeps its existing flow.
      if (!state.authenticated && isDockerExecPreauthMessageTooLarge(event.data)) {
        send(ws, { type: 'error', message: 'Message too large before authentication' });
        try {
          ws.close(1009, 'Message too large');
        } catch {
          /* ignore */
        }
        return;
      }

      const raw = typeof event.data === 'string' ? event.data : String(event.data);

      let msg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
          send(ws, { type: 'error', message: 'Invalid message format' });
          return;
        }
        msg = parsed;
      } catch {
        send(ws, { type: 'error', message: 'Invalid JSON' });
        return;
      }

      if (msg.type === 'resize') {
        const terminalSize = parseDockerExecTerminalSize(msg.rows, msg.cols);
        if (!terminalSize) {
          send(ws, { type: 'error', message: 'Invalid terminal size' });
          return;
        }

        state.terminalSize = terminalSize;
        if (!state.execId) return;
        if (!(await revalidateExecAccess(ws, state, nodeId))) return;
        try {
          await resizeDockerExec(dispatch, nodeId, state.execId, terminalSize);
        } catch (err) {
          logger.error('Error sending resize', { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (!state.authenticated) {
        send(ws, { type: 'error', message: 'Not authenticated' });
        return;
      }

      if (msg.type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }

      if (msg.type === 'input' && state.execId) {
        if (!(await revalidateExecAccess(ws, state, nodeId))) return;
        try {
          const inputData = Buffer.from(msg.data as string, 'base64');
          dispatch.sendExecInput(nodeId, state.execId, inputData);
        } catch (err) {
          logger.error('Error forwarding exec input', { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
    },

    onClose(_event: unknown, ws: WSContext) {
      const state = wsStates.get(ws);
      if (state) {
        if (state.execId) {
          registry.removeExecHandler(state.execId, state.outputHandler ?? undefined);
        }
        if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
        wsStates.delete(ws);
      }
      logger.info('Docker exec WS closed', { nodeId, containerId });
    },

    onError(_error: Event, ws: WSContext) {
      const state = wsStates.get(ws);
      if (state) {
        if (state.execId) {
          registry.removeExecHandler(state.execId, state.outputHandler ?? undefined);
        }
        if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
        wsStates.delete(ws);
      }
      logger.error('Docker exec WS error', { nodeId, containerId });
    },
  };
}

/**
 * Authenticate via session token and create/reuse the exec session on the daemon.
 * Called immediately on WebSocket open.
 */
async function authenticateAndCreateExec(
  ws: WSContext,
  state: ExecWSState,
  credential: WebSocketCredential | null,
  nodeId: string,
  containerId: string,
  shell: string,
  dispatch: NodeDispatchService,
  registry: NodeRegistryService,
  docker: DockerManagementService
): Promise<void> {
  const initialAuth = await resolveWebSocketCredentialForScopeBase(credential, 'docker:containers:console');
  if (
    !initialAuth ||
    (!hasDockerResourceScope(initialAuth.scopes, 'docker:containers:console', nodeId, '') &&
      !dockerScopedNodeIds(initialAuth.scopes, ['docker:containers:console']).includes(nodeId))
  ) {
    send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
    ws.close(1008, 'Authentication failed');
    return;
  }
  const inspect = await docker.inspectContainer(nodeId, containerId).catch(() => null);
  const scopeResourceId = String(inspect?.scopeResourceId ?? '');
  const user =
    scopeResourceId && hasDockerResourceScope(initialAuth.scopes, 'docker:containers:console', nodeId, scopeResourceId)
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

  logger.info('Docker exec authenticated', { nodeId, containerId, userId: user.id });

  // Verify the node is connected
  const node = registry.getNode(nodeId);
  if (!node) {
    send(ws, { type: 'error', message: `Node ${nodeId} is not connected` });
    ws.close(1011, 'Node not connected');
    return;
  }

  // Auto-detect best available shell by reading /etc/shells
  let usedShell = shell && shell !== 'auto' ? shell : '/bin/sh';
  if (!shell || shell === 'auto') {
    try {
      const fileResult = await dispatch.sendDockerFileCommand(nodeId, 'read', {
        containerId,
        path: '/etc/shells',
        maxBytes: 4096,
      });
      if (fileResult.success && fileResult.data?.length) {
        const content = Buffer.from(fileResult.data).toString('utf-8');
        const lines = content
          .split('\n')
          .map((l: string) => l.trim())
          .filter((l: string) => l && !l.startsWith('#'));
        const preferred = ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh', '/bin/ash', '/bin/sh'];
        for (const s of preferred) {
          if (lines.includes(s)) {
            usedShell = s;
            break;
          }
        }
      }
    } catch {
      // /etc/shells doesn't exist — fall back to /bin/sh
    }
    logger.info('Auto-detected shell', { nodeId, containerId, shell: usedShell });
  }

  // Create or reuse exec session on daemon
  let result: import('@/grpc/generated/types.js').CommandResult;
  try {
    const execUser = await resolveDockerExecUser(docker, nodeId, containerId);
    const initialSize = state.terminalSize;
    result = await dispatch.sendDockerExecCommand(nodeId, 'create', {
      containerId,
      command: [usedShell],
      tty: true,
      stdin: true,
      user: execUser,
      sessionKey: user.id,
      rows: initialSize?.rows,
      cols: initialSize?.cols,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create exec session';
    send(ws, { type: 'error', message });
    ws.close(1011, 'Exec creation failed');
    return;
  }

  if (!result.success) {
    send(ws, { type: 'error', message: result.error || 'Exec creation failed' });
    ws.close(1011, 'Exec creation failed');
    return;
  }

  // Parse exec ID, reuse flag, and buffer from the command result
  let execId: string | undefined;
  let isNew = true;
  let buffer: string[] = [];
  try {
    const parsed = JSON.parse(result.detail || '{}');
    execId = parsed.exec_id || parsed.execId || parsed.id;
    if (parsed.is_new === false || parsed.isNew === false) {
      isNew = false;
    }
    if (Array.isArray(parsed.buffer)) {
      buffer = parsed.buffer;
    }
  } catch {
    execId = result.detail || undefined;
  }

  if (!execId) {
    send(ws, { type: 'error', message: 'No exec ID returned from daemon' });
    ws.close(1011, 'No exec ID');
    return;
  }

  state.execId = execId;

  if (state.terminalSize) {
    try {
      await resizeDockerExec(dispatch, nodeId, execId, state.terminalSize);
    } catch (err) {
      logger.error('Error applying initial terminal size', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Register handler for live ExecOutput from daemon -> forward to this WS
  const outputHandler = (output: any) => {
    state.outputQueue = state.outputQueue
      .then(async () => {
        if (!(await revalidateExecAccess(ws, state, nodeId))) return;
        if (output.data && output.data.length > 0) {
          const b64 = Buffer.isBuffer(output.data)
            ? output.data.toString('base64')
            : Buffer.from(output.data).toString('base64');
          send(ws, { type: 'output', data: b64 });
        }
        if (output.exited) {
          send(ws, { type: 'exit', exitCode: output.exitCode ?? 0 });
          try {
            ws.close(1000, 'Process exited');
          } catch {
            /* */
          }
        }
      })
      .catch((err) => {
        logger.error('Error forwarding exec output', { error: err instanceof Error ? err.message : String(err) });
      });
  };
  state.outputHandler = outputHandler;
  registry.registerExecHandler(execId, outputHandler);

  send(ws, { type: 'connected', execId, shell: usedShell, isNew });

  // Replay output captured while the daemon was creating the exec session.
  if (buffer.length > 0) {
    for (const b64chunk of buffer) {
      send(ws, { type: 'output', data: b64chunk });
    }
  }
}

async function revalidateExecAccess(
  ws: WSContext,
  state: ExecWSState,
  nodeId: string,
  emitPong = false
): Promise<boolean> {
  const user = state.scopeResourceId
    ? await authorizeExecAccess(state.credential, nodeId, state.scopeResourceId)
    : null;
  if (!user) {
    state.authenticated = false;
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
