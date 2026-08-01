import { randomUUID } from 'node:crypto';
import type { WSContext, WSEvents } from 'hono/ws';
import { container } from '@/container.js';
import { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import { acquireInferenceConcurrency, consumeInferenceRateLimit } from './inference-limit.middleware.js';
import { InferenceProtocolService, inferenceProtocolError } from './inference-protocol.service.js';
import { InferenceRuntimeService } from './inference-runtime.service.js';
import { InferenceTokenService } from './inference-token.service.js';
import { parseResponsesRequest } from './protocol/inference-parse.js';
import { InferenceResponseCollector } from './protocol/inference-response.js';
import { ResponsesEventEncoder } from './protocol/inference-responses-events.js';

export interface InferenceWebSocketAuth {
  user: User;
  tokenId: string;
  tokenPrefix: string;
  /** Raw token is retained only per connection to revalidate each new request. */
  rawToken: string;
}

interface ConnectionState {
  active: ActiveResponse | null;
  unsubscribe: (() => void) | null;
  closedForRevocation: boolean;
}

interface ActiveResponse {
  controller: AbortController;
  responseId: string;
  model: string;
  encoder: ResponsesEventEncoder;
  cancelled: boolean;
  terminalSent: boolean;
}

export function createInferenceResponsesWSHandlers(
  auth: InferenceWebSocketAuth | null,
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
        if (state.active) cancelActiveResponse(state.active, ws);
        return;
      }
      if (message.type !== 'response.create') {
        sendError(ws, 400, 'invalid_request_error', 'Unsupported WebSocket event');
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
      const envelope = asObject(message.response) ?? message;
      const generate = message.generate !== false && envelope.generate !== false;
      const payload = responsePayload(envelope);
      const controller = new AbortController();
      const requestId = randomUUID();
      const requestedModel = typeof payload.model === 'string' ? payload.model : 'unknown';
      const active: ActiveResponse = {
        controller,
        responseId: `resp_${requestId}`,
        model: requestedModel,
        encoder: new ResponsesEventEncoder(`resp_${requestId}`, requestedModel),
        cancelled: false,
        terminalSent: false,
      };
      state.active = active;
      let release: (() => Promise<void>) | null = null;
      try {
        const request = parseResponsesRequest({ ...payload, stream: true });
        const protocol = container.resolve(InferenceProtocolService);
        const prepared = await protocol.prepareWebSocket(request, freshAuth, controller.signal, requestId);
        if (active.cancelled) return;
        if (!generate) {
          const responseId = `resp_${randomUUID()}`;
          const collector = new InferenceResponseCollector(
            prepared.request,
            responseId,
            prepared.request.model,
            prepared.affinityKey
          );
          collector.consume({
            type: 'completed',
            status: 'completed',
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          });
          send(ws, {
            type: 'response.created',
            response: { id: responseId, model: prepared.request.model, status: 'in_progress' },
          });
          await protocol.rememberWebSocket(prepared.request, collector.result(), prepared.userId);
          send(ws, {
            type: 'response.completed',
            response: {
              id: responseId,
              model: prepared.request.model,
              status: 'completed',
              output: [],
              usage: {
                input_tokens: 0,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: 0,
                output_tokens_details: { reasoning_tokens: 0 },
                total_tokens: 0,
              },
            },
          });
          active.terminalSent = true;
          return;
        }
        release = await acquireInferenceConcurrency(freshAuth);
        if (active.cancelled) return;
        const execution = await container.resolve(InferenceRuntimeService).execute(prepared.request, prepared.context);
        if (active.cancelled) return;
        active.responseId = execution.responseId;
        active.model = execution.resolvedModel;
        active.encoder = new ResponsesEventEncoder(execution.responseId, execution.resolvedModel);
        const collector = new InferenceResponseCollector(
          prepared.request,
          execution.responseId,
          execution.resolvedModel,
          execution.affinityKey ?? prepared.affinityKey
        );
        const encoder = active.encoder;
        for (const message of encoder.start()) send(ws, message);
        for await (const item of execution.events) {
          if (active.cancelled) return;
          collector.consume(item);
          for (const message of encoder.event(item)) send(ws, message);
        }
        if (active.cancelled) return;
        const result = collector.result();
        for (const message of encoder.complete(result)) send(ws, message);
        active.terminalSent = true;
        await protocol.rememberWebSocket(prepared.request, result, prepared.userId);
      } catch (error) {
        if (active.cancelled) {
          if (!active.terminalSent) {
            send(ws, active.encoder.cancelled());
            active.terminalSent = true;
          }
          return;
        }
        const protocol = inferenceProtocolError(error);
        sendError(ws, protocol.status, protocol.code, protocol.message);
      } finally {
        if (release) await release();
        if (state.active === active) state.active = null;
      }
    },
    onClose() {
      state.active?.controller.abort(new Error('WebSocket closed'));
      state.active = null;
      state.unsubscribe?.();
      state.unsubscribe = null;
    },
    onError() {
      state.active?.controller.abort(new Error('WebSocket failed'));
      state.active = null;
      state.unsubscribe?.();
      state.unsubscribe = null;
    },
  };
}

async function revalidateAuth(auth: InferenceWebSocketAuth): Promise<InferenceWebSocketAuth | null> {
  const fresh = await container.resolve(InferenceTokenService).validateToken(auth.rawToken);
  if (!fresh || fresh.tokenId !== auth.tokenId) return null;
  return { ...fresh, rawToken: auth.rawToken };
}

function isAccessRevocation(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const reason = (payload as { reason?: unknown }).reason;
  return reason === 'user_blocked' || reason === 'user_deleted';
}

function closeForRevocation(state: ConnectionState, ws: WSContext): void {
  if (state.closedForRevocation) return;
  state.closedForRevocation = true;
  if (state.active) cancelActiveResponse(state.active, ws, 'Access revoked');
  state.unsubscribe?.();
  state.unsubscribe = null;
  ws.close(1008, 'Access revoked');
}

function cancelActiveResponse(active: ActiveResponse, ws: WSContext, reason = 'Client cancelled'): void {
  if (active.cancelled) return;
  active.cancelled = true;
  active.controller.abort(new Error(reason));
  if (!active.terminalSent) {
    send(ws, active.encoder.cancelled());
    active.terminalSent = true;
  }
}

function responsePayload(envelope: Record<string, unknown>): Record<string, unknown> {
  const { type: _type, generate: _generate, ...payload } = envelope;
  return payload;
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
    // The peer may have closed between an awaited provider event and this send.
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function payloadBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
  return Buffer.byteLength(String(value));
}
