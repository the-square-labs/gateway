import type { WSContext } from 'hono/ws';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { resolveWebSocketCredential, type WebSocketCredential } from '@/modules/auth/websocket-auth.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { User } from '@/types.js';

const logger = createChildLogger('NodeExec');

function send(ws: WSContext, msg: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Connection may already be closed
  }
}

interface ExecWSState {
  user: User | null;
  authenticated: boolean;
  execId: string | null;
  outputHandler: ((data: any) => void) | null;
  keepaliveInterval: ReturnType<typeof setInterval> | null;
  outputQueue: Array<{ output: any; bytes: number }>;
  outputBytes: number;
  drainingOutput: boolean;
  keepalivePending: boolean;
  credential: WebSocketCredential | null;
}

const wsStates = new WeakMap<WSContext, ExecWSState>();
export const EXEC_OUTPUT_MAX_BYTES = 1024 * 1024;
export const EXEC_OUTPUT_MAX_CHUNKS = 256;

function cleanupExec(ws: WSContext, state: ExecWSState): void {
  if (wsStates.get(ws) !== state) return;
  wsStates.delete(ws);
  state.authenticated = false;
  if (state.execId && state.outputHandler) {
    container.resolve(NodeRegistryService).removeExecHandler(state.execId, state.outputHandler);
  }
  state.outputHandler = null;
  if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
  state.keepaliveInterval = null;
  state.outputQueue.length = 0;
  state.outputBytes = 0;
}

function closeExec(ws: WSContext, state: ExecWSState, code: number, reason: string): void {
  if (wsStates.get(ws) !== state) return;
  cleanupExec(ws, state);
  try {
    ws.close(code, reason);
  } catch {
    /* already closed */
  }
}

async function drainOutput(ws: WSContext, state: ExecWSState, nodeId: string): Promise<void> {
  if (state.drainingOutput) return;
  state.drainingOutput = true;
  try {
    while (wsStates.get(ws) === state && state.outputQueue.length > 0) {
      // Do not hold a payload in the async frame while authorization is pending:
      // cleanup can release the entire queue immediately.
      if (!(await revalidateNodeExecAccess(ws, state, nodeId)) || wsStates.get(ws) !== state) return;
      const entry = state.outputQueue.shift();
      if (!entry) return;
      state.outputBytes -= entry.bytes;
      const output = entry.output;
      if (output.data?.length) {
        send(ws, { type: 'output', data: Buffer.from(output.data).toString('base64') });
      }
      if (output.exited) {
        send(ws, { type: 'exit', exitCode: output.exitCode ?? 0 });
        closeExec(ws, state, 1000, 'Process exited');
        return;
      }
    }
  } catch (error) {
    if (wsStates.get(ws) !== state) return;
    logger.error('Error forwarding exec output', { error: String(error) });
    closeExec(ws, state, 1011, 'Output forwarding failed');
  } finally {
    state.drainingOutput = false;
  }
}

/**
 * Create WebSocket handlers for node-level console sessions.
 * Same pattern as Docker exec but uses NodeExecCommand (host-level PTY).
 */
