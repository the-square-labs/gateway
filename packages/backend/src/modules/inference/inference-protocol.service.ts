import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { injectable } from 'tsyringe';
import { getEnv } from '@/config/env.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AppEnv, User } from '@/types.js';
import type { InferenceContinuationService } from './inference-continuation.service.js';
import type { InferenceRuntimeService } from './inference-runtime.service.js';
import type { InferenceModelService } from './models/inference-model.service.js';
import {
  buildCompactV1Output,
  COMPACT_PROMPT,
  compactionItemToText,
  encodeCompactionSummary,
} from './protocol/inference-compaction.js';
import {
  parseAnthropicMessagesRequest,
  parseChatCompletionsRequest,
  parseResponsesRequest,
} from './protocol/inference-parse.js';
import { InferenceProtocolError } from './protocol/inference-protocol.error.js';
import type {
  CollectedInferenceResponse,
  InferenceExecution,
  InferenceMessage,
  InferenceOutputItem,
  InferenceRequest,
} from './protocol/inference-protocol.types.js';
import {
  anthropicMessagesJson,
  chatCompletionsJson,
  InferenceResponseCollector,
  responsesJson,
} from './protocol/inference-response.js';
import { createProtocolStreamEncoder } from './protocol/inference-sse.js';
import { estimateInputTokens } from './protocol/inference-usage.js';

const logger = createChildLogger('InferenceProtocolService');
const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-store',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

@injectable()
export class InferenceProtocolService {
  constructor(
    private readonly runtime: InferenceRuntimeService,
    private readonly continuations: InferenceContinuationService,
    private readonly models?: InferenceModelService
  ) {}

  async responses(c: Context<AppEnv>): Promise<Response> {
    const request = parseResponsesRequest(await this.readJson(c));
    if (request.isCompaction) return this.compactionV2(c, request);
    return this.execute(c, request);
  }

  async chatCompletions(c: Context<AppEnv>): Promise<Response> {
    return this.execute(c, parseChatCompletionsRequest(await this.readJson(c)));
  }

  async messages(c: Context<AppEnv>): Promise<Response> {
    return this.execute(c, parseAnthropicMessagesRequest(await this.readJson(c)));
  }

  async countMessageTokens(c: Context<AppEnv>): Promise<Response> {
    const request = parseAnthropicMessagesRequest(await this.readJson(c));
    const user = c.get('user');
    if (!user) throw new InferenceProtocolError(401, 'invalid_api_key', 'Authentication required');
    if (this.models) await this.models.resolveForUser(user, request.model);
    return Response.json({ input_tokens: estimateInputTokens(request.messages) });
  }

  async search(c: Context<AppEnv>): Promise<Response> {
    const raw = searchBody(await this.readJson(c));
    const request = parseResponsesRequest({
      model: raw.model,
      input: raw.input,
      stream: raw.stream,
      max_output_tokens: raw.maxOutputTokens,
      tools: [{ type: 'web_search' }],
    });
    return this.execute(c, request, {
      operation: 'search',
      apiUnitCharge: { priceKey: 'web_search_query', units: 1 },
    });
  }

  async compact(c: Context<AppEnv>): Promise<Response> {
    const request = parseResponsesRequest(await this.readJson(c));
    request.stream = false;
    const prepared = await this.prepare(c, request);
    const compacted = await this.runCompaction(prepared.request, prepared.context, prepared.affinityKey);
    return Response.json({ output: buildCompactV1Output(prepared.request.messages, compacted.summary) });
  }

