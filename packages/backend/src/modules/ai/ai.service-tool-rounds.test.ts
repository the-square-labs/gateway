import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/types.js';
import { AIService } from './ai.service.js';
import type { AIConfig, ChatMessage, WSServerMessage } from './ai.types.js';

const mocks = vi.hoisted(() => ({
  streamModelResponse: vi.fn(),
}));

vi.mock('./ai.provider-adapter.js', () => ({
  streamModelResponse: mocks.streamModelResponse,
}));

const BASE_USER: User = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['ai:workspace:use'],
  isBlocked: false,
};

const BASE_CONFIG: AIConfig = {
  enabled: true,
  providerType: 'openai_compatible',
  supportsImages: false,
  providerUrl: '',
  endpointMode: 'responses',
  model: 'gpt-5.4-mini',
  gatewayInferenceModel: '',
  gatewayInferenceAllowUserModelSelection: false,
  allowUserReasoningEffortSelection: false,
  maxCompletionTokens: 1024,
  maxTokensField: 'max_completion_tokens',
  reasoningEffort: 'none',
  customSystemPrompt: '',
  rateLimitMax: 10,
  rateLimitWindowSeconds: 60,
  maxToolRounds: 1,
  maxContextTokens: 64_000,
  disabledTools: [],
  webSearchEnabled: false,
  webSearchProvider: 'tavily',
  webSearchBaseUrl: '',
  sandboxEnabled: false,
  sandboxDefaultTier: 'low',
};

type MockModelResponse = {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
};

