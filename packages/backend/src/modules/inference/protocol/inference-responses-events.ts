import type {
  CollectedInferenceResponse,
  InferenceOutputItem,
  InferenceStreamEvent,
} from './inference-protocol.types.js';
import { responseItem, responsesJson } from './inference-response.js';

export class ResponsesEventEncoder {
  private readonly started = new Map<string, InferenceOutputItem['type']>();
  private sequence = 0;

  constructor(
    private readonly responseId: string,
    private readonly model: string
  ) {}

  start(): Record<string, unknown>[] {
    const response = { id: this.responseId, object: 'response', status: 'in_progress', model: this.model, output: [] };
    return [this.payload('response.created', { response }), this.payload('response.in_progress', { response })];
  }

  event(event: InferenceStreamEvent): Record<string, unknown>[] {
    const messages = this.ensure(event);
    if (event.type === 'output_text.delta') {
      messages.push(
        this.payload('response.output_text.delta', {
          item_id: event.itemId,
          output_index: this.outputIndex(event.itemId),
          content_index: 0,
          delta: event.delta,
        })
      );
    } else if (event.type === 'reasoning.delta') {
      messages.push(
        this.payload('response.reasoning_summary_text.delta', {
          item_id: event.itemId,
          output_index: this.outputIndex(event.itemId),
          summary_index: 0,
          delta: event.delta,
        })
      );
    } else if (event.type === 'tool_call.delta') {
      messages.push(
        this.payload(
          event.custom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta',
          {
            item_id: event.itemId,
            output_index: this.outputIndex(event.itemId),
            delta: event.delta,
          }
        )
      );
    } else if (event.type === 'item.done') {
      this.done(event.item, messages);
    }
    return messages;
  }

  complete(result: CollectedInferenceResponse): Record<string, unknown>[] {
    if (result.status === 'in_progress') {
      return [this.error(502, 'upstream_stream_incomplete', 'Upstream stream ended without a terminal event')];
    }
    return [this.payload(`response.${result.status}`, { response: responsesJson(result) })];
  }

