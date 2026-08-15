import { describe, expect, it, vi } from 'vitest';
import { resolveAIProviderEndpoint, streamModelResponse } from './ai.provider-adapter.js';
import type { AIConfig } from './ai.types.js';

const BASE_CONFIG: AIConfig = {
  enabled: true,
  providerType: 'openai_compatible',
  supportsImages: false,
  providerUrl: '',
  endpointMode: 'auto',
  model: 'gpt-5.4-mini',
  gatewayInferenceModel: '',
  gatewayInferenceAllowUserModelSelection: false,
  allowUserReasoningEffortSelection: false,
  maxCompletionTokens: 1024,
  maxTokensField: 'max_completion_tokens',
  reasoningEffort: 'medium',
  customSystemPrompt: '',
  rateLimitMax: 10,
  rateLimitWindowSeconds: 60,
  maxToolRounds: 5,
  maxContextTokens: 56_000,
  disabledTools: [],
  webSearchEnabled: false,
  webSearchProvider: 'tavily',
  webSearchBaseUrl: '',
  sandboxEnabled: false,
  sandboxDefaultTier: 'low',
};

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'manage_docker_container_config',
      description: 'Manage container config',
      parameters: { type: 'object', properties: {} },
    },
  },
];

async function collectEvents(
  client: unknown,
  config: AIConfig = BASE_CONFIG,
  messages: Record<string, unknown>[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'set env' },
  ]
) {
  const events = [];
  for await (const event of streamModelResponse({
    client: client as any,
    config,
    messages,
    tools: TOOLS,
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

describe('AI provider adapter', () => {
  it('uses Responses for default OpenAI auto mode and Chat for custom provider auto mode', () => {
    expect(resolveAIProviderEndpoint({ ...BASE_CONFIG, providerUrl: '' })).toBe('responses');
    expect(resolveAIProviderEndpoint({ ...BASE_CONFIG, providerUrl: 'https://api.openai.com/v1' })).toBe('responses');
    expect(resolveAIProviderEndpoint({ ...BASE_CONFIG, providerUrl: 'https://llm.example.com/v1' })).toBe(
      'chat_completions'
    );
    expect(resolveAIProviderEndpoint({ ...BASE_CONFIG, endpointMode: 'chat_completions' })).toBe('chat_completions');
  });

  it('normalizes Responses text and function call streaming events', async () => {
    async function* responseStream() {
      yield { type: 'response.output_text.delta', delta: 'Checking ' };
      yield {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'manage_docker_container_config',
          arguments: '',
        },
      };
      yield { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"containerId"' };
      yield {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: 'item-1',
        name: 'manage_docker_container_config',
        arguments: '{"containerId":"container-1"}',
      };
      yield { type: 'response.completed', response: { status: 'completed' } };
    }
    const create = vi.fn().mockResolvedValue(responseStream());
    const events = await collectEvents({ responses: { create } });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.4-mini',
        stream: true,
        store: false,
        reasoning: { effort: 'medium' },
      }),
      expect.any(Object)
    );
    expect(events).toEqual([
      { type: 'text_delta', content: 'Checking ' },
      {
        type: 'model_response',
        response: {
          content: 'Checking ',
          toolCalls: [
            {
              id: 'call-1',
              name: 'manage_docker_container_config',
              arguments: '{"containerId":"container-1"}',
            },
          ],
        },
      },
    ]);
  });

  it('normalizes Chat Completions text and tool call streaming chunks', async () => {
    async function* chatStream() {
      yield { choices: [{ delta: { content: 'Checking ' } }] };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  function: { name: 'manage_docker_container_config', arguments: '{"containerId"' },
                },
              ],
            },
          },
        ],
      };
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: ':"container-1"}' },
                },
              ],
            },
          },
        ],
      };
    }
    const create = vi.fn().mockResolvedValue(chatStream());
    const events = await collectEvents(
      { chat: { completions: { create } } },
      { ...BASE_CONFIG, endpointMode: 'chat_completions' }
    );

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ stream: true }), expect.any(Object));
    expect(events).toEqual([
      { type: 'text_delta', content: 'Checking ' },
      {
        type: 'model_response',
        response: {
          content: 'Checking ',
          toolCalls: [
            {
              id: 'call-1',
              name: 'manage_docker_container_config',
              arguments: '{"containerId":"container-1"}',
            },
          ],
        },
      },
    ]);
  });

  it('omits orphan tool outputs before sending Responses input', async () => {
    async function* responseStream() {
      yield { type: 'response.output_text.delta', delta: 'ok' };
      yield { type: 'response.completed', response: { status: 'completed' } };
    }
    const create = vi.fn().mockResolvedValue(responseStream());

    await collectEvents({ responses: { create } }, BASE_CONFIG, [
      { role: 'system', content: 'You are helpful.' },
      { role: 'assistant', content: null, tool_calls: [] },
      { role: 'tool', tool_call_id: 'call-missing', content: '{"ok":true}' },
      { role: 'user', content: 'continue' },
    ]);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [{ role: 'user', content: 'continue' }],
      }),
      expect.any(Object)
    );
  });

  it('omits tool outputs when the matching tool call cannot be converted for Responses', async () => {
    async function* responseStream() {
      yield { type: 'response.output_text.delta', delta: 'ok' };
      yield { type: 'response.completed', response: { status: 'completed' } };
    }
    const create = vi.fn().mockResolvedValue(responseStream());

    await collectEvents({ responses: { create } }, BASE_CONFIG, [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-without-name', type: 'function', function: { arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call-without-name', content: '{"ok":true}' },
      { role: 'user', content: 'continue' },
    ]);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [{ role: 'user', content: 'continue' }],
      }),
      expect.any(Object)
    );
  });

  it('uses call_id from Responses argument done events when output item was not observed', async () => {
    async function* responseStream() {
      yield {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: 'fc-item-1',
        call_id: 'call-1',
        name: 'manage_docker_container_config',
        arguments: '{"containerId":"container-1"}',
      };
      yield { type: 'response.completed', response: { status: 'completed' } };
    }
    const create = vi.fn().mockResolvedValue(responseStream());
    const events = await collectEvents({ responses: { create } });

    expect(events).toEqual([
      {
        type: 'model_response',
        response: {
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'manage_docker_container_config',
              arguments: '{"containerId":"container-1"}',
            },
          ],
        },
      },
    ]);
  });

  it('preserves Responses function call name when arguments done event omits it', async () => {
    async function* responseStream() {
      yield {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'discover_tools',
          arguments: '',
        },
      };
      yield {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: 'fc-item-1',
        arguments: '{"category":"Docker","includeTools":true}',
      };
      yield { type: 'response.completed', response: { status: 'completed' } };
    }
    const create = vi.fn().mockResolvedValue(responseStream());
    const events = await collectEvents({ responses: { create } });

    expect(events).toEqual([
      {
        type: 'model_response',
        response: {
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'discover_tools',
              arguments: '{"category":"Docker","includeTools":true}',
            },
          ],
        },
      },
    ]);
  });

  it('omits orphan tool outputs before sending Chat Completions messages', async () => {
    async function* chatStream() {
      yield { choices: [{ delta: { content: 'ok' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    }
    const create = vi.fn().mockResolvedValue(chatStream());

    await collectEvents({ chat: { completions: { create } } }, { ...BASE_CONFIG, endpointMode: 'chat_completions' }, [
      { role: 'system', content: 'You are helpful.' },
      { role: 'assistant', content: null, tool_calls: [] },
      { role: 'tool', tool_call_id: 'call-missing', content: '{"ok":true}' },
      { role: 'user', content: 'continue' },
    ]);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'continue' },
        ],
      }),
      expect.any(Object)
    );
  });

  it('rejects incomplete Responses terminal states', async () => {
    async function* responseStream() {
      yield {
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'max_output_tokens' } },
      };
    }
    const create = vi.fn().mockResolvedValue(responseStream());

    await expect(collectEvents({ responses: { create } })).rejects.toMatchObject({
      code: 'AI_PROVIDER_INCOMPLETE',
    });
  });

  it('rejects Chat Completions length terminals', async () => {
    async function* chatStream() {
      yield { choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] };
    }
    const create = vi.fn().mockResolvedValue(chatStream());

    await expect(
      collectEvents({ chat: { completions: { create } } }, { ...BASE_CONFIG, endpointMode: 'chat_completions' })
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_INCOMPLETE' });
  });
});
