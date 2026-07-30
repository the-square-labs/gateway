import { describe, expect, it } from 'vitest';
import type { CollectedInferenceResponse } from './inference-protocol.types.js';
import {
  anthropicMessagesJson,
  anthropicStopReason,
  chatCompletionsJson,
  chatFinishReason,
  responsesJson,
} from './inference-response.js';
import { createProtocolStreamEncoder } from './inference-sse.js';
import { completeUsage } from './inference-usage.js';

const RESULT: CollectedInferenceResponse = {
  responseId: 'resp_1',
  model: 'logical-model',
  items: [{ type: 'message', id: 'msg_1', role: 'assistant', text: 'Done' }],
  usage: {
    inputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 2,
    reasoningTokens: 0,
    totalTokens: 12,
    estimated: false,
  },
  finishReason: 'stop',
  status: 'completed',
};

function decode(chunks: Uint8Array[]): string {
  return chunks.map((chunk) => new TextDecoder().decode(chunk)).join('');
}

describe('inference protocol response fidelity', () => {
  it('maps provider finish reasons to each public protocol vocabulary', () => {
    const maxTokens = { ...RESULT, finishReason: 'max_tokens' };
    const refusal = { ...RESULT, finishReason: 'refusal' };
    const tool = {
      ...RESULT,
      finishReason: 'end_turn',
      items: [
        {
          type: 'function_call' as const,
          id: 'fc_1',
          callId: 'call_1',
          name: 'lookup',
          arguments: '{}',
        },
      ],
    };

    expect(chatFinishReason(maxTokens)).toBe('length');
    expect(chatFinishReason(refusal)).toBe('content_filter');
    expect(anthropicStopReason(maxTokens)).toBe('max_tokens');
    expect(anthropicStopReason(refusal)).toBe('refusal');
    expect(chatFinishReason(tool)).toBe('tool_calls');
    expect(anthropicStopReason(tool)).toBe('tool_use');
    expect(chatCompletionsJson(maxTokens).choices[0]?.finish_reason).toBe('length');
    expect(anthropicMessagesJson(refusal).stop_reason).toBe('refusal');
  });

  it('preserves an Anthropic stop sequence in unary and streaming responses', () => {
    const result = { ...RESULT, finishReason: 'stop_sequence', stopSequence: '</done>' };

    expect(anthropicMessagesJson(result)).toMatchObject({
      stop_reason: 'stop_sequence',
      stop_sequence: '</done>',
    });
    expect(decode(createProtocolStreamEncoder('messages', 'resp_1', 'logical-model').complete(result))).toContain(
      '"stop_reason":"stop_sequence","stop_sequence":"</done>"'
    );
  });

  it('reconstructs public output usage without double-charging internal pricing', () => {
    const result = {
      ...RESULT,
      usage: { ...RESULT.usage, outputTokens: 2, reasoningTokens: 3, totalTokens: 15 },
    };

    expect(responsesJson(result).usage).toMatchObject({ output_tokens: 5, total_tokens: 15 });
    expect(chatCompletionsJson(result).usage).toMatchObject({ completion_tokens: 5, total_tokens: 15 });
    expect(anthropicMessagesJson(result).usage).toMatchObject({ output_tokens: 5 });
    expect(completeUsage({ inputTokens: 10, outputTokens: 2, reasoningTokens: 3 }, [], [])).toMatchObject({
      totalTokens: 15,
    });
  });

  it('preserves Chat refusals and annotations', () => {
    const result = {
      ...RESULT,
      finishReason: 'refusal',
      items: [
        {
          type: 'message' as const,
          id: 'msg_1',
          role: 'assistant' as const,
          text: '',
          refusal: 'Cannot help with that',
          annotations: [{ type: 'url_citation', url: 'https://example.com' }],
        },
      ],
    };

    expect(chatCompletionsJson(result).choices[0]?.message).toMatchObject({
      content: null,
      refusal: 'Cannot help with that',
      annotations: [{ type: 'url_citation', url: 'https://example.com' }],
    });
  });

  it('fails explicitly when an adapter cannot represent canonical output', () => {
    const hosted = {
      ...RESULT,
      items: [{ type: 'hosted' as const, id: 'web_1', raw: { type: 'web_search_call', id: 'web_1' } }],
    };
    const annotated = {
      ...RESULT,
      items: [
        {
          type: 'message' as const,
          id: 'msg_1',
          role: 'assistant' as const,
          text: 'Source',
          annotations: [{ type: 'url_citation' }],
        },
      ],
    };

    expect(() => chatCompletionsJson(hosted)).toThrow(/cannot be represented/);
    expect(() => anthropicMessagesJson(hosted)).toThrow(/cannot be represented/);
    expect(() => anthropicMessagesJson(annotated)).toThrow(/annotations cannot be represented/);
    expect(() =>
      createProtocolStreamEncoder('chat_completions', 'resp_1', 'logical-model').event({
        type: 'item.done',
        item: hosted.items[0]!,
      })
    ).toThrow(/cannot be represented/);
    expect(() =>
      createProtocolStreamEncoder('messages', 'resp_1', 'logical-model').event({
        type: 'item.done',
        item: annotated.items[0]!,
      })
    ).toThrow(/annotations cannot be represented/);
  });

  it('preserves refusal text in Anthropic unary and streaming output', () => {
    const result = {
      ...RESULT,
      finishReason: 'refusal',
      items: [
        {
          type: 'message' as const,
          id: 'msg_1',
          role: 'assistant' as const,
          text: '',
          refusal: 'Cannot help with that',
        },
      ],
    };
    expect(anthropicMessagesJson(result).content).toEqual([{ type: 'text', text: 'Cannot help with that' }]);
    expect(
      decode(
        createProtocolStreamEncoder('messages', 'resp_1', 'logical-model').event({
          type: 'item.done',
          item: result.items[0]!,
        })
      )
    ).toContain('Cannot help with that');
  });
});
