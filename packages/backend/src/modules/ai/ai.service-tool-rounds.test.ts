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
  scopes: ['feat:ai:use'],
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

function createService() {
  return new AIService(
    {
      getConfig: vi.fn().mockResolvedValue(BASE_CONFIG),
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
    {} as never,
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

    mocks.streamModelResponse.mockImplementation(async function* ({
      tools,
    }: {
      tools: Array<{ function: { name: string } }>;
    }) {
      toolsPerRound.push(tools.map((tool) => tool.function.name));
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
  });
});
