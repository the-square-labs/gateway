import fs from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { InferenceProtocolError } from '@/modules/inference/protocol/inference-protocol.error.js';
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
  scopes: ['ai:workspace:use'],
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
  allowUserReasoningEffortSelection: false,
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

function createService(config: AIConfig = CONFIG, runtimeConfigured = true, artifactService?: unknown) {
  const execute = vi.fn().mockResolvedValue({
    responseId: 'response-1',
    resolvedModel: 'gateway-vision',
    events: (async function* () {
      yield { type: 'completed' as const, status: 'completed' as const };
    })(),
  });
  const inferencePolicies = { effective: vi.fn().mockResolvedValue({ enabled: true }) };
  const service = new AIProviderRuntimeService(
    {
      getConfig: vi.fn().mockResolvedValue(config),
      isEnabled: vi.fn().mockResolvedValue(config.enabled),
    } as never,
    { isFeatureEnabled: vi.fn().mockResolvedValue(true) } as never,
    {
      listForUser: vi.fn().mockResolvedValue({ object: 'list', data: MODELS }),
      listAdmin: vi.fn().mockResolvedValue([]),
    } as never,
    { isConfigured: vi.fn().mockReturnValue(runtimeConfigured), execute } as never,
    inferencePolicies as never,
    artifactService as never
  );
  return { service, execute, inferencePolicies };
}

describe('AIProviderRuntimeService', () => {
  it('exposes direct-provider reasoning choices only when the admin allows user selection', async () => {
    const { service } = createService({
      ...CONFIG,
      providerType: 'openai_compatible',
      allowUserReasoningEffortSelection: true,
    });

    await expect(service.statusForUser(USER)).resolves.toMatchObject({
      providerType: 'openai_compatible',
      allowUserModelSelection: false,
      allowUserReasoningEffortSelection: true,
      reasoningEfforts: ['default', 'low', 'medium', 'high'],
      defaultReasoningEffort: 'default',
    });
  });

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

  it('retries one transient Gateway Inference failure before the first model output', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { service, execute } = createService();
      execute
        .mockResolvedValueOnce({
          responseId: 'response-failed',
          resolvedModel: 'gateway-vision',
          events: (async function* () {
            yield {
              type: 'error' as const,
              code: 'upstream_error',
              message: 'Upstream inference request failed',
            };
          })(),
        })
        .mockResolvedValueOnce({
          responseId: 'response-retried',
          resolvedModel: 'gateway-vision',
          events: (async function* () {
            yield { type: 'output_text.delta' as const, delta: 'Recovered' };
            yield { type: 'completed' as const, status: 'completed' as const };
          })(),
        });
      const session = await service.resolveSession(USER, {
        requestId: 'run-retry',
        conversationId: 'conversation-1',
        requestedModel: 'gateway-vision',
        signal: new AbortController().signal,
      });
      const eventsPromise = (async () => {
        const events = [];
        for await (const event of session.stream([{ role: 'user', content: 'Hello' }], [])) {
          events.push(event);
        }
        return events;
      })();

      await vi.advanceTimersByTimeAsync(200);

      await expect(eventsPromise).resolves.toEqual([
        { type: 'text_delta', content: 'Recovered' },
        { type: 'model_response', response: { content: 'Recovered', toolCalls: [] } },
      ]);
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not retry after any upstream model output, including hidden reasoning', async () => {
    const { service, execute } = createService();
    execute.mockResolvedValueOnce({
      responseId: 'response-partial',
      resolvedModel: 'gateway-vision',
      events: (async function* () {
        yield { type: 'reasoning.delta' as const, itemId: 'reasoning-1', delta: 'Checking' };
        throw new InferenceProtocolError(502, 'upstream_error', 'Upstream inference request failed');
      })(),
    });
    const session = await service.resolveSession(USER, {
      requestId: 'run-no-retry',
      conversationId: 'conversation-1',
      requestedModel: 'gateway-vision',
      signal: new AbortController().signal,
    });

    const consume = async () => {
      for await (const _event of session.stream([{ role: 'user', content: 'Hello' }], [])) {
        // Consume the provider stream.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: 'upstream_error',
      details: { emittedOutput: true },
    });
    expect(execute).toHaveBeenCalledTimes(1);
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

  it('passes image-only attachments to the vision model when generating a title', async () => {
    const readFile = vi.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('image-bytes'));
    const artifactService = {
      getDownload: vi.fn().mockResolvedValue({
        filePath: '/tmp/title-image.png',
        metadata: { mediaType: 'image/png' },
      }),
    };
    const { service, execute } = createService(CONFIG, true, artifactService);
    execute.mockResolvedValueOnce({
      responseId: 'response-title-image',
      resolvedModel: 'gateway-vision',
      events: (async function* () {
        yield { type: 'output_text.delta' as const, delta: 'Возможности Gateway' };
        yield { type: 'completed' as const, status: 'completed' as const };
      })(),
    });

    await expect(
      service.generateConversationTitle(USER, {
        requestId: 'title-image',
        content: '',
        attachments: [
          {
            artifactId: 'artifact-1',
            filename: 'screen.png',
            mediaType: 'image/png',
            sizeBytes: 11,
            downloadUrl: '/api/ai/sandbox/artifacts/artifact-1/download',
            kind: 'image',
          },
        ],
        requestedModel: 'gateway-vision',
        signal: new AbortController().signal,
      })
    ).resolves.toBe('Возможности Gateway');

    expect(artifactService.getDownload).toHaveBeenCalledWith(USER.id, 'artifact-1');
    expect(readFile).toHaveBeenCalledWith('/tmp/title-image.png');
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain('data:image/png;base64,aW1hZ2UtYnl0ZXM=');
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain('"detail":"low"');
    readFile.mockRestore();
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

  it('applies a user reasoning override only when direct-provider selection is enabled', async () => {
    const directConfig: AIConfig = {
      ...CONFIG,
      providerType: 'openai_compatible',
      reasoningEffort: 'low',
      allowUserReasoningEffortSelection: true,
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

    const overridden = await service.resolveSession(USER, {
      requestId: 'direct-high',
      requestedReasoningEffort: 'high',
      signal: new AbortController().signal,
    });
    const usingDefault = await service.resolveSession(USER, {
      requestId: 'direct-default',
      requestedReasoningEffort: 'default',
      signal: new AbortController().signal,
    });

    expect(overridden.config.reasoningEffort).toBe('high');
    expect(overridden.reasoningEffort).toBe('high');
    expect(usingDefault.config.reasoningEffort).toBe('low');
  });

  it('rejects a direct-provider reasoning override when user selection is disabled', async () => {
    const directConfig: AIConfig = {
      ...CONFIG,
      providerType: 'openai_compatible',
      allowUserReasoningEffortSelection: false,
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

    await expect(
      service.resolveSession(USER, {
        requestId: 'direct-high',
        requestedReasoningEffort: 'high',
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: 'AI_REASONING_EFFORT_SELECTION_DISABLED' });
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