  async prepareWebSocket(
    request: InferenceRequest,
    auth: { user: User; tokenId: string },
    signal: AbortSignal,
    requestId: string
  ): Promise<Omit<PreparedExecution, 'abortController'>> {
    if (this.models) await this.models.resolveForUser(auth.user, request.model);
    let affinityKey = request.promptCacheKey;
    let existingThread = false;
    if (request.previousResponseId) {
      const previous = await this.continuations.load(request.previousResponseId, auth.user.id);
      if (previous.status !== 'found') {
        throw new InferenceProtocolError(404, 'previous_response_not_found', 'Previous response is unavailable');
      }
      request.messages = [
        ...previous.payload.messages,
        ...outputToMessages(previous.payload.output),
        ...request.messages,
      ];
      affinityKey = previous.payload.affinityKey ?? affinityKey;
      existingThread = true;
    }
    if (Buffer.byteLength(JSON.stringify(request.messages)) > getEnv().INFERENCE_CONTINUATION_MAX_BYTES) {
      throw new InferenceProtocolError(413, 'context_too_large', 'Request context exceeds the continuation limit');
    }
    return {
      request,
      userId: auth.user.id,
      affinityKey,
      context: {
        requestId,
        userId: auth.user.id,
        tokenId: auth.tokenId,
        affinityKey,
        existingThread,
        signal,
      },
    };
  }

  async rememberWebSocket(
    request: InferenceRequest,
    result: CollectedInferenceResponse,
    userId: string
  ): Promise<void> {
    await this.remember(request, result, userId);
  }

