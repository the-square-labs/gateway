import { describe, expect, it } from 'vitest';
import {
  compactionItemToText,
  decodeCompactionSummary,
  encodeCompactionSummary,
  SUMMARY_PREFIX,
} from './inference-compaction.js';
import {
  parseAnthropicMessagesRequest,
  parseChatCompletionsRequest,
  parseResponsesRequest,
} from './inference-parse.js';

describe('inference protocol parsing', () => {
  it('preserves Responses reasoning, tools, extensions, and v2 compaction trigger', () => {
    const request = parseResponsesRequest({
      model: 'logical-model',
      stream: true,
      instructions: 'Follow policy',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
        {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'Inspecting' }],
        },
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'prior reasoning' }] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
        {
          type: 'additional_tools',
          role: 'user',
          tools: [
            {
              type: 'custom',
              name: 'exec',
              description: 'Run commands',
              format: { type: 'grammar', syntax: 'lark', definition: 'start: command' },
            },
          ],
        },
        { type: 'compaction_trigger' },
      ],
      tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
      reasoning: { effort: 'ultra', summary: 'auto' },
      prompt_cache_key: 'thread-1',
      service_tier: 'priority',
      client_metadata: { originator: 'codex_cli_rs' },
      stream_options: { include_obfuscation: false },
    });

    expect(request).toMatchObject({
      protocol: 'responses',
      model: 'logical-model',
      stream: true,
      reasoningEffort: 'ultra',
      reasoningConfig: { effort: 'ultra', summary: 'auto' },
      promptCacheKey: 'thread-1',
      isCompaction: true,
      extensions: { service_tier: 'priority', client_metadata: { originator: 'codex_cli_rs' } },
    });
    expect(request.messages[0]).toMatchObject({ role: 'developer' });
    expect(request.messages[2]).toMatchObject({ role: 'assistant', phase: 'commentary' });
    expect(request.messages.flatMap((message) => message.content).map((part) => part.type)).toEqual([
      'text',
      'text',
      'text',
      'reasoning',
      'tool_call',
      'tool_result',
    ]);
    expect(request.tools).toMatchObject([
      { type: 'function', name: 'lookup' },
      { type: 'custom', name: 'exec' },
    ]);
    expect(request.tools[1]?.raw).toMatchObject({
      format: { type: 'grammar', syntax: 'lark', definition: 'start: command' },
    });
    expect(
      request.messages.flatMap((message) => message.content).find((part) => part.type === 'tool_call')
    ).toMatchObject({
      type: 'tool_call',
      id: 'fc_1',
      callId: 'call_1',
    });
  });

  it('maps Chat Completions tool calls and tool results', () => {
    const request = parseChatCompletionsRequest({
      model: 'chat-model',
      messages: [
        { role: 'user', content: 'Run it' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'Need a tool',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run', arguments: '{"x":1}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"result":2}' },
      ],
      tools: [{ type: 'function', function: { name: 'run', parameters: { type: 'object' } } }],
    });

    expect(request.protocol).toBe('chat_completions');
    expect(request.messages.flatMap((message) => message.content).map((part) => part.type)).toEqual([
      'text',
      'reasoning',
      'tool_call',
      'tool_result',
    ]);
    expect(request.tools[0].name).toBe('run');
  });

  it('parses Codex Responses Lite namespace tools as client-executed functions', () => {
    const request = parseResponsesRequest({
      model: 'logical-model',
      input: [
        {
          type: 'additional_tools',
          tools: [
            {
              type: 'namespace',
              name: 'mcp__gateway',
              description: 'Gateway tools',
              tools: [
                {
                  type: 'function',
                  name: 'status',
                  description: 'Read status',
                  parameters: { type: 'object', properties: {} },
                },
              ],
            },
          ],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      ],
    });

    expect(request.tools).toMatchObject([
      {
        type: 'function',
        namespace: 'mcp__gateway',
        name: 'status',
        description: 'Read status',
      },
    ]);
  });

  it('rejects Chat Completions choices and logprobs that cannot be represented losslessly', () => {
    const request = { model: 'chat-model', messages: [{ role: 'user', content: 'Hello' }] };

    expect(() => parseChatCompletionsRequest({ ...request, n: 2 })).toThrow('Only n=1 is supported');
    expect(() => parseChatCompletionsRequest({ ...request, logprobs: true })).toThrow(
      'Chat Completions logprobs are not supported'
    );
    expect(() => parseChatCompletionsRequest({ ...request, top_logprobs: 5 })).toThrow(
      'Chat Completions logprobs are not supported'
    );
    expect(parseChatCompletionsRequest({ ...request, n: 1, logprobs: false })).toMatchObject({
      extensions: { n: 1, logprobs: false },
    });
  });

  it('maps Anthropic thinking, images, tools, and cache-compatible blocks', () => {
    const request = parseAnthropicMessagesRequest({
      model: 'claude-model',
      max_tokens: 1024,
      system: [{ type: 'text', text: 'System', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: 'pdf' },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Think', signature: 'sig' },
            { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { q: 'x' } },
          ],
        },
      ],
      tools: [
        {
          name: 'lookup',
          description: 'Lookup',
          input_schema: { type: 'object' },
          cache_control: { type: 'ephemeral' },
        },
      ],
      thinking: { type: 'enabled', budget_tokens: 2048 },
    });

    expect(request.protocol).toBe('messages');
    expect(request.reasoningEffort).toBeUndefined();
    expect(request.reasoningConfig).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(request.tools[0]).toMatchObject({ type: 'function', name: 'lookup' });
    expect(request.messages.flatMap((message) => message.content).map((part) => part.type)).toEqual([
      'text',
      'text',
      'image',
      'file',
      'reasoning',
      'tool_call',
    ]);
    expect(request.messages[0]?.content[0]).toMatchObject({ cacheControl: { type: 'ephemeral' } });
    expect(request.tools[0]?.raw).toMatchObject({ cache_control: { type: 'ephemeral' } });
  });

  it('round-trips the transparent compaction envelope and safely handles opaque blobs', () => {
    const encoded = encodeCompactionSummary('checkpoint');
    expect(decodeCompactionSummary(encoded)).toBe('checkpoint');
    expect(compactionItemToText(encoded)).toBe(`${SUMMARY_PREFIX}\n\ncheckpoint`);
    expect(compactionItemToText('opaque-upstream-blob')).toContain('earlier conversation was compacted');
  });

  it('rejects unsupported content instead of silently dropping it', () => {
    expect(() =>
      parseResponsesRequest({
        model: 'model',
        input: [{ type: 'message', role: 'user', content: [{ type: 'unknown_block' }] }],
      })
    ).toThrow('Unsupported content block type');
    expect(() =>
      parseChatCompletionsRequest({ model: 'model', messages: [{ role: 'user', content: 'x' }], foo: 1 })
    ).toThrow('Unsupported request field: foo');
  });
});
