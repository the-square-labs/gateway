import type { WSContext, WSEvents } from 'hono/ws';
import type WebSocketType from 'ws';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import { InferenceCoreAccountingService } from '../accounting/inference-core-accounting.service.js';
import { acquireInferenceConcurrency, consumeInferenceRateLimit } from '../inference-limit.middleware.js';
import { InferenceTokenService } from '../inference-token.service.js';
import { mapReasoningEffort } from '../models/inference-reasoning.service.js';
import { InferenceProtocolError, inferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { canFailOver } from '../providers/inference-routing.service.js';
import { coreRequestHeaders, newCoreRequestContext } from './inference-core-context.js';
import { InferenceCoreProxyService } from './inference-core-proxy.service.js';

// tsc-alias treats the bare `ws` specifier as the local `src/ws` directory
// during production builds. Resolve the runtime dependency through Node so the
// emitted module keeps loading the package while retaining its TypeScript type.
const webSocketPackage = ['w', 's'].join('');
const WebSocket = (await import(webSocketPackage)).default as typeof WebSocketType;
const logger = createChildLogger('InferenceCoreWebSocketProxy');

class CoreWebSocketUpgradeError extends Error {
  constructor(readonly statusCode: number | null) {
    super(
      statusCode === null
        ? 'Inference core rejected the WebSocket upgrade'
        : `Inference core rejected the WebSocket upgrade with status ${statusCode}`
    );
    this.name = 'CoreWebSocketUpgradeError';
  }
}

export interface InferenceCoreWebSocketAuth {
  user: User;
  tokenId: string;
  tokenPrefix: string;
  /** Raw token is retained only per connection to revalidate each new turn. */
  rawToken: string;
}

interface ConnectionState {
  active: ActiveTurn | null;
  unsubscribe: (() => void) | null;
  closedForRevocation: boolean;
}

interface ActiveTurn {
  upstream: WebSocketType | null;
  requestId: string;
  responseId: string;
  model: string;
  cancelled: boolean;
  terminalSeen: boolean;
  terminalSent: boolean;
  emittedOutput: boolean;
  pendingPreludeFrames: string[];
  finalized: boolean;
  /** Per-user concurrency lease; released exactly once when the turn ends. */
  release: () => Promise<void>;
}

/** Responses WS events that end a turn. */
const TERMINAL_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);
const MAX_PENDING_PRELUDE_FRAMES = 4;
const UPSTREAM_CLOSE_BEFORE_RETRY_MS = 1_000;

/**
 * Per-turn WebSocket proxy (plan T5). The client-facing contract is unchanged:
 * one active response per connection, token revalidation per turn, revocation
 * close. Each response.create turn gets its own upstream connection with a
 * freshly signed request context — the signed context binds one rootRequestId,
 * so one upstream socket per turn keeps accounting lineage exact.
 */