  cancelled(): Record<string, unknown> {
    return this.payload('response.cancelled', {
      response: {
        id: this.responseId,
        object: 'response',
        status: 'cancelled',
        model: this.model,
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
  }

  error(status: number, code: string, message: string): Record<string, unknown> {
    return {
      type: 'error',
      sequence_number: this.sequence++,
      status,
      error: { type: code, code, message },
    };
  }

  streamError(code: string, message: string): Record<string, unknown> {
    return this.payload('error', { code, message, param: null });
  }

  private ensure(event: InferenceStreamEvent): Record<string, unknown>[] {
    if (!('itemId' in event) || this.started.has(event.itemId)) return [];
    if (event.type === 'output_text.delta') {
      this.started.set(event.itemId, 'message');
      const index = this.outputIndex(event.itemId);
      return [
        this.payload('response.output_item.added', {
          output_index: index,
          item: {
            type: 'message',
            id: event.itemId,
            status: 'in_progress',
            role: 'assistant',
            content: [],
            ...(event.phase ? { phase: event.phase } : {}),
          },
        }),
        this.payload('response.content_part.added', {
          item_id: event.itemId,
          output_index: index,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }),
      ];
    }
    if (event.type === 'reasoning.delta') {
      this.started.set(event.itemId, 'reasoning');
      const index = this.outputIndex(event.itemId);
      return [
        this.payload('response.output_item.added', {
          output_index: index,
          item: { type: 'reasoning', id: event.itemId, summary: [] },
        }),
        this.reasoningPartAdded(event.itemId, index),
      ];
    }
    if (event.type === 'tool_call.delta') {
      this.started.set(event.itemId, 'function_call');
      return [
        this.payload('response.output_item.added', {
          output_index: this.outputIndex(event.itemId),
          item: {
            type: event.custom ? 'custom_tool_call' : 'function_call',
            id: event.itemId,
            call_id: event.callId,
            name: event.name,
            ...(event.custom ? { input: '' } : { arguments: '' }),
            status: 'in_progress',
          },
        }),
      ];
    }
    return [];
  }

  private done(item: InferenceOutputItem, messages: Record<string, unknown>[]): void {
    if (!this.started.has(item.id)) {
      this.started.set(item.id, item.type);
      const index = this.outputIndex(item.id);
      messages.push(
        this.payload('response.output_item.added', {
          output_index: index,
          item: responseItem(item),
        })
      );
      if (item.type === 'reasoning') messages.push(this.reasoningPartAdded(item.id, index));
      if (item.type === 'message') {
        for (const [contentIndex, part] of messageContent(item).entries()) {
          messages.push(
            this.payload('response.content_part.added', {
              item_id: item.id,
              output_index: index,
              content_index: contentIndex,
              part: emptyContentPart(part),
            })
          );
        }
      }
    }
    const index = this.outputIndex(item.id);
    if (item.type === 'message') {
      for (const [contentIndex, part] of messageContent(item).entries()) {
        if (part.type === 'output_text') {
          messages.push(
            this.payload('response.output_text.done', {
              item_id: item.id,
              output_index: index,
              content_index: contentIndex,
              text: part.text,
            })
          );
        } else if (part.type === 'refusal') {
          messages.push(
            this.payload('response.refusal.done', {
              item_id: item.id,
              output_index: index,
              content_index: contentIndex,
              refusal: part.refusal,
            })
          );
        }
        messages.push(
          this.payload('response.content_part.done', {
            item_id: item.id,
            output_index: index,
            content_index: contentIndex,
            part,
          })
        );
      }
    } else if (item.type === 'reasoning') {
      messages.push(
        this.payload('response.reasoning_summary_text.done', {
          item_id: item.id,
          output_index: index,
          summary_index: 0,
          text: item.text,
        }),
        this.payload('response.reasoning_summary_part.done', {
          item_id: item.id,
          output_index: index,
          summary_index: 0,
          part: { type: 'summary_text', text: item.text },
        })
      );
    } else if (item.type === 'function_call') {
      messages.push(
        this.payload(item.custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done', {
          item_id: item.id,
          output_index: index,
          ...(item.custom ? { input: item.arguments } : { arguments: item.arguments }),
        })
      );
    }
    messages.push(
      this.payload('response.output_item.done', {
        output_index: index,
        item: responseItem(item),
      })
    );
  }

  private reasoningPartAdded(itemId: string, outputIndex: number): Record<string, unknown> {
    return this.payload('response.reasoning_summary_part.added', {
      item_id: itemId,
      output_index: outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    });
  }

  private outputIndex(itemId: string): number {
    return [...this.started.keys()].indexOf(itemId);
  }

  private payload(type: string, value: Record<string, unknown>): Record<string, unknown> {
    return { type, sequence_number: this.sequence++, ...value };
  }
}

type ResponseMessagePart =
  | { type: 'output_text'; text: string; annotations: unknown[] }
  | { type: 'refusal'; refusal: string };

function messageContent(item: Extract<InferenceOutputItem, { type: 'message' }>): ResponseMessagePart[] {
  if (item.raw && Array.isArray(item.raw.content)) {
    return item.raw.content.filter(isResponseMessagePart) as ResponseMessagePart[];
  }
  return [
    ...(item.text ? [{ type: 'output_text' as const, text: item.text, annotations: item.annotations ?? [] }] : []),
    ...(item.refusal ? [{ type: 'refusal' as const, refusal: item.refusal }] : []),
  ];
}

function isResponseMessagePart(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const part = value as Record<string, unknown>;
  return (
    (part.type === 'output_text' && typeof part.text === 'string') ||
    (part.type === 'refusal' && typeof part.refusal === 'string')
  );
}

function emptyContentPart(part: ResponseMessagePart): ResponseMessagePart {
  return part.type === 'output_text'
    ? { type: 'output_text', text: '', annotations: [] }
    : { type: 'refusal', refusal: '' };
}