function createService(config: AIConfig = BASE_CONFIG, authService: object = {}) {
  return new AIService(
    {
      getConfig: vi.fn().mockResolvedValue(config),
      getDecryptedApiKey: vi.fn().mockResolvedValue('sk-test'),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    authService as never,
    { log: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
}

async function collect(events: AsyncGenerator<WSServerMessage>): Promise<WSServerMessage[]> {
  const collected: WSServerMessage[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('AIService tool round comments', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.streamModelResponse.mockReset();
  });

  it('injects pending steer messages only at the next provider boundary', async () => {
    let providerMessages: Array<{ role?: string; content?: unknown }> = [];
    mocks.streamModelResponse.mockImplementation(async function* ({ messages }) {
      providerMessages = messages;
      yield {
        type: 'model_response',
        response: { content: 'Готово.', toolCalls: [] },
      };
    });

    const service = createService();
    vi.spyOn(service, 'buildSystemPrompt').mockResolvedValue('System prompt');
    const receivePendingSteers = vi.fn(async (messages: ChatMessage[]) => [
      ...messages,
      { role: 'user' as const, content: 'Используй другой порт', steer: true },
    ]);

    await collect(
      service.streamChat(
        BASE_USER,
        [{ role: 'user', content: 'Создай контейнер' }],
        undefined,
        new AbortController().signal,
        'request-steer',
        'conversation-1',
        undefined,
        undefined,
        undefined,
        receivePendingSteers
      )
    );

    expect(receivePendingSteers).toHaveBeenCalledTimes(1);
    expect(providerMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('Используй другой порт'),
        }),
      ])
    );
  });

  it('returns a structured tool failure for malformed arguments without executing the tool', async () => {
    const responses: MockModelResponse[] = [
      { toolCalls: [{ id: 'tool-invalid', name: 'get_current_context', arguments: '{' }] },
      { content: 'Исправил вызов.', toolCalls: [] },
    ];
    mocks.streamModelResponse.mockImplementation(async function* () {
      const response = responses.shift();
      if (!response) throw new Error('unexpected model round');
      if (response.content) yield { type: 'text_delta', content: response.content };
      yield {
        type: 'model_response',
        response: { content: response.content ?? '', toolCalls: response.toolCalls ?? [] },
      };
    });

    const service = createService();
    vi.spyOn(service, 'buildSystemPrompt').mockResolvedValue('System prompt');
    vi.spyOn(service, 'executeTool').mockResolvedValue({ result: { ok: true }, invalidateStores: [] });

    const events = await collect(
      service.streamChat(
        BASE_USER,
        [{ role: 'user', content: 'Проверь систему' }],
        undefined,
        new AbortController().signal,
        'request-1'
      )
    );

    expect(service.executeTool).not.toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_result',
          id: 'tool-invalid',
          error: 'Invalid tool arguments: malformed JSON',
        }),
        expect.objectContaining({ type: 'text_delta', content: 'Исправил вызов.' }),
      ])
    );
  });

  it('locks later rounds to the language of ordinary visible text emitted before tool calls', async () => {
    const responses: MockModelResponse[] = [
      {
        content: 'Проверю найденный контекст.',
        toolCalls: [{ id: 'tool-context', name: 'get_current_context', arguments: '{}' }],
      },
      { content: 'Готово.', toolCalls: [] },
    ];
    const messagesPerRound: Array<Array<Record<string, unknown>>> = [];
    mocks.streamModelResponse.mockImplementation(async function* ({ messages }) {
      messagesPerRound.push(messages);
      const response = responses.shift();
      if (!response) throw new Error('unexpected model round');
      if (response.content) yield { type: 'text_delta', content: response.content };
      yield {
        type: 'model_response',
        response: { content: response.content ?? '', toolCalls: response.toolCalls ?? [] },
      };
    });

    const service = createService({ ...BASE_CONFIG, maxToolRounds: 10 });
    vi.spyOn(service, 'buildSystemPrompt').mockResolvedValue('System prompt');
    vi.spyOn(service, 'executeTool').mockResolvedValue({ result: { ok: true }, invalidateStores: [] });

    await collect(
      service.streamChat(
        BASE_USER,
        [{ role: 'user', content: 'Inspect the current Gateway context' }],
        undefined,
        new AbortController().signal,
        'request-language-lock'
      )
    );

    expect(JSON.stringify(messagesPerRound[1])).toContain(
      'response language for this run is now locked to the language of the first user-visible assistant text'
    );
  });

  it('allows more tool rounds than maxToolRounds when send_comment separates them', async () => {
    const responses: MockModelResponse[] = [
      {
        toolCalls: [
          {
            id: 'tool-1',
            name: 'get_current_context',
            arguments: '{}',
          },
        ],
      },
      {
        toolCalls: [
          {
            id: 'comment-1',
            name: 'send_comment',
            arguments: JSON.stringify({ message: 'Проверил первый шаг, продолжаю.' }),
          },
        ],
      },
      {
        toolCalls: [
          {
            id: 'tool-2',
            name: 'get_current_context',
            arguments: '{}',
          },
        ],
      },
      {
        toolCalls: [
          {
            id: 'comment-2',
            name: 'send_comment',
            arguments: JSON.stringify({ message: 'Проверил второй шаг, завершаю.' }),
          },
        ],
      },
      {
        content: 'Готово.',
        toolCalls: [],
      },
    ];
    const toolsPerRound: string[][] = [];
    const messagesPerRound: Array<Array<Record<string, unknown>>> = [];

    mocks.streamModelResponse.mockImplementation(async function* ({
      tools,
      messages,
    }: {
      tools: Array<{ function: { name: string } }>;
      messages: Array<Record<string, unknown>>;
    }) {
      toolsPerRound.push(tools.map((tool) => tool.function.name));
      messagesPerRound.push(messages);
      const response = responses.shift();
      if (!response) throw new Error('unexpected model round');
      if (response.content) yield { type: 'text_delta', content: response.content };
      yield {
        type: 'model_response',
        response: {
          content: response.content ?? '',
          toolCalls: response.toolCalls ?? [],
        },
      };
    });

    const service = createService();
    vi.spyOn(service, 'buildSystemPrompt').mockResolvedValue('System prompt');
    vi.spyOn(service, 'executeTool').mockResolvedValue({ result: { ok: true }, invalidateStores: [] });

    const messages: ChatMessage[] = [{ role: 'user', content: 'Проверь систему' }];
    const events = await collect(
      service.streamChat(BASE_USER, messages, undefined, new AbortController().signal, 'request-1')
    );

    expect(toolsPerRound[0]).toContain('get_current_context');
    expect(toolsPerRound[0]).toContain('send_comment');
    expect(toolsPerRound[1]).toEqual(['send_comment']);
    expect(toolsPerRound[2]).toContain('get_current_context');
    expect(toolsPerRound[2]).toContain('send_comment');
    expect(toolsPerRound[3]).toEqual(['send_comment']);
    expect(toolsPerRound[4]).toContain('get_current_context');
    expect(toolsPerRound[4]).toContain('send_comment');
    expect(JSON.stringify(messagesPerRound[2])).toContain(
      'response language for this run is now locked to the language of the first user-visible assistant text'
    );
    expect(JSON.stringify(messagesPerRound[4])).toContain(
      'Use that same language for every later progress update, question, and final answer'
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool_call_start', id: 'tool-1', name: 'get_current_context' }),
        expect.objectContaining({
          type: 'assistant_comment',
          content: 'Проверил первый шаг, продолжаю.',
        }),
        expect.objectContaining({ type: 'tool_call_start', id: 'tool-2', name: 'get_current_context' }),
        expect.objectContaining({
          type: 'assistant_comment',
          content: 'Проверил второй шаг, завершаю.',
        }),
        expect.objectContaining({ type: 'text_delta', content: 'Готово.' }),
        expect.objectContaining({ type: 'done' }),
      ])
    );
    expect(service.executeTool).toHaveBeenCalledTimes(2);
    const durableCalls = events.filter((event) => event.type === 'tool_round_start').flatMap((event) => event.calls);
    expect(durableCalls.map((call) => call.name)).not.toContain('send_comment');
  });

  it('offloads oversized post-redaction results and keeps client actions out of provider context', async () => {
    const providerMessages: Array<Record<string, unknown>[]> = [];
    const responses: MockModelResponse[] = [
      { toolCalls: [{ id: 'tool-large', name: 'get_current_context', arguments: '{}' }] },
      { content: 'Готово.', toolCalls: [] },
    ];
    mocks.streamModelResponse.mockImplementation(async function* ({
      messages,
    }: {
      messages: Record<string, unknown>[];
    }) {
      providerMessages.push(messages);
      const response = responses.shift();
      if (!response) throw new Error('unexpected model round');
      yield {
        type: 'model_response',
        response: { content: response.content ?? '', toolCalls: response.toolCalls ?? [] },
      };
    });

    const descriptor = {
      outputOffloaded: true as const,
      artifactId: 'artifact-1',
      format: 'json' as const,
      sizeBytes: 40_100,
      estimatedTokens: 10_025,
      preview: '{"payload":"xxx',
      downloadUrl: '/api/ai/sandbox/artifacts/artifact-1/download',
      readTool: 'read_tool_output' as const,
      searchTool: 'search_tool_output' as const,
    };
    const saveToolOutput = vi.fn().mockResolvedValue(descriptor);
    const service = createService({ ...BASE_CONFIG, maxToolRounds: 10 });
    Object.assign(service, { artifactService: { saveToolOutput } });
    vi.spyOn(service, 'buildSystemPrompt').mockResolvedValue('System prompt');
    vi.spyOn(service, 'executeTool').mockResolvedValue({
      result: { payload: 'x'.repeat(40_000), clientAction: { type: 'navigate', href: '/docker' } },
      invalidateStores: [],
    });

    const events = await collect(
      service.streamChat(
        BASE_USER,
        [{ role: 'user', content: 'Проверь систему' }],
        undefined,
        new AbortController().signal,
        'request-1',
        'conversation-1'
      )
    );

    expect(saveToolOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        conversationId: 'conversation-1',
        sourceRunId: 'request-1',
        sourceToolCallId: 'tool-large',
      })
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_result',
          id: 'tool-large',
          result: descriptor,
          clientAction: { type: 'navigate', href: '/docker' },
        }),
      ])
    );
    const toolMessage = providerMessages[1].find((message) => message.role === 'tool');
    expect(JSON.parse(String(toolMessage?.content))).toEqual(descriptor);
    const secondPayload = JSON.stringify(providerMessages[1]);
    expect(secondPayload).not.toContain('clientAction');
    expect(secondPayload).not.toContain('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('refreshes the approval mode before classifying each model tool round', async () => {
    const responses: MockModelResponse[] = [
      {
        toolCalls: [
          {
            id: 'tool-create-volume',
            name: 'manage_docker_volume',
            arguments: JSON.stringify({ operation: 'create', nodeId: 'node-1', name: 'test-volume' }),
          },
        ],
      },
      { content: 'Done', toolCalls: [] },
    ];
    mocks.streamModelResponse.mockImplementation(async function* () {
      const response = responses.shift();
      if (!response) throw new Error('unexpected model round');
      yield {
        type: 'model_response',
        response: { content: response.content ?? '', toolCalls: response.toolCalls ?? [] },
      };
    });
    const getUserById = vi.fn().mockResolvedValue({
      ...BASE_USER,
      aiApprovalMode: 'bypass-everything',
    });
    const service = createService({ ...BASE_CONFIG, maxToolRounds: 3 }, { getUserById });
    vi.spyOn(service, 'buildSystemPrompt').mockResolvedValue('System prompt');
    vi.spyOn(service, 'executeTool').mockResolvedValue({ result: { ok: true }, invalidateStores: [] });

    const events = await collect(
      service.streamChat(
        { ...BASE_USER, aiApprovalMode: 'normal' },
        [{ role: 'user', content: 'Create the volume' }],
        undefined,
        new AbortController().signal,
        'request-refresh-mode',
        'conversation-1'
      )
    );

    expect(getUserById).toHaveBeenCalledWith(BASE_USER.id);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_round_start',
          calls: [expect.objectContaining({ id: 'tool-create-volume', gate: 'immediate' })],
        }),
        expect.objectContaining({ type: 'tool_result', id: 'tool-create-volume' }),
      ])
    );
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_approval_required' })]));
  });

  it('applies all decided approvals sequentially before the next provider turn', async () => {
    const providerMessages: Array<Record<string, unknown>[]> = [];
    mocks.streamModelResponse.mockImplementation(async function* ({
      messages,
    }: {
      messages: Record<string, unknown>[];
    }) {
      providerMessages.push(messages);
      yield { type: 'model_response', response: { content: 'Done', toolCalls: [] } };
    });
    const service = createService({ ...BASE_CONFIG, maxToolRounds: 3 });
    vi.spyOn(service, 'buildSystemPrompt').mockResolvedValue('System prompt');
    vi.spyOn(service, 'executeTool').mockResolvedValue({ result: { ok: true }, invalidateStores: [] });

    const events = await collect(
      service.resumeAfterApproval(
        BASE_USER,
        'call-1',
        'get_current_context',
        {},
        true,
        [
          { role: 'user', content: 'Run both' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call-1', type: 'function', function: { name: 'get_current_context', arguments: '{}' } },
              { id: 'call-2', type: 'function', function: { name: 'get_current_context', arguments: '{}' } },
            ],
          },
        ],
        undefined,
        new AbortController().signal,
        'request-1',
        undefined,
        undefined,
        [{ id: 'call-2', name: 'get_current_context', arguments: {} }],
        'conversation-1',
        undefined,
        undefined,
        undefined,
        undefined,
        { 'call-2': false }
      )
    );

    expect(service.executeTool).toHaveBeenCalledTimes(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool_result', id: 'call-1' }),
        expect.objectContaining({ type: 'tool_result', id: 'call-2', rejected: true }),
        expect.objectContaining({ type: 'done' }),
      ])
    );
    expect(providerMessages).toHaveLength(1);
    const results = providerMessages[0].filter((message) => message.role === 'tool');
    expect(results.map((message) => message.tool_call_id)).toEqual(['call-1', 'call-2']);
  });

  it('offloads later inline results when the durable round budget is exhausted', async () => {
    const responses: MockModelResponse[] = [
      {
        toolCalls: [1, 2, 3].map((index) => ({
          id: `call-${index}`,
          name: 'get_current_context',
          arguments: '{}',
        })),
      },
      { content: 'Done', toolCalls: [] },
    ];
    mocks.streamModelResponse.mockImplementation(async function* () {
      const response = responses.shift();
      if (!response) throw new Error('unexpected model round');
      yield {
        type: 'model_response',
        response: { content: response.content ?? '', toolCalls: response.toolCalls ?? [] },
      };
    });
    const descriptor = {
      outputOffloaded: true as const,
      artifactId: 'artifact-round',
      format: 'json' as const,
      sizeBytes: 18_000,
      estimatedTokens: 6_000,
      preview: '{"payload":"xxx',
      downloadUrl: '/api/ai/sandbox/artifacts/artifact-round/download',
      readTool: 'read_tool_output' as const,
      searchTool: 'search_tool_output' as const,
    };
    const saveToolOutput = vi.fn().mockResolvedValue(descriptor);
    const service = createService({ ...BASE_CONFIG, maxToolRounds: 3 });
    Object.assign(service, { artifactService: { saveToolOutput } });
    vi.spyOn(service, 'buildSystemPrompt').mockResolvedValue('System prompt');
    vi.spyOn(service, 'executeTool').mockResolvedValue({
      result: { payload: 'x'.repeat(18_000) },
      invalidateStores: [],
    });

    const events = await collect(
      service.streamChat(
        BASE_USER,
        [{ role: 'user', content: 'Read three outputs' }],
        undefined,
        new AbortController().signal,
        'request-round-budget',
        'conversation-1'
      )
    );

    expect(saveToolOutput).toHaveBeenCalledTimes(1);
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool_result', id: 'call-3', result: descriptor })])
    );
  });
});
