import { describe, expect, it, vi } from 'vitest';
import type { User } from '@/types.js';
import type { AIConfig } from './ai.types.js';
import { AIProviderRuntimeService, normalizeGeneratedConversationTitle } from './ai-provider-runtime.service.js';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'operator@example.com',
  name: 'Operator',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'operators',
  scopes: ['feat:ai:use'],
  isBlocked: false,
};

const CONFIG: AIConfig = {
  enabled: true,
  providerType: 'gateway_inference',
  providerUrl: 'https://api.example.com/v1',
  endpointMode: 'responses',
  supportsImages: false,
  model: 'preserved-oai-model',
  gatewayInferenceModel: 'gateway-default',
  gatewayInferenceAllowUserModelSelection: true,
  maxCompletionTokens: 8192,
  maxTokensField: 'max_completion_tokens',
  reasoningEffort: 'none',
  customSystemPrompt: '',
  rateLimitMax: 10,
  rateLimitWindowSeconds: 60,
  maxToolRounds: 3,
  maxContextTokens: 56_000,
  disabledTools: [],
  webSearchEnabled: false,
  webSearchProvider: 'tavily',
  webSearchBaseUrl: '',
  sandboxEnabled: false,
  sandboxDefaultTier: 'low',
};

const MODELS = [
  {
    id: 'gateway-default',
    display_name: 'Gateway Default',
    input_modalities: ['text'],
    context_window: 128_000,
    max_input_tokens: 112_000,
    auto_compact_token_limit: 100_000,
    max_output_tokens: 16_000,
    supported_reasoning_efforts: ['low', 'high'],
    default_reasoning_effort: 'high',
  },
  {
    id: 'gateway-vision',
    display_name: 'Gateway Vision',
    input_modalities: ['text', 'image'],
    context_window: 160_000,
    max_input_tokens: 136_000,
    auto_compact_token_limit: 120_000,
    max_output_tokens: 24_000,
    supported_reasoning_efforts: ['low', 'high', 'max'],
    default_reasoning_effort: 'high',
  },
];

function createService(config: AIConfig = CONFIG, runtimeConfigured = true) {
  const execute = vi.fn().mockResolvedValue({
    responseId: 'response-1',
    resolvedModel: 'gateway-vision',
    events: (async function* () {
      yield { type: 'completed' as const, status: 'completed' as const };
    })(),
  });
  const inferencePolicies = { effective: vi.fn().mockResolvedValue({ enabled: true }) };
  const service = new AIProviderRuntimeService(
    { getConfig: vi.fn().mockResolvedValue(config) } as never,
    { isFeatureEnabled: vi.fn().mockResolvedValue(true) } as never,
    {
      listForUser: vi.fn().mockResolvedValue({ object: 'list', data: MODELS }),
      listAdmin: vi.fn().mockResolvedValue([]),
    } as never,
    { isConfigured: vi.fn().mockReturnValue(runtimeConfigured), execute } as never,
    inferencePolicies as never
  );
  return { service, execute, inferencePolicies };
}

describe('AIProviderRuntimeService', () => {
  it('uses a user-selected accessible Gateway Inference model and its limits', async () => {
    const { service, execute } = createService();
    const session = await service.resolveSession(USER, {
      requestId: 'run-1',
      conversationId: 'conversation-1',
      requestedModel: 'gateway-vision',
      requestedReasoningEffort: 'max',
      signal: new AbortController().signal,
    });

    expect(session.config).toMatchObject({
      model: 'gateway-vision',
      supportsImages: true,
      maxContextTokens: 136_000,
      maxCompletionTokens: 24_000,
      maxToolRounds: 20,
    });
    expect(session.contextLimits).toEqual({
      contextWindow: 160_000,
      maxInputTokens: 136_000,
      autoCompactTokenLimit: 120_000,
      outputReserveTokens: 24_000,
    });
    expect(session.reasoningEffort).toBe('max');
    for await (const _event of session.stream([{ role: 'user', content: 'Hello' }], [])) {
      // Consume the provider stream.
    }
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gateway-vision',
        maxOutputTokens: 24_000,
        reasoningEffort: 'max',
      }),
      expect.objectContaining({ userId: USER.id, tokenId: null })
    );
  });

  it('generates conversation titles with the selected model and its minimum reasoning effort', async () => {
    const { service, execute } = createService();
    execute.mockResolvedValueOnce({
      responseId: 'response-title',
      resolvedModel: 'gateway-vision',
      events: (async function* () {
        yield { type: 'output_text.delta' as const, delta: 'Docker ' };
        yield { type: 'output_text.delta' as const, delta: 'restart audit' };
        yield { type: 'completed' as const, status: 'completed' as const };
      })(),
    });

    await expect(
      service.generateConversationTitle(USER, {
        requestId: 'title-1',
        content: 'Audit the Docker restart behavior',
        requestedModel: 'gateway-vision',
        signal: new AbortController().signal,
      })
    ).resolves.toBe('Docker restart audit');

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gateway-vision',
        reasoningEffort: 'low',
        maxOutputTokens: 512,
        tools: [],
      }),
      expect.objectContaining({ existingThread: false })
    );
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain(
      'Do not analyze, reason through the request, or explain anything; answer immediately.'
    );
  });

  it('disables optional reasoning for direct-provider title generation', async () => {
    const directConfig: AIConfig = {
      ...CONFIG,
      providerType: 'openai_compatible',
      reasoningEffort: 'high',
    };
    const service = new AIProviderRuntimeService(
      {
        getConfig: vi.fn().mockResolvedValue(directConfig),
        getDecryptedApiKey: vi.fn().mockResolvedValue('test-key'),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    const session = await service.resolveSession(USER, {
      requestId: 'title-direct',
      preferMinimumReasoning: true,
      signal: new AbortController().signal,
    });

    expect(session.config.model).toBe('preserved-oai-model');
    expect(session.config.reasoningEffort).toBe('none');
    expect(session.reasoningEffort).toBeNull();
  });

  it('normalizes model-generated conversation titles', () => {
    expect(normalizeGeneratedConversationTitle('  **Title:** «Проверка Docker.»\nExtra text')).toBe('Проверка Docker');
    expect(normalizeGeneratedConversationTitle('Название: "Проверка Docker."')).toBe('Проверка Docker');
  });

  it('rejects changing the model when user selection is disabled', async () => {
    const { service } = createService({
      ...CONFIG,
      gatewayInferenceAllowUserModelSelection: false,
    });

    await expect(
      service.resolveSession(USER, {
        requestId: 'run-1',
        requestedModel: 'gateway-vision',
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: 'AI_MODEL_SELECTION_DISABLED' });
  });

  it('reports the assistant disabled while the inference runtime is unavailable', async () => {
    const { service } = createService(CONFIG, false);

    await expect(service.statusForUser(USER)).resolves.toMatchObject({
      enabled: false,
      providerType: 'gateway_inference',
      defaultModel: 'gateway-default',
    });
  });

  it('reports the assistant disabled when the current user is disabled in Gateway Inference', async () => {
    const { service, inferencePolicies } = createService();
    inferencePolicies.effective.mockResolvedValueOnce({ enabled: false });

    await expect(service.statusForUser(USER)).resolves.toMatchObject({ enabled: false });
  });

  it('rejects a reasoning effort unsupported by the selected model', async () => {
    const { service } = createService();

    await expect(
      service.resolveSession(USER, {
        requestId: 'run-1',
        requestedModel: 'gateway-default',
        requestedReasoningEffort: 'max',
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: 'AI_REASONING_EFFORT_UNAVAILABLE' });
  });
});