export function createCoreResponsesWSHandlers(
  auth: InferenceCoreWebSocketAuth | null,
  maxPayloadBytes = 33_554_432
): WSEvents {
  const state: ConnectionState = { active: null, unsubscribe: null, closedForRevocation: false };
  return {
    onOpen(_event, ws) {
      if (!auth) {
        sendError(ws, 401, 'invalid_api_key', 'Invalid inference token');
        ws.close(1008, 'Unauthorized');
        return;
      }
      if (container.isRegistered(EventBusService)) {
        state.unsubscribe = container
          .resolve(EventBusService)
          .subscribe(`permissions.changed.${auth.user.id}`, (payload) => {
            if (isAccessRevocation(payload)) closeForRevocation(state, ws);
          });
      }
    },
    async onMessage(event, ws) {
      if (!auth) return;
      try {
        await consumeInferenceRateLimit(auth);
      } catch (error) {
        const protocol = inferenceProtocolError(error);
        sendError(ws, protocol.status, protocol.code, protocol.message);
        return;
      }
      if (payloadBytes(event.data) > maxPayloadBytes) {
        sendError(ws, 413, 'request_too_large', 'WebSocket message is too large');
        ws.close(1009, 'Message too large');
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        sendError(ws, 400, 'invalid_request_error', 'Message must be JSON');
        return;
      }
      if (message.type === 'response.cancel') {
        const active = state.active;
        if (active) {
          active.cancelled = true;
          if (active.upstream) upstreamSend(active.upstream, JSON.stringify(message));
          if (!active.terminalSent) {
            send(ws, cancelledEvent(active.responseId, active.model));
            active.terminalSent = true;
          }
          try {
            active.upstream?.close();
          } catch {
            // Already closed.
          }
        }
        return;
      }
      if (message.type !== 'response.create') {
        sendError(ws, 400, 'invalid_request_error', 'Unsupported WebSocket event');
        return;
      }
      if (message.generate === false) {
        for (const frame of warmupCompletionFrames(message)) send(ws, frame);
        return;
      }
      const freshAuth = await revalidateAuth(auth);
      if (!freshAuth) {
        sendError(ws, 401, 'invalid_api_key', 'Invalid or revoked Gateway inference token');
        ws.close(1008, 'Unauthorized');
        return;
      }
      if (state.active) {
        sendError(ws, 409, 'response_in_progress', 'A response is already running');
        return;
      }
      const release = await acquireInferenceConcurrency(freshAuth).catch((error: unknown) => {
        const protocol = inferenceProtocolError(error);
        sendError(ws, protocol.status, protocol.code, protocol.message);
        return null;
      });
      if (!release) return;
      try {
        await startTurn(state, ws, freshAuth, message, release);
      } catch (error) {
        // The turn never started, so the lease is still owned here.
        await release();
        const protocol = inferenceProtocolError(error);
        sendError(ws, protocol.status, protocol.code, protocol.message);
      }
    },
    onClose() {
      endTurn(state, 'cancelled');
      state.unsubscribe?.();
      state.unsubscribe = null;
    },
    onError() {
      endTurn(state, 'cancelled');
      state.unsubscribe?.();
      state.unsubscribe = null;
    },
  };
}

async function startTurn(
  state: ConnectionState,
  ws: WSContext,
  auth: InferenceCoreWebSocketAuth,
  message: Record<string, unknown>,
  release: () => Promise<void>
): Promise<void> {
  const proxy = container.resolve(InferenceCoreProxyService);
  const accounting = container.resolve(InferenceCoreAccountingService);
  const envelope = asObject(message.response) ?? message;
  const publicModelId = typeof envelope.model === 'string' ? envelope.model : '';
  if (!publicModelId.trim()) throw new InferenceProtocolError(400, 'invalid_request_error', 'model is required');

  const affinityKey = typeof envelope.prompt_cache_key === 'string' ? envelope.prompt_cache_key : undefined;
  const existingThread = typeof envelope.previous_response_id === 'string';
  const isCompaction = hasCompactionTrigger(envelope.input);
  const initial = await proxy.resolveTarget(auth.user, publicModelId, {
    ...(affinityKey ? { affinityKey } : {}),
    existingThread,
  });
  const requestedEffort =
    (envelope.reasoning && typeof envelope.reasoning === 'object'
      ? (envelope.reasoning as Record<string, unknown>).effort
      : undefined) ?? envelope.reasoning_effort;
  // A missing core must fail before an idempotent request row exists.
  const target = await proxy.dataPlaneTarget();
  const { requestId } = await accounting.createCoreRequest({
    userId: auth.user.id,
    tokenId: auth.tokenId,
    protocol: 'responses',
    operation: 'responses',
    model: initial.model,
    source: initial.selected.source,
    connection: initial.selected.connection,
    serviceTier: typeof envelope.service_tier === 'string' ? envelope.service_tier : null,
    reasoningEffort: typeof requestedEffort === 'string' ? requestedEffort : null,
    ...(typeof envelope.idempotency_key === 'string' ? { idempotencyKey: envelope.idempotency_key } : {}),
    ...(affinityKey ? { affinityKey } : {}),
    ...(isCompaction ? { isCompaction: true } : {}),
  });
  const turn: ActiveTurn = {
    upstream: null,
    requestId,
    responseId: `resp_${requestId}`,
    model: initial.model.publicId,
    cancelled: false,
    terminalSeen: false,
    terminalSent: false,
    emittedOutput: false,
    pendingPreludeFrames: [],
    finalized: false,
    release,
  };
  state.active = turn;
  try {
    await connectTurnAttempt({
      state,
      ws,
      auth,
      proxy,
      accounting,
      target,
      turn,
      message,
      envelope,
      requestedEffort: typeof requestedEffort === 'string' ? requestedEffort : undefined,
      affinityKey,
      existingThread,
      resolved: initial,
      excludedConnectionIds: [],
    });
  } catch (error) {
    state.active = null;
    await accounting.finalizeCoreRequest(requestId, 'failed', error).catch(() => undefined);
    throw error;
  }
}

