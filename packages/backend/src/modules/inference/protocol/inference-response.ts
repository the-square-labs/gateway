import { InferenceProtocolError } from './inference-protocol.error.js';
import type {
  CollectedInferenceResponse,
  InferenceOutputItem,
  InferenceRequest,
  InferenceStreamEvent,
  InferenceUsage,
} from './inference-protocol.types.js';
import { completeUsage } from './inference-usage.js';

interface ItemBuilder {
  type: 'message' | 'reasoning' | 'function_call';
  id: string;
  text: string;
  callId?: string;
  name?: string;
  custom?: boolean;
  signature?: string;
  redactedData?: string;
  phase?: 'commentary' | 'final_answer';
}

export class InferenceResponseCollector {
  private readonly order: string[] = [];
  private readonly builders = new Map<string, ItemBuilder>();
  private readonly completedItems = new Map<string, InferenceOutputItem>();
  private usage: Partial<InferenceUsage> | undefined;
  private finishReason = 'stop';
  private stopSequence: string | undefined;
  private status: CollectedInferenceResponse['status'] = 'in_progress';
  private incompleteReason: string | undefined;

  constructor(
    private readonly request: InferenceRequest,
    private readonly responseId: string,
    private readonly model: string,
    private readonly affinityKey?: string
  ) {}

  consume(event: InferenceStreamEvent): void {
    if (event.type === 'output_text.delta') {
      const builder = this.ensure(event.itemId, 'message');
      builder.text += event.delta;
      if (event.phase) builder.phase = event.phase;
      return;
    }
    if (event.type === 'reasoning.delta') {
      const builder = this.ensure(event.itemId, 'reasoning');
      builder.text += event.delta;
      if (event.signature) builder.signature = event.signature;
      return;
    }
    if (event.type === 'tool_call.delta') {
      const builder = this.ensure(event.itemId, 'function_call');
      builder.callId = event.callId;
      builder.name = event.name;
      builder.custom = event.custom;
      builder.text += event.delta;
      return;
    }
    if (event.type === 'item.done') {
      if (!this.order.includes(event.item.id)) this.order.push(event.item.id);
      this.completedItems.set(event.item.id, event.item);
      return;
    }
    if (event.type === 'completed') {
      this.usage = event.usage;
      this.finishReason = event.finishReason ?? 'stop';
      this.stopSequence = event.stopSequence;
      this.status = event.status ?? 'completed';
      this.incompleteReason = event.incompleteReason;
    }
  }

  result(): CollectedInferenceResponse {
    const items = this.order.map((id) => this.completedItems.get(id) ?? this.buildItem(this.builders.get(id)!));
    return {
      responseId: this.responseId,
      model: this.model,
      items,
      usage: completeUsage(this.usage, this.request.messages, items),
      finishReason: this.finishReason,
      ...(this.stopSequence ? { stopSequence: this.stopSequence } : {}),
      status: this.status,
      ...(this.incompleteReason ? { incompleteReason: this.incompleteReason } : {}),
      affinityKey: this.affinityKey,
    };
  }

  private ensure(id: string, type: ItemBuilder['type']): ItemBuilder {
    const existing = this.builders.get(id);
    if (existing) return existing;
    const builder: ItemBuilder = { type, id, text: '' };
    this.builders.set(id, builder);
    this.order.push(id);
    return builder;
  }

  private buildItem(builder: ItemBuilder): InferenceOutputItem {
    if (builder.type === 'message') {
      return {
        type: 'message',
        id: builder.id,
        role: 'assistant',
        text: builder.text,
        ...(builder.phase ? { phase: builder.phase } : {}),
      };
    }
    if (builder.type === 'reasoning') {
      return {
        type: 'reasoning',
        id: builder.id,
        text: builder.text,
        ...(builder.signature ? { signature: builder.signature } : {}),
        ...(builder.redactedData ? { redactedData: builder.redactedData } : {}),
      };
    }
    return {
      type: 'function_call',
      id: builder.id,
      callId: builder.callId ?? builder.id,
      name: builder.name ?? 'tool',
      arguments: builder.text,
      ...(builder.custom ? { custom: true } : {}),
    };
  }
}

export function responsesUsage(usage: InferenceUsage) {
  const publicOutputTokens = usage.outputTokens + usage.reasoningTokens;
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: { cached_tokens: usage.cachedInputTokens },
    output_tokens: publicOutputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    total_tokens: usage.totalTokens,
  };
}

export function responseItem(item: InferenceOutputItem): Record<string, unknown> {
  switch (item.type) {
    case 'message':
      if (item.raw) {
        return {
          ...item.raw,
          id: item.id,
          status: 'completed',
          ...(item.phase ? { phase: item.phase } : {}),
        };
      }
      return {
        type: 'message',
        id: item.id,
        status: 'completed',
        role: 'assistant',
        content: [
          ...(item.text ? [{ type: 'output_text', annotations: item.annotations ?? [], text: item.text }] : []),
          ...(item.refusal ? [{ type: 'refusal', refusal: item.refusal }] : []),
        ],
        ...(item.phase ? { phase: item.phase } : {}),
      };
    case 'reasoning':
      return {
        type: 'reasoning',
        id: item.id,
        summary: item.text ? [{ type: 'summary_text', text: item.text }] : [],
        ...(item.signature || item.redactedData ? { encrypted_content: item.signature ?? item.redactedData } : {}),
      };
    case 'function_call':
      return {
        type: item.custom ? 'custom_tool_call' : 'function_call',
        id: item.id,
        call_id: item.callId,
        name: item.name,
        ...(item.custom ? { input: item.arguments } : { arguments: item.arguments }),
        status: 'completed',
      };
    case 'hosted':
      return item.raw;
    case 'compaction':
      return { type: 'compaction', id: item.id, encrypted_content: item.encryptedContent };
  }
}