export function createNodeExecWSHandlers(nodeId: string, shell: string, credential: WebSocketCredential | null) {
  const dispatch = container.resolve(NodeDispatchService);
  const registry = container.resolve(NodeRegistryService);

  return {
    onOpen(_event: Event, ws: WSContext) {
      const state: ExecWSState = {
        user: null,
        authenticated: false,
        execId: null,
        outputHandler: null,
        keepaliveInterval: null,
        outputQueue: [],
        outputBytes: 0,
        drainingOutput: false,
        keepalivePending: false,
        credential,
      };
      wsStates.set(ws, state);

      state.keepaliveInterval = setInterval(() => {
        if (state.keepalivePending) return;
        state.keepalivePending = true;
        void revalidateNodeExecAccess(ws, state, nodeId, true)
          .catch(() => closeExec(ws, state, 1011, 'Access check failed'))
          .finally(() => {
            state.keepalivePending = false;
          });
      }, 30_000);

      authenticateAndCreateExec(ws, state, credential, nodeId, shell, dispatch, registry).catch((err) => {
        if (wsStates.get(ws) !== state) return;
        cleanupExec(ws, state);
        logger.error('Auth/exec creation failed', { error: err instanceof Error ? err.message : String(err) });
        try {
          ws.close();
        } catch {
          /* */
        }
      });
    },

    async onMessage(event: MessageEvent, ws: WSContext) {
      const state = wsStates.get(ws);
      if (!state?.authenticated) return;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        if (!msg || typeof msg.type !== 'string') return;
      } catch {
        return;
      }

      if (msg.type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }

      if (msg.type === 'input' && state.execId) {
        if (!(await revalidateNodeExecAccess(ws, state, nodeId)) || wsStates.get(ws) !== state) return;
        try {
          const inputData = Buffer.from(msg.data as string, 'base64');
          dispatch.sendExecInput(nodeId, state.execId, inputData);
        } catch (err) {
          logger.error('Error forwarding exec input', { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (msg.type === 'resize' && state.execId) {
        if (!(await revalidateNodeExecAccess(ws, state, nodeId)) || wsStates.get(ws) !== state) return;
        try {
          await dispatch.sendNodeExecCommand(nodeId, 'resize', {
            rows: msg.rows as number,
            cols: msg.cols as number,
            sessionKey: state.user?.id,
          });
        } catch (err) {
          logger.error('Error sending resize', { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
    },

    onClose(_event: unknown, ws: WSContext) {
      const state = wsStates.get(ws);
      if (state) cleanupExec(ws, state);
      logger.info('Node exec WS closed', { nodeId });
    },

    onError(_error: Event, ws: WSContext) {
      const state = wsStates.get(ws);
      if (state) cleanupExec(ws, state);
      logger.error('Node exec WS error', { nodeId });
    },
  };
}

async function authenticateAndCreateExec(
  ws: WSContext,
  state: ExecWSState,
  credential: WebSocketCredential | null,
  nodeId: string,
  shell: string,
  dispatch: NodeDispatchService,
  registry: NodeRegistryService
): Promise<void> {
  const authResult = await resolveWebSocketCredential(credential, `nodes:console:${nodeId}`);
  if (wsStates.get(ws) !== state) return;
  if (!authResult) {
    send(ws, { type: 'auth_error', message: 'Invalid or expired token' });
    closeExec(ws, state, 1008, 'Authentication failed');
    return;
  }
  const { user } = authResult;

  if (user.isBlocked) {
    send(ws, { type: 'auth_error', message: 'Account is blocked' });
    closeExec(ws, state, 1008, 'Account blocked');
    return;
  }

  state.user = user;
  state.authenticated = true;

  logger.info('Node exec authenticated', { nodeId, userId: user.id });

  const node = registry.getNode(nodeId);
  if (!node) {
    send(ws, { type: 'error', message: `Node ${nodeId} is not connected` });
    closeExec(ws, state, 1011, 'Node not connected');
    return;
  }

  // Create or reuse node-level exec session
  const command = shell && shell !== 'auto' ? [shell] : [];
  let result: import('@/grpc/generated/types.js').CommandResult;
  try {
    result = await dispatch.sendNodeExecCommand(nodeId, 'create', {
      command,
      tty: true,
      sessionKey: user.id,
    });
  } catch (err) {
    if (wsStates.get(ws) !== state) return;
    const message = err instanceof Error ? err.message : 'Failed to create exec session';
    send(ws, { type: 'error', message });
    closeExec(ws, state, 1011, 'Exec creation failed');
    return;
  }

  if (wsStates.get(ws) !== state) return;
  if (!result.success) {
    send(ws, { type: 'error', message: result.error || 'Exec creation failed' });
    closeExec(ws, state, 1011, 'Exec creation failed');
    return;
  }

  let execId: string | undefined;
  let isNew = true;
  let buffer: string[] = [];
  let usedShell = shell || 'auto';
  try {
    const parsed = JSON.parse(result.detail || '{}');
    execId = parsed.exec_id || parsed.execId || parsed.id;
    if (parsed.is_new === false || parsed.isNew === false) isNew = false;
    if (Array.isArray(parsed.buffer)) buffer = parsed.buffer;
    if (parsed.shell) usedShell = parsed.shell;
  } catch {
    execId = result.detail || undefined;
  }

  if (!execId) {
    send(ws, { type: 'error', message: 'No exec ID returned from daemon' });
    closeExec(ws, state, 1011, 'No exec ID');
    return;
  }

  state.execId = execId;

  const outputHandler = (output: any) => {
    if (wsStates.get(ws) !== state) return;
    const bytes =
      typeof output.data === 'string'
        ? Buffer.byteLength(output.data)
        : (output.data?.byteLength ?? output.data?.length ?? 0);
    if (state.outputQueue.length >= EXEC_OUTPUT_MAX_CHUNKS || state.outputBytes + bytes > EXEC_OUTPUT_MAX_BYTES) {
      send(ws, { type: 'error', code: 'EXEC_OUTPUT_OVERFLOW', message: 'Terminal output backlog exceeded its limit' });
      closeExec(ws, state, 1013, 'Terminal output backlog exceeded');
      return;
    }
    state.outputQueue.push({ output, bytes });
    state.outputBytes += bytes;
    void drainOutput(ws, state, nodeId);
  };
  state.outputHandler = outputHandler;
  registry.registerExecHandler(execId, outputHandler);

  if (!isNew && buffer.length > 0) {
    for (const b64chunk of buffer) {
      send(ws, { type: 'output', data: b64chunk });
    }
  }

  send(ws, { type: 'connected', execId, shell: usedShell, isNew });
}

async function revalidateNodeExecAccess(
  ws: WSContext,
  state: ExecWSState,
  nodeId: string,
  emitPong = false
): Promise<boolean> {
  if (wsStates.get(ws) !== state) return false;
  const authResult = await resolveWebSocketCredential(state.credential, `nodes:console:${nodeId}`);
  if (wsStates.get(ws) !== state) return false;
  if (!authResult) {
    state.authenticated = false;
    send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
    try {
      closeExec(ws, state, 1008, 'Authentication failed');
    } catch {
      /* */
    }
    return false;
  }

  state.user = authResult.user;
  if (emitPong) {
    try {
      ws.send(JSON.stringify({ type: 'pong' }));
    } catch {
      cleanupExec(ws, state);
    }
  }
  return true;
}