type ResolvedCoreTarget = Awaited<ReturnType<InferenceCoreProxyService['resolveTarget']>>;

async function connectTurnAttempt(input: {
  state: ConnectionState;
  ws: WSContext;
  auth: InferenceCoreWebSocketAuth;
  proxy: InferenceCoreProxyService;
  accounting: InferenceCoreAccountingService;
  target: { baseUrl: string; credential: string };
  turn: ActiveTurn;
  message: Record<string, unknown>;
  envelope: Record<string, unknown>;
  requestedEffort?: string;
  affinityKey?: string;
  existingThread: boolean;
  resolved: ResolvedCoreTarget;
  excludedConnectionIds: string[];
}): Promise<void> {
  let resolved = input.resolved;
  if (input.excludedConnectionIds.length > 0) {
    resolved = await input.proxy.resolveTarget(input.auth.user, input.turn.model, {
      ...(input.affinityKey ? { affinityKey: input.affinityKey } : {}),
      existingThread: input.existingThread,
      excludeConnectionIds: input.excludedConnectionIds,
    });
    await input.accounting.retargetCoreRequest(
      input.turn.requestId,
      resolved.selected.source,
      resolved.selected.connection
    );
  }

  const rewritten: Record<string, unknown> = { ...input.message };
  const rewrittenEnvelope: Record<string, unknown> = { ...input.envelope, model: resolved.upstreamModel };
  const mapped = mapReasoningEffort(
    input.requestedEffort,
    resolved.model.defaultReasoningEffort,
    resolved.model.reasoningEfforts,
    resolved.selected.source.reasoningEffortMap
  );
  if (mapped.upstreamEffort) {
    rewrittenEnvelope.reasoning = {
      ...(input.envelope.reasoning && typeof input.envelope.reasoning === 'object'
        ? (input.envelope.reasoning as Record<string, unknown>)
        : {}),
      effort: mapped.upstreamEffort,
    };
  }
  if (asObject(input.message.response)) rewritten.response = rewrittenEnvelope;
  else Object.assign(rewritten, rewrittenEnvelope);

  const { claims } = newCoreRequestContext({
    tenantUserId: input.auth.user.id,
    rootRequestId: input.turn.requestId,
    publicModelId: resolved.model.publicId,
    coreAccountId: resolved.coreAccountId,
    coreModelId: resolved.upstreamModel,
    operation: 'responses',
  });
  let upstream: WebSocketType;
  try {
    upstream = new WebSocket(`${input.target.baseUrl.replace(/^http/, 'ws')}/v1/responses`, {
      headers: coreRequestHeaders(claims, input.target.credential),
    });
  } catch (error) {
    if (resolved.candidateConnectionIds.length > 1) {
      return connectTurnAttempt({
        ...input,
        resolved,
        excludedConnectionIds: [...input.excludedConnectionIds, resolved.selected.connection.id],
      });
    }
    throw error;
  }
  input.turn.upstream = upstream;
  let ended = false;
  let retryAfterClose = false;
  let closeWatchdog: ReturnType<typeof setTimeout> | null = null;

  const clearCloseWatchdog = () => {
    if (!closeWatchdog) return;
    clearTimeout(closeWatchdog);
    closeWatchdog = null;
  };

  const retryOrFail = (error?: unknown, allowConnectionFailover = true) => {
    if (ended) return;
    ended = true;
    clearCloseWatchdog();
    if (input.state.active !== input.turn || input.turn.cancelled || input.turn.finalized) return;
    if (allowConnectionFailover && !input.turn.emittedOutput && resolved.candidateConnectionIds.length > 1) {
      input.turn.pendingPreludeFrames = [];
      void connectTurnAttempt({
        ...input,
        resolved,
        excludedConnectionIds: [...input.excludedConnectionIds, resolved.selected.connection.id],
      }).catch((retryError) => failTurn(input.state, input.ws, input.accounting, input.turn, retryError));
      return;
    }
    failTurn(input.state, input.ws, input.accounting, input.turn, error);
  };

  const retryOnceClosed = () => {
    if (ended || retryAfterClose) return;
    retryAfterClose = true;
    closeWatchdog = setTimeout(() => {
      if (ended || !retryAfterClose) return;
      retryAfterClose = false;
      try {
        upstream.terminate();
      } catch {
        // The connection may already be gone without emitting close.
      }
      retryOrFail();
    }, UPSTREAM_CLOSE_BEFORE_RETRY_MS);
    closeWatchdog.unref?.();
    try {
      upstream.close();
    } catch {
      retryAfterClose = false;
      retryOrFail();
    }
  };

  upstream.on('open', () => upstreamSend(upstream, JSON.stringify(rewritten)));
  upstream.on('unexpected-response', (_request, response) => {
    const error = new CoreWebSocketUpgradeError(response.statusCode ?? null);
    response.resume();
    logger.error('Inference core WebSocket upgrade was rejected', {
      requestId: input.turn.requestId,
      statusCode: error.statusCode,
    });
    // This is a core transport failure, not a provider failure. Rotating across
    // provider connections only repeats the same rejected core handshake.
    retryOrFail(error, false);
  });
  upstream.on('message', (data) => {
    if (ended || input.state.active !== input.turn) return;
    const text = String(data);
    const parsed = asObject(safeParse(text));
    const terminal = parsed !== null && typeof parsed.type === 'string' && TERMINAL_EVENTS.has(parsed.type);
    if (
      terminal &&
      !input.turn.emittedOutput &&
      resolved.candidateConnectionIds.length > 1 &&
      shouldFailOverWsEvent(parsed)
    ) {
      retryOnceClosed();
      return;
    }
    if (terminal) {
      input.turn.terminalSeen = true;
      input.turn.terminalSent = true;
    }
    const eventType = typeof parsed?.type === 'string' ? parsed.type : '';
    if (!terminal && isPreludeEvent(eventType)) {
      if (input.turn.pendingPreludeFrames.length < MAX_PENDING_PRELUDE_FRAMES) {
        input.turn.pendingPreludeFrames.push(text);
      }
      return;
    }
    if (!terminal && !isSubstantiveOutputEvent(eventType)) {
      sendRaw(input.ws, text);
      return;
    }
    flushPreludeFrames(input.ws, input.turn);
    if (!terminal) input.turn.emittedOutput = true;
    sendRaw(input.ws, text);
    if (terminal) {
      ended = true;
      try {
        upstream.close();
      } catch {
        // Already closed.
      }
      if (input.state.active === input.turn) input.state.active = null;
      finalizeTurn(input.accounting, input.turn, terminalOutcome(parsed));
    }
  });
  upstream.on('close', () => {
    if (ended) return;
    if (retryAfterClose) {
      retryAfterClose = false;
      clearCloseWatchdog();
      retryOrFail();
      return;
    }
    if (input.turn.cancelled) {
      ended = true;
      if (input.state.active === input.turn) input.state.active = null;
      if (!input.turn.terminalSent) send(input.ws, cancelledEvent(input.turn.responseId, input.turn.model));
      input.turn.terminalSent = true;
      finalizeTurn(input.accounting, input.turn, 'cancelled');
      return;
    }
    retryOrFail();
  });
  upstream.on('error', (error) => retryOrFail(error));
}

