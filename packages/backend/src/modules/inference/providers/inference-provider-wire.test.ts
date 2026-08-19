import { describe, expect, it } from 'vitest';
import { InferenceProviderRegistry } from './inference-provider.registry.js';
import { createProviderStreamState, parseProviderEvent, providerRequestBody } from './inference-provider-wire.js';

const REQUEST = {
  protocol: 'responses' as const,
  model: 'public-model',
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
  tools: [],
  stream: true,
  reasoningEffort: 'max',
  isCompaction: false,
  extensions: {},
};

describe('provider wire adapters', () => {
  const registry = new InferenceProviderRegistry();

  it('never exposes provider-supplied streamed error messages', () => {
    const secret = 'Bearer upstream-admin-secret';
    expect(
      parseProviderEvent(
        registry.require('openai'),
        { type: 'response.failed', response: { error: { code: 'bad_request', message: secret } } },
        createProviderStreamState('gpt-test')
      )
    ).toEqual([{ type: 'error', code: 'upstream_error', message: 'Upstream inference request failed' }]);
    expect(
      parseProviderEvent(
        registry.require('anthropic'),
        { type: 'error', error: { type: 'api_error', message: secret } },
        createProviderStreamState('claude-test')
      )
    ).toEqual([{ type: 'error', code: 'upstream_error', message: 'Upstream inference request failed' }]);
  });

  it('constructs OpenAI Responses, chat, and Anthropic streaming requests', () => {
    expect(providerRequestBody(registry.require('openai'), 'gpt-test', REQUEST)).toMatchObject({
      model: 'gpt-test',
      stream: true,
      reasoning: { effort: 'max' },
    });
    expect(providerRequestBody(registry.require('moonshot'), 'kimi-test', REQUEST)).toMatchObject({
      model: 'kimi-test',
      stream: true,
      reasoning_effort: 'max',
    });
    expect(providerRequestBody(registry.require('anthropic'), 'claude-test', REQUEST)).toMatchObject({
      model: 'claude-test',
      stream: true,
      thinking: { type: 'enabled' },
    });
    expect(providerRequestBody(registry.require('anthropic'), 'claude-opus-4-7', REQUEST)).toMatchObject({
      max_tokens: 40_192,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' },
    });
  });

  it('maps Codex developer instructions to the system role for Chat Completions providers', () => {
    const body = providerRequestBody(registry.require('kimi'), 'k3', {
      ...REQUEST,
      messages: [
        { role: 'developer', content: [{ type: 'text', text: 'Follow the workspace instructions' }] },
        ...REQUEST.messages,
      ],
    });

    expect(body.messages).toEqual([
      { role: 'system', content: 'Follow the workspace instructions' },
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('builds the Codex subscription request contract from Chat Completions input', () => {
    const body = providerRequestBody(registry.require('openai'), 'gpt-test', {
      ...REQUEST,
      protocol: 'chat_completions',
      maxOutputTokens: 16,
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'System instructions' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            {
              type: 'image',
              source: { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'high' } },
            },
          ],
        },
        { role: 'assistant', phase: 'commentary', content: [{ type: 'text', text: 'Hi' }] },
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          inputSchema: { type: 'object' },
          raw: { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } },
        },
      ],
      toolChoice: { type: 'function', function: { name: 'lookup' } },
    });

    expect(body).toMatchObject({
      instructions: 'System instructions',
      store: false,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Hello' },
            { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'high' },
          ],
        },
        { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Hi' }] },
      ],
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'lookup' },
    });
    expect(body).not.toHaveProperty('max_output_tokens');
  });

  it('lifts system messages into instructions on the Gateway-to-core Responses wire', () => {
    const body = providerRequestBody(
      { ...registry.require('openai-apikey'), id: 'wiolett-core' },
      'gpt-test',
      {
        ...REQUEST,
        maxOutputTokens: 16,
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'System instructions' }] },
          ...REQUEST.messages,
        ],
      }
    );

    expect(body).toMatchObject({
      instructions: 'System instructions',
      max_output_tokens: 16,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
    });
    expect(body.input).not.toContainEqual(expect.objectContaining({ role: 'system' }));
  });

  it('keeps tool history as Responses function items', () => {
    const body = providerRequestBody(registry.require('openai'), 'gpt-test', {
      ...REQUEST,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'fc-1', callId: 'call-1', name: 'lookup', arguments: '{"q":"x"}' }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', callId: 'call-1', output: 'result' }],
        },
      ],
    });

    const input = body.input as unknown[];
    expect(input).toEqual([
      { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'result' },
    ]);
  });

  it('does not forward a call_id as an OpenAI Responses function item id', () => {
    const body = providerRequestBody(registry.require('openai'), 'gpt-test', {
      ...REQUEST,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              id: 'call_ocQ5UJj22a3efmVoqLituMI0',
              callId: 'call_ocQ5UJj22a3efmVoqLituMI0',
              name: 'discover_tools',
              arguments: '{}',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              callId: 'call_ocQ5UJj22a3efmVoqLituMI0',
              output: '{"activeToolsets":["core"]}',
            },
          ],
        },
      ],
    });

    const input = body.input as unknown[];
    expect(input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_ocQ5UJj22a3efmVoqLituMI0',
        name: 'discover_tools',
        arguments: '{}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_ocQ5UJj22a3efmVoqLituMI0',
        output: '{"activeToolsets":["core"]}',
      },
    ]);
    expect(input[0]).not.toHaveProperty('id');
  });

  it('preserves Anthropic cache controls and translates inline Responses files to documents', () => {
    const body = providerRequestBody(registry.require('anthropic-apikey'), 'claude-test', {
      ...REQUEST,
      protocol: 'messages',
      reasoningEffort: undefined,
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: 'System', cacheControl: { type: 'ephemeral' } }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'file',
              source: {
                type: 'input_file',
                filename: 'document.pdf',
                file_data: 'data:application/pdf;base64,cGRm',
              },
              cacheControl: { type: 'ephemeral' },
            },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          raw: { name: 'lookup', cache_control: { type: 'ephemeral' } },
        },
      ],
    });

    expect(body).toMatchObject({
      system: [{ type: 'text', text: 'System', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
      tools: [{ name: 'lookup', cache_control: { type: 'ephemeral' } }],
    });
    expect(() =>
      providerRequestBody(registry.require('moonshot'), 'kimi-test', {
        ...REQUEST,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello', cacheControl: { type: 'ephemeral' } }] }],
      })
    ).toThrow('cache_control cannot be represented');
  });

  it('keeps structured tool history for OpenAI-compatible chat providers', () => {
    const body = providerRequestBody(registry.require('moonshot'), 'kimi-test', {
      ...REQUEST,
      protocol: 'chat_completions',
      parallelToolCalls: false,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Run it' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Need a tool' },
            { type: 'tool_call', id: 'call-1', callId: 'call-1', name: 'lookup', arguments: '{"q":"x"}' },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', callId: 'call-1', output: '{"ok":true}' }] },
      ],
      toolChoice: { type: 'tool', name: 'lookup' },
    });

    expect(body).toMatchObject({
      parallel_tool_calls: false,
      tool_choice: { type: 'function', function: { name: 'lookup' } },
      messages: [
        { role: 'user', content: 'Run it' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'Need a tool',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
      ],
    });
  });

  it('bridges Codex freeform tools through Chat Completions providers', () => {
    const customTool = {
      type: 'custom' as const,
      name: 'exec',
      description: 'Run a command',
      raw: {
        type: 'custom',
        name: 'exec',
        description: 'Run a command',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: command' },
      },
    };
    const body = providerRequestBody(registry.require('moonshot'), 'kimi-test', {
      ...REQUEST,
      tools: [customTool],
    });

    expect(body).toMatchObject({
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec',
            parameters: {
              properties: { input: { type: 'string' } },
              required: ['input'],
              additionalProperties: false,
            },
          },
        },
      ],
    });

    const state = createProviderStreamState('kimi-test', [customTool]);
    expect(
      parseProviderEvent(
        registry.require('moonshot'),
        {
          id: 'chat-1',
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call-1', function: { name: 'exec', arguments: '{"input":"pwd"}' } }],
              },
              finish_reason: null,
            },
          ],
        },
        state
      )
    ).toEqual([]);
    expect(
      parseProviderEvent(
        registry.require('moonshot'),
        { id: 'chat-1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        state
      )
    ).toEqual([
      {
        type: 'item.done',
        item: {
          type: 'function_call',
          id: expect.stringMatching(/^ctc_/),
          callId: 'call-1',
          name: 'exec',
          arguments: 'pwd',
          custom: true,
        },
      },
    ]);
  });

  it('bridges Codex namespace tools through Chat Completions providers', () => {
    const namespaceTool = {
      type: 'function' as const,
      namespace: 'mcp__gateway',
      name: 'status',
      description: 'Read status',
      inputSchema: { type: 'object', properties: {} },
      raw: {
        type: 'function',
        name: 'status',
        description: 'Read status',
        parameters: { type: 'object', properties: {} },
      },
    };
    const body = providerRequestBody(registry.require('moonshot'), 'kimi-test', {
      ...REQUEST,
      tools: [namespaceTool],
    });

    expect(body).toMatchObject({
      tools: [
        {
          type: 'function',
          function: { name: 'mcp__gateway__status' },
        },
      ],
    });

    const state = createProviderStreamState('kimi-test', [namespaceTool]);
    expect(
      parseProviderEvent(
        registry.require('moonshot'),
        {
          id: 'chat-1',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-1',
                    function: { name: 'mcp__gateway__status', arguments: '{}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        state
      )
    ).toEqual([
      expect.objectContaining({
        type: 'tool_call.delta',
        name: 'status',
        namespace: 'mcp__gateway',
        delta: '{}',
      }),
    ]);
    expect(
      parseProviderEvent(
        registry.require('moonshot'),
        { id: 'chat-1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        state
      )
    ).toEqual([
      {
        type: 'item.done',
        item: {
          type: 'function_call',
          id: expect.stringMatching(/^fc_/),
          callId: 'call-1',
          name: 'status',
          namespace: 'mcp__gateway',
          arguments: '{}',
        },
      },
    ]);
  });

  it('preserves namespace identity for native Responses custom tools', () => {
    const namespaceTool = {
      type: 'custom' as const,
      namespace: 'functions',
      name: 'apply_patch',
      description: 'Apply a patch',
      raw: {
        type: 'custom',
        name: 'apply_patch',
        description: 'Apply a patch',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' },
      },
    };
    const body = providerRequestBody(registry.require('openai'), 'gpt-test', {
      ...REQUEST,
      tools: [namespaceTool],
    });

    expect(body).toMatchObject({
      tools: [
        {
          type: 'custom',
          name: 'functions__apply_patch',
          format: { type: 'grammar', syntax: 'lark' },
        },
      ],
    });
    expect(
      parseProviderEvent(
        registry.require('openai'),
        {
          type: 'response.output_item.done',
          item: {
            type: 'custom_tool_call',
            id: 'ctc-1',
            call_id: 'call-1',
            name: 'functions__apply_patch',
            input: '*** Begin Patch',
          },
        },
        createProviderStreamState('gpt-test', [namespaceTool])
      )
    ).toEqual([
      {
        type: 'item.done',
        item: {
          type: 'function_call',
          id: 'ctc-1',
          callId: 'call-1',
          name: 'apply_patch',
          namespace: 'functions',
          arguments: '*** Begin Patch',
          custom: true,
        },
      },
    ]);
  });

  it('closes Chat reasoning before text and text before a tool call', () => {
    const provider = registry.require('moonshot');
    const state = createProviderStreamState('kimi-test');

    const reasoning = parseProviderEvent(
      provider,
      { id: 'chat-1', choices: [{ delta: { reasoning_content: 'Inspect first' }, finish_reason: null }] },
      state
    );
    const reasoningId = (reasoning[0] as Extract<(typeof reasoning)[number], { type: 'reasoning.delta' }>).itemId;
    expect(reasoning).toEqual([{ type: 'reasoning.delta', itemId: reasoningId, delta: 'Inspect first' }]);

    const text = parseProviderEvent(
      provider,
      { id: 'chat-1', choices: [{ delta: { content: 'Working' }, finish_reason: null }] },
      state
    );
    const textDelta = text[1] as Extract<(typeof text)[number], { type: 'output_text.delta' }>;
    expect(text).toEqual([
      { type: 'item.done', item: { type: 'reasoning', id: reasoningId, text: 'Inspect first' } },
      { type: 'output_text.delta', itemId: textDelta.itemId, delta: 'Working' },
    ]);

    const tool = parseProviderEvent(
      provider,
      {
        id: 'chat-1',
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
            },
            finish_reason: null,
          },
        ],
      },
      state
    );
    expect(tool).toEqual([
      {
        type: 'item.done',
        item: {
          type: 'message',
          id: textDelta.itemId,
          role: 'assistant',
          text: 'Working',
          phase: 'commentary',
        },
      },
      expect.objectContaining({
        type: 'tool_call.delta',
        itemId: expect.stringMatching(/^fc_/),
        callId: 'call-1',
        name: 'lookup',
      }),
    ]);

    const finished = parseProviderEvent(
      provider,
      { id: 'chat-1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      state
    );
    expect(finished).toEqual([
      expect.objectContaining({
        type: 'item.done',
        item: expect.objectContaining({ type: 'function_call', id: expect.stringMatching(/^fc_/), callId: 'call-1' }),
      }),
    ]);
  });

  it('closes Anthropic thinking, text, and tool blocks with canonical item ids', () => {
    const provider = registry.require('anthropic');
    const state = createProviderStreamState('claude-test');

    parseProviderEvent(
      provider,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      state
    );
    const thinkingDelta = parseProviderEvent(
      provider,
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Inspect' } },
      state
    );
    const thinkingId = (thinkingDelta[0] as Extract<(typeof thinkingDelta)[number], { type: 'reasoning.delta' }>)
      .itemId;
    parseProviderEvent(
      provider,
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
      state
    );
    expect(parseProviderEvent(provider, { type: 'content_block_stop', index: 0 }, state)).toEqual([
      {
        type: 'item.done',
        item: { type: 'reasoning', id: thinkingId, text: 'Inspect', signature: 'signed' },
      },
    ]);
    expect(thinkingId).toMatch(/^rs_/);

    parseProviderEvent(
      provider,
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      state
    );
    const textDelta = parseProviderEvent(
      provider,
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done' } },
      state
    );
    const messageId = (textDelta[0] as Extract<(typeof textDelta)[number], { type: 'output_text.delta' }>).itemId;
    expect(parseProviderEvent(provider, { type: 'content_block_stop', index: 1 }, state)).toEqual([
      { type: 'item.done', item: { type: 'message', id: messageId, role: 'assistant', text: 'Done' } },
    ]);
    expect(messageId).toMatch(/^msg_/);

    parseProviderEvent(
      provider,
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup' } },
      state
    );
    parseProviderEvent(
      provider,
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } },
      state
    );
    expect(parseProviderEvent(provider, { type: 'content_block_stop', index: 2 }, state)).toEqual([
      expect.objectContaining({
        type: 'item.done',
        item: expect.objectContaining({
          type: 'function_call',
          id: expect.stringMatching(/^fc_/),
          callId: 'toolu_1',
          name: 'lookup',
          arguments: '{}',
        }),
      }),
    ]);
  });

  it('preserves native Responses custom tool input', () => {
    const events = parseProviderEvent(
      registry.require('openai'),
      {
        type: 'response.output_item.done',
        item: {
          type: 'custom_tool_call',
          id: 'ctc-1',
          call_id: 'call-1',
          name: 'exec',
          input: 'pwd',
        },
      },
      createProviderStreamState('gpt-test')
    );

    expect(events).toEqual([
      {
        type: 'item.done',
        item: {
          type: 'function_call',
          id: 'ctc-1',
          callId: 'call-1',
          name: 'exec',
          arguments: 'pwd',
          custom: true,
        },
      },
    ]);
  });

  it('preserves native Responses message phases for Codex status lifecycle', () => {
    const provider = registry.require('openai');
    const state = createProviderStreamState('gpt-test');

    expect(
      parseProviderEvent(
        provider,
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'msg-1', role: 'assistant', phase: 'commentary', content: [] },
        },
        state
      )
    ).toEqual([]);
    expect(
      parseProviderEvent(
        provider,
        { type: 'response.output_text.delta', item_id: 'msg-1', output_index: 0, delta: 'Inspecting' },
        state
      )
    ).toEqual([{ type: 'output_text.delta', itemId: 'msg-1', delta: 'Inspecting', phase: 'commentary' }]);
    expect(
      parseProviderEvent(
        provider,
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'msg-1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Inspecting' }],
          },
        },
        state
      )
    ).toEqual([
      {
        type: 'item.done',
        item: expect.objectContaining({
          type: 'message',
          id: 'msg-1',
          role: 'assistant',
          text: 'Inspecting',
          phase: 'commentary',
        }),
      },
    ]);
  });

  it('waits for the final Chat Completions usage chunk before completing', () => {
    const provider = registry.require('moonshot');
    const state = createProviderStreamState('kimi-test');

    expect(
      parseProviderEvent(provider, { id: 'chat-1', choices: [{ delta: {}, finish_reason: 'stop' }] }, state)
    ).toEqual([]);
    expect(
      parseProviderEvent(
        provider,
        {
          id: 'chat-1',
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        },
        state
      )
    ).toEqual([
      expect.objectContaining({
        type: 'completed',
        finishReason: 'stop',
        usage: expect.objectContaining({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
      }),
    ]);
  });

  it('preserves encrypted Responses reasoning for stateless continuation', () => {
    const provider = registry.require('openai');
    const state = createProviderStreamState('gpt-test');
    const events = parseProviderEvent(
      provider,
      {
        type: 'response.output_item.done',
        item: {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Plan' }],
          encrypted_content: 'encrypted-reasoning',
        },
      },
      state
    );

    expect(events).toEqual([
      {
        type: 'item.done',
        item: { type: 'reasoning', id: 'rs_1', text: 'Plan', signature: 'encrypted-reasoning' },
      },
    ]);
    const replay = providerRequestBody(provider, 'gpt-test', {
      ...REQUEST,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'reasoning', id: 'rs_1', text: 'Plan', signature: 'encrypted-reasoning' }],
        },
      ],
    });
    expect(replay.input).toEqual([
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'Plan' }],
        encrypted_content: 'encrypted-reasoning',
      },
    ]);
  });

  it('preserves Responses annotations, refusals, and hosted output items', () => {
    const provider = registry.require('openai');
    const state = createProviderStreamState('gpt-test');
    expect(
      parseProviderEvent(
        provider,
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            id: 'msg_annotated',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Source',
                annotations: [{ type: 'url_citation', url: 'https://example.com' }],
              },
              { type: 'refusal', refusal: 'Cannot continue' },
            ],
          },
        },
        state
      )
    ).toEqual([
      {
        type: 'item.done',
        item: expect.objectContaining({
          type: 'message',
          text: 'Source',
          annotations: [{ type: 'url_citation', url: 'https://example.com' }],
          refusal: 'Cannot continue',
        }),
      },
    ]);
    expect(
      parseProviderEvent(
        provider,
        {
          type: 'response.output_item.done',
          item: { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search' } },
        },
        state
      )
    ).toEqual([
      {
        type: 'item.done',
        item: {
          type: 'hosted',
          id: 'ws_1',
          raw: { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search' } },
        },
      },
    ]);
  });

  it('applies the Claude OAuth identity, tool prefix, and signed thinking contract', () => {
    const provider = registry.require('anthropic');
    const body = providerRequestBody(provider, 'claude-opus-4-7', {
      ...REQUEST,
      protocol: 'messages',
      reasoningEffort: undefined,
      reasoningConfig: { type: 'adaptive' },
      extensions: { output_config: { effort: 'high' } },
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Project policy' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Think', signature: 'signature' },
            { type: 'tool_call', id: 'tool-item-1', callId: 'tool-1', name: 'lookup', arguments: '{}' },
          ],
        },
      ],
      tools: [{ type: 'function', name: 'lookup', raw: { name: 'lookup' } }],
      toolChoice: { type: 'function', function: { name: 'lookup' } },
    });

    expect(body).toMatchObject({
      system: [
        { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
        { type: 'text', text: 'Project policy' },
      ],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      tools: [{ name: 'custom_lookup' }],
      tool_choice: { type: 'tool', name: 'custom_lookup' },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Think', signature: 'signature' },
            { type: 'tool_use', id: 'tool-1', name: 'custom_lookup', input: {} },
          ],
        },
      ],
    });

    const state = createProviderStreamState('claude-opus-4-7');
    expect(
      parseProviderEvent(
        provider,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool-1', name: 'custom_lookup' },
        },
        state
      )
    ).toEqual([]);
    expect(
      parseProviderEvent(
        provider,
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        state
      )
    ).toEqual([expect.objectContaining({ type: 'tool_call.delta', name: 'lookup', callId: 'tool-1' })]);
  });

  it('normalizes terminal OpenAI usage', () => {
    const provider = registry.require('openai');
    const state = createProviderStreamState('gpt-test');
    const events = parseProviderEvent(
      provider,
      {
        type: 'response.completed',
        response: {
          id: 'resp-upstream',
          model: 'gpt-test',
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens_details: { reasoning_tokens: 8 },
          },
        },
      },
      state
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'completed',
        usage: expect.objectContaining({
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 12,
          reasoningTokens: 8,
        }),
      }),
    ]);
  });

  it('preserves an incomplete Responses terminal instead of fabricating completion', () => {
    const provider = registry.require('openai');
    const state = createProviderStreamState('gpt-test');

    expect(
      parseProviderEvent(
        provider,
        {
          type: 'response.incomplete',
          response: {
            id: 'resp-upstream',
            model: 'gpt-test',
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
        state
      )
    ).toEqual([
      expect.objectContaining({
        type: 'completed',
        status: 'incomplete',
        finishReason: 'max_output_tokens',
        incompleteReason: 'max_output_tokens',
        usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      }),
    ]);
  });

  it('includes Anthropic cache reads and writes in canonical input usage', () => {
    const provider = registry.require('anthropic-apikey');
    const state = createProviderStreamState('claude-test');
    parseProviderEvent(
      provider,
      {
        type: 'message_start',
        message: {
          id: 'msg-1',
          model: 'claude-test',
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
            output_tokens: 0,
          },
        },
      },
      state
    );
    const events = parseProviderEvent(
      provider,
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
      state
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'completed',
        usage: expect.objectContaining({
          inputTokens: 160,
          cachedInputTokens: 100,
          cacheWriteTokens: 50,
          outputTokens: 20,
        }),
      }),
    ]);
  });

  it('preserves Anthropic stop reasons and matching stop sequences', () => {
    const events = parseProviderEvent(
      registry.require('anthropic-apikey'),
      {
        type: 'message_delta',
        delta: { stop_reason: 'stop_sequence', stop_sequence: '</done>' },
        usage: { output_tokens: 20 },
      },
      createProviderStreamState('claude-test')
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: 'completed',
        finishReason: 'stop_sequence',
        stopSequence: '</done>',
      }),
    ]);
  });

  it('forwards supported request controls and rejects controls unsupported by a wire protocol', () => {
    expect(
      providerRequestBody(registry.require('openai'), 'gpt-test', {
        ...REQUEST,
        extensions: {
          temperature: 0.2,
          service_tier: 'priority',
          client_metadata: { originator: 'codex_cli_rs' },
        },
      })
    ).toMatchObject({
      temperature: 0.2,
      service_tier: 'priority',
      client_metadata: { originator: 'codex_cli_rs' },
    });
    expect(
      providerRequestBody(registry.require('openai-compatible'), 'chat-model', {
        ...REQUEST,
        extensions: {
          client_metadata: { originator: 'codex_cli_rs' },
          include: ['reasoning.encrypted_content'],
          max_tool_calls: 8,
          prompt_cache_retention: '24h',
          safety_identifier: 'installation',
          text: { verbosity: 'medium' },
          truncation: 'auto',
        },
      })
    ).not.toHaveProperty('include');
    expect(() =>
      providerRequestBody(registry.require('anthropic'), 'claude-test', {
        ...REQUEST,
        extensions: { frequency_penalty: 0.2 },
      })
    ).toThrow('unsupported by this provider');
  });
});
