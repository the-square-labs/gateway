import { InferenceProtocolError } from './inference-protocol.error.js';
import type {
  CollectedInferenceResponse,
  InferenceProtocol,
  InferenceStreamEvent,
} from './inference-protocol.types.js';
import { anthropicStopReason, anthropicStopSequence, chatFinishReason } from './inference-response.js';
import { ResponsesEventEncoder } from './inference-responses-events.js';

const encoder = new TextEncoder();

export function sseEvent(data: unknown, event?: string): Uint8Array {
  const prefix = event ? `event: ${event}\n` : '';
  return encoder.encode(`${prefix}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

export interface ProtocolStreamEncoder {
  start(): Uint8Array[];
  event(event: InferenceStreamEvent): Uint8Array[];
  complete(result: CollectedInferenceResponse): Uint8Array[];
  error(code: string, message: string): Uint8Array[];
}

export function createProtocolStreamEncoder(
  protocol: InferenceProtocol,
  responseId: string,
  model: string
): ProtocolStreamEncoder {
  if (protocol === 'chat_completions') return chatEncoder(responseId, model);
  if (protocol === 'messages') return anthropicEncoder(responseId, model);
  return responsesEncoder(responseId, model);
}

function responsesEncoder(responseId: string, model: string): ProtocolStreamEncoder {
  const responses = new ResponsesEventEncoder(responseId, model);
  const encode = (message: Record<string, unknown>) => sseEvent(message, String(message.type));
  return {
    start: () => responses.start().map(encode),
    event: (event) => responses.event(event).map(encode),
    complete: (result) => responses.complete(result).map(encode),
    error: (code, message) => [encode(responses.streamError(code, message))],
  };
}

function chatEncoder(responseId: string, model: string): ProtocolStreamEncoder {
  const id = responseId.replace(/^resp_/, 'chatcmpl_');
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: unknown) =>
    sseEvent({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    });
  const toolIndexes = new Map<string, number>();
  const textItems = new Set<string>();
  return {
    start: () => [chunk({ role: 'assistant', content: '' })],
    event: (event) => {
      if (event.type === 'output_text.delta') {
        textItems.add(event.itemId);
        return [chunk({ content: event.delta })];
      }
      if (event.type === 'reasoning.delta') return [chunk({ reasoning_content: event.delta })];
      if (event.type === 'tool_call.delta') {
        if (!toolIndexes.has(event.itemId)) toolIndexes.set(event.itemId, toolIndexes.size);
        return [
          chunk({
            tool_calls: [
              {
                index: toolIndexes.get(event.itemId),
                id: event.callId,
                type: 'function',
                function: { name: event.name, arguments: event.delta },
              },
            ],
          }),
        ];
      }
      if (event.type === 'item.done') {
        if (event.item.type === 'hosted' || event.item.type === 'compaction') {
          throw unsupportedStreamOutput('chat_completions');
        }
        if (event.item.type === 'message') {
          return [
            chunk({
              ...(!textItems.has(event.item.id) && event.item.text ? { content: event.item.text } : {}),
              ...(event.item.refusal ? { refusal: event.item.refusal } : {}),
              ...(event.item.annotations?.length ? { annotations: event.item.annotations } : {}),
            }),
          ];
        }
      }
      return [];
    },
    complete: (result) => [
      chunk({}, chatFinishReason(result), {
        prompt_tokens: result.usage.inputTokens,
        completion_tokens: result.usage.outputTokens + result.usage.reasoningTokens,
        total_tokens: result.usage.totalTokens,
      }),
      sseEvent('[DONE]'),
    ],
    error: (code, message) => [sseEvent({ error: { code, message } }), sseEvent('[DONE]')],
  };
}

function anthropicEncoder(responseId: string, model: string): ProtocolStreamEncoder {
  const id = responseId.replace(/^resp_/, 'msg_');
  const indexes = new Map<string, number>();
  const started = new Set<string>();
  return {
    start: () => [
      sseEvent(
        {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
        'message_start'
      ),
    ],
    event: (event) => {
      if (
        event.type !== 'output_text.delta' &&
        event.type !== 'reasoning.delta' &&
        event.type !== 'tool_call.delta' &&
        event.type !== 'item.done'
      )
        return [];
      if (event.type === 'item.done') {
        if (event.item.type === 'hosted' || event.item.type === 'compaction') {
          throw unsupportedStreamOutput('messages');
        }
        if (event.item.type === 'message' && event.item.annotations?.length) {
          throw new InferenceProtocolError(
            502,
            'unsupported_provider_output',
            'Upstream annotations cannot be represented by messages'
          );
        }
        let index = indexes.get(event.item.id);
        const chunks: Uint8Array[] = [];
        if (index === undefined && event.item.type === 'message') {
          index = indexes.size;
          indexes.set(event.item.id, index);
          started.add(event.item.id);
          chunks.push(
            sseEvent(
              { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
              'content_block_start'
            )
          );
          for (const text of [event.item.text, event.item.refusal].filter(Boolean)) {
            chunks.push(
              sseEvent(
                { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
                'content_block_delta'
              )
            );
          }
        } else if (index !== undefined && event.item.type === 'message' && event.item.refusal) {
          chunks.push(
            sseEvent(
              { type: 'content_block_delta', index, delta: { type: 'text_delta', text: event.item.refusal } },
              'content_block_delta'
            )
          );
        } else if (index === undefined && event.item.type === 'reasoning') {
          index = indexes.size;
          indexes.set(event.item.id, index);
          started.add(event.item.id);
          if (event.item.redactedData) {
            chunks.push(
              sseEvent(
                {
                  type: 'content_block_start',
                  index,
                  content_block: { type: 'redacted_thinking', data: event.item.redactedData },
                },
                'content_block_start'
              )
            );
          } else {
            chunks.push(
              sseEvent(
                { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
                'content_block_start'
              )
            );
            if (event.item.text) {
              chunks.push(
                sseEvent(
                  { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: event.item.text } },
                  'content_block_delta'
                )
              );
            }
            if (event.item.signature) {
              chunks.push(
                sseEvent(
                  {
                    type: 'content_block_delta',
                    index,
                    delta: { type: 'signature_delta', signature: event.item.signature },
                  },
                  'content_block_delta'
                )
              );
            }
          }
        }
        if (index !== undefined) {
          chunks.push(sseEvent({ type: 'content_block_stop', index }, 'content_block_stop'));
        }
        return chunks;
      }
      if (!indexes.has(event.itemId)) indexes.set(event.itemId, indexes.size);
      const index = indexes.get(event.itemId)!;
      const chunks: Uint8Array[] = [];
      if (event.type === 'output_text.delta' && !started.has(event.itemId)) {
        started.add(event.itemId);
        chunks.push(
          sseEvent(
            { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
            'content_block_start'
          )
        );
      } else if (event.type === 'reasoning.delta' && !started.has(event.itemId)) {
        started.add(event.itemId);
        chunks.push(
          sseEvent(
            { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
            'content_block_start'
          )
        );
      } else if (event.type === 'tool_call.delta' && !started.has(event.itemId)) {
        started.add(event.itemId);
        chunks.push(
          sseEvent(
            {
              type: 'content_block_start',
              index,
              content_block: { type: 'tool_use', id: event.callId, name: event.name, input: {} },
            },
            'content_block_start'
          )
        );
      }
      const delta =
        event.type === 'output_text.delta'
          ? { type: 'text_delta', text: event.delta }
          : event.type === 'reasoning.delta'
            ? { type: 'thinking_delta', thinking: event.delta }
            : { type: 'input_json_delta', partial_json: event.delta };
      if (event.type !== 'reasoning.delta' || event.delta) {
        chunks.push(sseEvent({ type: 'content_block_delta', index, delta }, 'content_block_delta'));
      }
      if (event.type === 'reasoning.delta' && event.signature) {
        chunks.push(
          sseEvent(
            { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: event.signature } },
            'content_block_delta'
          )
        );
      }
      return chunks;
    },
    complete: (result) => [
      sseEvent(
        {
          type: 'message_delta',
          delta: {
            stop_reason: anthropicStopReason(result),
            stop_sequence: anthropicStopSequence(result),
          },
          usage: { output_tokens: result.usage.outputTokens + result.usage.reasoningTokens },
        },
        'message_delta'
      ),
      sseEvent({ type: 'message_stop' }, 'message_stop'),
    ],
    error: (code, message) => [sseEvent({ type: 'error', error: { type: code, message } }, 'error')],
  };
}

function unsupportedStreamOutput(protocol: 'chat_completions' | 'messages'): InferenceProtocolError {
  return new InferenceProtocolError(
    502,
    'unsupported_provider_output',
    `Upstream output cannot be represented by ${protocol}`
  );
}