  private async compactionV2(c: Context<AppEnv>, request: InferenceRequest): Promise<Response> {
    const prepared = await this.prepare(c, request);
    const compacted = await this.runCompaction(prepared.request, prepared.context, prepared.affinityKey);
    const item: InferenceOutputItem = {
      type: 'compaction',
      id: `cmp_${randomUUID()}`,
      encryptedContent: encodeCompactionSummary(compacted.summary),
    };
    const result: CollectedInferenceResponse = {
      responseId: compacted.responseId,
      model: compacted.model,
      items: [item],
      usage: compacted.usage,
      finishReason: 'stop',
      status: 'completed',
      affinityKey: compacted.affinityKey,
    };
    await this.remember(prepared.request, result, prepared.userId);

    if (!request.stream) return Response.json(responsesJson(result));
    const encoder = createProtocolStreamEncoder('responses', result.responseId, result.model);
    const chunks = [...encoder.start(), ...encoder.event({ type: 'item.done', item }), ...encoder.complete(result)];
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      { headers: streamHeaders(request) }
    );
  }

  private async runCompaction(
    request: InferenceRequest,
    context: PreparedExecution['context'],
    affinityKey?: string
  ): Promise<{ summary: string } & CollectedInferenceResponse> {
    const compactRequest: InferenceRequest = {
      ...request,
      stream: false,
      tools: [],
      toolChoice: undefined,
      isCompaction: true,
      messages: [...request.messages, { role: 'user', content: [{ type: 'text', text: COMPACT_PROMPT }] }],
    };
    const execution = await this.runtime.execute(compactRequest, context);
    const result = await this.collect(compactRequest, execution, affinityKey);
    const summary = result.items
      .filter((item) => item.type === 'message' || item.type === 'reasoning')
      .map((item) => item.text)
      .join('\n')
      .trim();
    if (!summary) throw new InferenceProtocolError(502, 'upstream_error', 'Compaction produced no summary');
    return { ...result, summary };
  }

  private async execute(
    c: Context<AppEnv>,
    request: InferenceRequest,
    accounting?: Pick<PreparedExecution['context'], 'operation' | 'apiUnitCharge'>
  ): Promise<Response> {
    const prepared = await this.prepare(c, request, accounting);
    const execution = await this.runtime.execute(prepared.request, prepared.context);
    if (prepared.request.stream) {
      return this.stream(prepared.request, execution, prepared.userId, prepared.affinityKey, prepared.abortController);
    }

    const result = await this.collect(prepared.request, execution, prepared.affinityKey);
    await this.remember(prepared.request, result, prepared.userId);
    if (prepared.request.protocol === 'chat_completions') return Response.json(chatCompletionsJson(result));
    if (prepared.request.protocol === 'messages') return Response.json(anthropicMessagesJson(result));
    return Response.json(responsesJson(result));
  }

  private async prepare(
    c: Context<AppEnv>,
    request: InferenceRequest,
    accounting?: Pick<PreparedExecution['context'], 'operation' | 'apiUnitCharge'>
  ): Promise<PreparedExecution> {
    const user = c.get('user');
    const auth = c.get('inferenceAuth');
    if (!user || !auth) throw new InferenceProtocolError(401, 'invalid_api_key', 'Authentication required');
    const idempotencyKey = c.req.header('Idempotency-Key');
    if (idempotencyKey && request.extensions.idempotency_key === undefined) {
      request.extensions.idempotency_key = idempotencyKey;
    }
    if (this.models) await this.models.resolveForUser(user, request.model);

    let affinityKey = request.promptCacheKey;
    let existingThread = false;
    if (request.previousResponseId) {
      const previous = await this.continuations.load(request.previousResponseId, user.id);
      if (previous.status !== 'found') {
        throw new InferenceProtocolError(404, 'previous_response_not_found', 'Previous response is unavailable');
      }
      request.messages = [
        ...previous.payload.messages,
        ...outputToMessages(previous.payload.output),
        ...request.messages,
      ];
      affinityKey = previous.payload.affinityKey ?? affinityKey;
      existingThread = true;
    }

    const serializedBytes = Buffer.byteLength(JSON.stringify(request.messages));
    if (serializedBytes > getEnv().INFERENCE_CONTINUATION_MAX_BYTES) {
      throw new InferenceProtocolError(413, 'context_too_large', 'Request context exceeds the continuation limit');
    }

    const abortController = new AbortController();
    if (c.req.raw.signal.aborted) abortController.abort(c.req.raw.signal.reason);
    else
      c.req.raw.signal.addEventListener('abort', () => abortController.abort(c.req.raw.signal.reason), { once: true });
    return {
      request,
      userId: user.id,
      affinityKey,
      abortController,
      context: {
        requestId: c.get('requestId') ?? randomUUID(),
        userId: user.id,
        tokenId: auth.tokenId,
        affinityKey,
        existingThread,
        ...accounting,
        signal: abortController.signal,
      },
    };
  }

  private stream(
    request: InferenceRequest,
    execution: InferenceExecution,
    userId: string,
    affinityKey: string | undefined,
    abortController: AbortController
  ): Response {
    const collector = new InferenceResponseCollector(
      request,
      execution.responseId,
      execution.resolvedModel,
      execution.affinityKey ?? affinityKey
    );
    const protocolEncoder = createProtocolStreamEncoder(
      request.protocol,
      execution.responseId,
      execution.resolvedModel
    );
    const service = this;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (const chunk of protocolEncoder.start()) controller.enqueue(chunk);
          for await (const event of execution.events) {
            if (event.type === 'error') {
              for (const chunk of protocolEncoder.error(event.code, event.message)) controller.enqueue(chunk);
              controller.close();
              return;
            }
            collector.consume(event);
            for (const chunk of protocolEncoder.event(event)) controller.enqueue(chunk);
          }
          const result = collector.result();
          for (const chunk of protocolEncoder.complete(result)) controller.enqueue(chunk);
          await service.remember(request, result, userId);
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Upstream stream failed';
          for (const chunk of protocolEncoder.error('upstream_error', message)) controller.enqueue(chunk);
          controller.close();
        }
      },
      cancel(reason) {
        abortController.abort(reason);
      },
    });
    return new Response(stream, { headers: streamHeaders(request) });
  }

  private async collect(
    request: InferenceRequest,
    execution: InferenceExecution,
    affinityKey?: string
  ): Promise<CollectedInferenceResponse> {
    const collector = new InferenceResponseCollector(
      request,
      execution.responseId,
      execution.resolvedModel,
      execution.affinityKey ?? affinityKey
    );
    for await (const event of execution.events) {
      if (event.type === 'error') throw new InferenceProtocolError(502, event.code, event.message);
      collector.consume(event);
    }
    return collector.result();
  }

  private async remember(request: InferenceRequest, result: CollectedInferenceResponse, userId: string): Promise<void> {
    if (result.status !== 'completed') return;
    try {
      await this.continuations.remember(result.responseId, {
        userId,
        model: result.model,
        messages: request.messages,
        output: result.items,
        affinityKey: result.affinityKey,
      });
    } catch (error) {
      logger.warn('Failed to persist inference continuation', { responseId: result.responseId, error });
    }
  }

  private async readJson(c: Context<AppEnv>): Promise<unknown> {
    try {
      return await c.req.json();
    } catch {
      throw new InferenceProtocolError(400, 'invalid_request_error', 'Request body must be valid JSON');
    }
  }
}

