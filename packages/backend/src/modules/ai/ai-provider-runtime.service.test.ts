import { describe, expect, it, vi } from 'vitest';
import type { User } from '@/types.js';
import type { AIConfig } from './ai.types.js';
import { AIProviderRuntimeService } from './ai-provider-runtime.service.js';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'operator@example.com',
  name: 'Operator',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'operators',
  scopes: ['feat:ai:use', 'inference:use'],
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
    auto_compact_token_limit: 100_000,
    max_output_tokens: 16_000,
    supported_reasoning_efforts: ['low', 'high'],
    default_reasoning_effort: 'high',
  },
  {
    id: 'gateway-vision',
    display_name: 'Gateway Vision',
    input_modalities: ['text', 'image'],
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
      maxContextTokens: 120_000,
      maxCompletionTokens: 24_000,
      maxToolRounds: 20,
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
