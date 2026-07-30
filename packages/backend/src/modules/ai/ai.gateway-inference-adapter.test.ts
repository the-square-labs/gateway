import { describe, expect, it, vi } from 'vitest';
import { streamGatewayInferenceResponse } from './ai.gateway-inference-adapter.js';

describe('streamGatewayInferenceResponse', () => {
  it('normalizes messages, tool calls, and internal accounting context', async () => {
    const execute = vi.fn().mockResolvedValue({
      responseId: 'response-1',
      resolvedModel: 'gateway-model',
      events: (async function* () {
        yield { type: 'output_text.delta' as const, itemId: 'message-1', delta: 'Hello' };
        yield {
          type: 'tool_call.delta' as const,
          itemId: 'call-1',
          callId: 'call-1',
          name: 'get_status',
          delta: '{"id":',
        };
        yield {
          type: 'item.done' as const,
          item: {
            type: 'function_call' as const,
            id: 'call-1',
            callId: 'call-1',
            name: 'get_status',
            arguments: '{"id":"node-1"}',
          },
        };
        yield { type: 'completed' as const, status: 'completed' as const };
      })(),
    });

    const events = [];
    for await (const event of streamGatewayInferenceResponse({
      runtime: { execute } as never,
      userId: 'user-1',
      requestId: 'run-1',
      conversationId: 'conversation-1',
      model: 'gateway-model',
      messages: [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'previous-call',
              type: 'function',
              function: { name: 'read_status', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'previous-call', content: '{"ok":true}' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_status',
            description: 'Read status',
            parameters: { type: 'object' },
          },
        },
      ],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: 'responses',
        model: 'gateway-model',
        isCompaction: false,
        extensions: {},
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: [expect.objectContaining({ type: 'tool_result', callId: 'previous-call' })],
          }),
        ]),
      }),
      expect.objectContaining({
        userId: 'user-1',
        tokenId: null,
        affinityKey: 'ai:conversation-1',
      })
    );
    expect(events).toEqual([
      { type: 'text_delta', content: 'Hello' },
      {
        type: 'model_response',
        response: {
          content: 'Hello',
          toolCalls: [{ id: 'call-1', name: 'get_status', arguments: '{"id":"node-1"}' }],
        },
      },
    ]);
  });

  it('emits final message text when the provider sends no text deltas', async () => {
    const execute = vi.fn().mockResolvedValue({
      responseId: 'response-1',
      resolvedModel: 'gateway-model',
      events: (async function* () {
        yield {
          type: 'item.done' as const,
          item: {
            type: 'message' as const,
            id: 'message-1',
            role: 'assistant' as const,
            text: 'Terminal-only response',
          },
        };
        yield { type: 'completed' as const, status: 'completed' as const };
      })(),
    });

    const events = [];
    for await (const event of streamGatewayInferenceResponse({
      runtime: { execute } as never,
      userId: 'user-1',
      requestId: 'run-1',
      model: 'gateway-model',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'text_delta', content: 'Terminal-only response' },
      {
        type: 'model_response',
        response: { content: 'Terminal-only response', toolCalls: [] },
      },
    ]);
  });
});