function terminalOutcome(event: Record<string, unknown>): 'completed' | 'failed' {
  return event.type === 'response.completed' ? 'completed' : 'failed';
}

function failTurn(
  state: ConnectionState,
  ws: WSContext,
  accounting: InferenceCoreAccountingService,
  turn: ActiveTurn,
  error?: unknown
): void {
  if (state.active === turn) state.active = null;
  if (!turn.terminalSent) {
    const message =
      error instanceof CoreWebSocketUpgradeError ? error.message : 'The inference core connection ended before output';
    sendError(ws, 502, 'inference_core_unavailable', message);
    turn.terminalSent = true;
  }
  finalizeTurn(accounting, turn, 'failed', error);
}

function finalizeTurn(
  accounting: InferenceCoreAccountingService,
  turn: ActiveTurn,
  outcome: 'completed' | 'failed' | 'cancelled',
  error?: unknown
): void {
  if (turn.finalized) return;
  turn.finalized = true;
  void turn.release().catch(() => undefined);
  const finalized = error
    ? accounting.finalizeCoreRequest(turn.requestId, outcome, error)
    : accounting.finalizeCoreRequest(turn.requestId, outcome);
  void finalized.catch(() => undefined);
}

function endTurn(state: ConnectionState, outcome: 'completed' | 'failed' | 'cancelled'): void {
  const active = state.active;
  state.active = null;
  if (!active) return;
  try {
    active.upstream?.close();
  } catch {
    // Already closed.
  }
  finalizeTurn(container.resolve(InferenceCoreAccountingService), active, outcome);
}