function streamHeaders(request: InferenceRequest): Record<string, string> {
  return {
    ...STREAM_HEADERS,
    ...(request.reasoningEffort && request.reasoningEffort !== 'none' ? { 'x-reasoning-included': 'true' } : {}),
  };
}

interface PreparedExecution {
  request: InferenceRequest;
  userId: string;
  affinityKey?: string;
  abortController: AbortController;
  context: {
    requestId: string;
    userId: string;
    tokenId: string;
    affinityKey?: string;
    existingThread?: boolean;
    operation?: 'inference' | 'search';
    apiUnitCharge?: { priceKey: string; units: number };
    signal: AbortSignal;
  };
}

function searchBody(value: unknown): {
  model: string;
  input: unknown;
  stream: boolean;
  maxOutputTokens?: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InferenceProtocolError(400, 'invalid_request_error', 'Request body must be an object');
  }
  const raw = value as Record<string, unknown>;
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  const input = raw.input ?? raw.query;
  if (!model || (typeof input !== 'string' && !Array.isArray(input))) {
    throw new InferenceProtocolError(400, 'invalid_request_error', 'model and query or input are required');
  }
  if (
    raw.max_output_tokens !== undefined &&
    (typeof raw.max_output_tokens !== 'number' || !Number.isInteger(raw.max_output_tokens))
  ) {
    throw new InferenceProtocolError(400, 'invalid_request_error', 'max_output_tokens must be an integer');
  }
  return {
    model,
    input,
    stream: raw.stream === true,
    ...(typeof raw.max_output_tokens === 'number' ? { maxOutputTokens: raw.max_output_tokens } : {}),
  };
}

function outputToMessages(output: InferenceOutputItem[]): InferenceMessage[] {
  const content: InferenceMessage['content'] = [];
  for (const item of output) {
    if (item.type === 'message') {
      content.push({ type: 'text', text: item.text });
      continue;
    }
    if (item.type === 'reasoning') {
      content.push({
        type: 'reasoning',
        id: item.id,
        text: item.text,
        ...(item.signature ? { signature: item.signature } : {}),
        ...(item.redactedData ? { redactedData: item.redactedData } : {}),
      });
      continue;
    }
    if (item.type === 'function_call') {
      content.push({
        type: 'tool_call',
        id: item.id,
        callId: item.callId,
        name: item.name,
        arguments: item.arguments,
        ...(item.custom ? { custom: true } : {}),
      });
      continue;
    }
    if (item.type === 'hosted') {
      content.push({ type: 'hosted', raw: item.raw });
      continue;
    }
    content.push({ type: 'text', text: compactionItemToText(item.encryptedContent) });
  }
  return content.length > 0 ? [{ role: 'assistant', content }] : [];
}

export function inferenceProtocolError(error: unknown): InferenceProtocolError {
  if (error instanceof InferenceProtocolError) return error;
  if (error instanceof AppError) {
    const status = error.statusCode as InferenceProtocolError['status'];
    return new InferenceProtocolError(status, error.code.toLowerCase(), error.message);
  }
  return new InferenceProtocolError(500, 'internal_error', error instanceof Error ? error.message : 'Internal error');
}