export function responsesJson(result: CollectedInferenceResponse) {
  return {
    id: result.responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: result.status,
    ...(result.status === 'incomplete' ? { incomplete_details: { reason: result.incompleteReason ?? 'unknown' } } : {}),
    model: result.model,
    output: result.items.map(responseItem),
    parallel_tool_calls: true,
    usage: responsesUsage(result.usage),
  };
}

export function chatCompletionsJson(result: CollectedInferenceResponse) {
  assertAdapterOutput(result, 'chat_completions');
  const messages = result.items.filter((item) => item.type === 'message');
  const text = messages.map((item) => item.text).join('');
  const refusal = messages.map((item) => item.refusal ?? '').join('');
  const annotations = messages.flatMap((item) => item.annotations ?? []);
  const reasoning = result.items
    .filter((item) => item.type === 'reasoning')
    .map((item) => item.text)
    .join('');
  const calls = result.items.filter((item) => item.type === 'function_call');
  return {
    id: result.responseId.replace(/^resp_/, 'chatcmpl_'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(refusal ? { refusal } : {}),
          ...(annotations.length ? { annotations } : {}),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(calls.length
            ? {
                tool_calls: calls.map((call) => ({
                  id: call.callId,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        },
        finish_reason: chatFinishReason(result),
      },
    ],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens + result.usage.reasoningTokens,
      total_tokens: result.usage.totalTokens,
      prompt_tokens_details: { cached_tokens: result.usage.cachedInputTokens },
      completion_tokens_details: { reasoning_tokens: result.usage.reasoningTokens },
    },
  };
}

export function anthropicMessagesJson(result: CollectedInferenceResponse) {
  assertAdapterOutput(result, 'messages');
  const content: Array<Record<string, unknown>> = [];
  for (const item of result.items) {
    if (item.type === 'message') {
      if (item.text) content.push({ type: 'text', text: item.text });
      if (item.refusal) content.push({ type: 'text', text: item.refusal });
      continue;
    }
    if (item.type === 'reasoning') {
      if (item.redactedData) {
        content.push({ type: 'redacted_thinking', data: item.redactedData });
        continue;
      }
      content.push({
        type: 'thinking',
        thinking: item.text,
        ...(item.signature ? { signature: item.signature } : {}),
      });
      continue;
    }
    if (item.type === 'function_call') {
      let input: unknown = {};
      try {
        input = JSON.parse(item.arguments);
      } catch {
        input = { value: item.arguments };
      }
      content.push({ type: 'tool_use', id: item.callId, name: item.name, input });
    }
  }
  return {
    id: result.responseId.replace(/^resp_/, 'msg_'),
    type: 'message',
    role: 'assistant',
    model: result.model,
    content,
    stop_reason: anthropicStopReason(result),
    stop_sequence: anthropicStopSequence(result),
    usage: {
      input_tokens: result.usage.inputTokens,
      cache_read_input_tokens: result.usage.cachedInputTokens,
      cache_creation_input_tokens: result.usage.cacheWriteTokens,
      output_tokens: result.usage.outputTokens + result.usage.reasoningTokens,
    },
  };
}

export function chatFinishReason(result: CollectedInferenceResponse): string {
  if (result.items.some((item) => item.type === 'function_call')) return 'tool_calls';
  switch (result.finishReason.toLowerCase()) {
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
      return 'length';
    case 'content_filter':
    case 'refusal':
    case 'safety':
    case 'blocked':
    case 'recitation':
      return 'content_filter';
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

export function anthropicStopReason(result: CollectedInferenceResponse): string {
  if (result.items.some((item) => item.type === 'function_call')) return 'tool_use';
  switch (result.finishReason.toLowerCase()) {
    case 'max_tokens':
    case 'max_output_tokens':
    case 'length':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'tool_use':
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'pause_turn':
      return 'pause_turn';
    case 'refusal':
    case 'content_filter':
    case 'safety':
    case 'blocked':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

export function anthropicStopSequence(result: CollectedInferenceResponse): string | null {
  return anthropicStopReason(result) === 'stop_sequence' ? (result.stopSequence ?? null) : null;
}

function assertAdapterOutput(result: CollectedInferenceResponse, protocol: 'chat_completions' | 'messages'): void {
  for (const item of result.items) {
    if (item.type === 'hosted' || item.type === 'compaction') {
      throw new InferenceProtocolError(
        502,
        'unsupported_provider_output',
        `Upstream output cannot be represented by ${protocol}`
      );
    }
    if (protocol === 'messages' && item.type === 'message' && item.annotations?.length) {
      throw new InferenceProtocolError(
        502,
        'unsupported_provider_output',
        'Upstream annotations cannot be represented by messages'
      );
    }
  }
}