async function revalidateAuth(auth: InferenceCoreWebSocketAuth): Promise<InferenceCoreWebSocketAuth | null> {
  const fresh = await container.resolve(InferenceTokenService).validateToken(auth.rawToken);
  if (!fresh || fresh.tokenId !== auth.tokenId) return null;
  return { user: fresh.user, tokenId: fresh.tokenId, tokenPrefix: fresh.tokenPrefix, rawToken: auth.rawToken };
}

function isAccessRevocation(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const reason = (payload as { reason?: unknown }).reason;
  return reason === 'user_blocked' || reason === 'user_deleted';
}

function closeForRevocation(state: ConnectionState, ws: WSContext): void {
  if (state.closedForRevocation) return;
  state.closedForRevocation = true;
  endTurn(state, 'cancelled');
  state.unsubscribe?.();
  state.unsubscribe = null;
  ws.close(1008, 'Access revoked');
}

function upstreamSend(upstream: WebSocketType, frame: string): void {
  try {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
  } catch {
    // The upstream may have closed between the check and the send.
  }
}

function cancelledEvent(responseId: string, model: string): Record<string, unknown> {
  return {
    type: 'response.cancelled',
    response: {
      id: responseId,
      object: 'response',
      status: 'cancelled',
      model,
      output: [],
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
      },
    },
  };
}

function warmupCompletionFrames(message: Record<string, unknown>): Record<string, unknown>[] {
  const createdAt = Math.floor(Date.now() / 1000);
  const response = {
    id: '',
    object: 'response',
    created_at: createdAt,
    model: typeof message.model === 'string' ? message.model : undefined,
    output: [],
  };
  return [
    { type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress' } },
    { type: 'response.completed', sequence_number: 1, response: { ...response, status: 'completed' } },
  ];
}

function errorEvent(status: number, code: string, message: string): Record<string, unknown> {
  return {
    type: 'error',
    status,
    error: { type: code, code, message },
  };
}

function sendError(ws: WSContext, status: number, code: string, message: string): void {
  send(ws, errorEvent(status, code, message));
}

function send(ws: WSContext, message: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The peer may have closed between an awaited event and this send.
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function hasCompactionTrigger(input: unknown): boolean {
  return (
    Array.isArray(input) &&
    input.some(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).type === 'compaction_trigger'
    )
  );
}

function isPreludeEvent(type: string): boolean {
  return type === 'response.created' || type === 'response.queued' || type === 'response.in_progress';
}

function isSubstantiveOutputEvent(type: string): boolean {
  return type.startsWith('response.') && !isPreludeEvent(type) && !TERMINAL_EVENTS.has(type);
}

function flushPreludeFrames(ws: WSContext, turn: ActiveTurn): void {
  for (const frame of turn.pendingPreludeFrames) sendRaw(ws, frame);
  turn.pendingPreludeFrames = [];
}

function sendRaw(ws: WSContext, frame: string): void {
  try {
    ws.send(frame);
  } catch {
    // The peer may have closed while the upstream frame was in flight.
  }
}

function shouldFailOverWsEvent(event: Record<string, unknown>): boolean {
  const error = asObject(event.error) ?? asObject(asObject(event.response)?.error);
  const code =
    (typeof error?.code === 'string' && error.code) ||
    (typeof error?.type === 'string' && error.type) ||
    'provider_unavailable';
  const rawStatus = event.status ?? error?.status;
  const status =
    typeof rawStatus === 'number' && [401, 408, 409, 429, 502, 503, 504].includes(rawStatus) ? rawStatus : 503;
  return canFailOver(
    new InferenceProtocolError(status as 401 | 409 | 429 | 502 | 503, code, 'The selected provider attempt failed'),
    false
  );
}

function payloadBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
  return Buffer.byteLength(String(value));
}
