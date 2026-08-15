import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/types.js';
import { AIService } from './ai.service.js';
import type { AIConfig, ChatMessage } from './ai.types.js';

const mocks = vi.hoisted(() => ({ streamModelResponse: vi.fn() }));

vi.mock('./ai.provider-adapter.js', () => ({
  streamModelResponse: mocks.streamModelResponse,
}));

const USER: User = {
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

const CONFIG: AIConfig = {
  enabled: true,
  providerType: 'openai_compatible',
  supportsImages: false,
  providerUrl: '',
  endpointMode: 'responses',
  model: 'gpt-test',
  gatewayInferenceModel: '',
  gatewayInferenceAllowUserModelSelection: false,
  allowUserReasoningEffortSelection: false,
  maxCompletionTokens: 8_000,
  maxTokensField: 'max_completion_tokens',
  reasoningEffort: 'none',
  customSystemPrompt: '',
  rateLimitMax: 10,
  rateLimitWindowSeconds: 60,
  maxToolRounds: 10,
  maxContextTokens: 64_000,
  disabledTools: [],
  webSearchEnabled: false,
  webSearchProvider: 'tavily',
  webSearchBaseUrl: '',
  sandboxEnabled: false,
  sandboxDefaultTier: 'low',
};

function createService(): AIService {
  const service = new AIService(
    {
      getConfig: vi.fn().mockResolvedValue(CONFIG),
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
  vi.spyOn(service, 'buildSystemPrompt').mockResolvedValue('Gateway system prompt');
  return service;
}

function sourceAndRecentMessages(lastContent = 'latest question'): ChatMessage[] {
  return [
    { id: 'old-user', role: 'user', content: 'old '.repeat(15_000) },
    {
      id: 'old-assistant-call',
      role: 'assistant',
      content: 'checking '.repeat(2_500),
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'get_current_context', arguments: JSON.stringify({ password: 'do-not-leak' }) },
        },
      ],
    },
    {
      id: 'old-tool-result',
      role: 'tool',
      name: 'get_current_context',
      tool_call_id: 'call-1',
      content: JSON.stringify({ password: 'also-secret', ok: true }),
    },
    { id: 'recent-user', role: 'user', content: 'recent '.repeat(2_400) },
    { id: 'recent-assistant', role: 'assistant', content: 'answer '.repeat(2_400) },
    { id: 'latest-user', role: 'user', content: lastContent },
  ];
}

describe('AI compaction v2', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.streamModelResponse.mockReset();
  });

  it('summarizes through an atomic tool-result boundary and redacts source secrets', async () => {
    const providerInputs: Array<{ messages: Record<string, unknown>[]; config: AIConfig }> = [];
    mocks.streamModelResponse.mockImplementation(async function* (input: {
      messages: Record<string, unknown>[];
      config: AIConfig;
    }) {
      providerInputs.push(input);
      yield { type: 'text_delta', content: 'Compacted state and decisions.' };
      yield {
        type: 'model_response',
        response: { content: 'Compacted state and decisions.', toolCalls: [] },
      };
    });
    const service = createService();

    const result = await service.compactConversationContext(
      USER,
      sourceAndRecentMessages(),
      undefined,
      new AbortController().signal,
      'auto',
      undefined,
      undefined,
      undefined
    );

    expect(result).toMatchObject({
      compacted: true,
      compactVersion: 2,
      compactEpoch: 1,
      compactBoundaryMessageId: 'old-tool-result',
      compactedMessageCount: 3,
      trigger: 'auto',
    });
    expect(result.sourceTokenEstimate).toBeGreaterThan(0);
    expect(result.resultTokenEstimate).toBeGreaterThan(0);
    expect(providerInputs[0].config.maxCompletionTokens).toBe(1_280);
    expect(result.reconstructedTokens).toBeLessThanOrEqual(result.targetTokens!);
    expect(result.targetAchieved).toBe(true);
    const compactionPayload = JSON.stringify(providerInputs[0].messages);
    expect(compactionPayload).not.toContain('do-not-leak');
    expect(compactionPayload).not.toContain('also-secret');
    expect(compactionPayload).toContain('[REDACTED]');
  });

  it('does not compact a single atomic turn', async () => {
    const service = createService();
    const result = await service.compactConversationContext(
      USER,
      [{ id: 'only-user', role: 'user', content: 'one turn' }],
      undefined,
      new AbortController().signal,
      'manual'
    );
    expect(result).toMatchObject({ compacted: false, compactVersion: 2, compactBoundaryMessageId: null });
    expect(mocks.streamModelResponse).not.toHaveBeenCalled();
  });

  it('blocks automatic compaction when the only atomic turn cannot be split', async () => {
    const service = createService();
    await expect(
      service.compactConversationContext(
        USER,
        [{ id: 'only-user', role: 'user', content: 'x'.repeat(260_000) }],
        undefined,
        new AbortController().signal,
        'auto'
      )
    ).rejects.toMatchObject({ code: 'AI_CONTEXT_TOO_LARGE' });
    expect(mocks.streamModelResponse).not.toHaveBeenCalled();
  });

  it('reports an irreducible floor above the target without silently dropping the atomic turn', async () => {
    const service = createService();
    const result = await service.compactConversationContext(
      USER,
      [{ id: 'only-user', role: 'user', content: 'x'.repeat(100_000) }],
      undefined,
      new AbortController().signal,
      'auto'
    );

    expect(result).toMatchObject({
      compacted: false,
      compactBoundaryMessageId: null,
      targetAchieved: false,
    });
    expect(result.reconstructedTokens).toBeGreaterThan(result.targetTokens!);
    expect(mocks.streamModelResponse).not.toHaveBeenCalled();
  });

  it('returns AI_CONTEXT_TOO_LARGE when summary plus the minimal recent turn cannot fit', async () => {
    mocks.streamModelResponse.mockImplementation(async function* () {
      yield { type: 'model_response', response: { content: 'Short summary.', toolCalls: [] } };
    });
    const service = createService();
    await expect(
      service.compactConversationContext(
        USER,
        sourceAndRecentMessages('x'.repeat(260_000)),
        undefined,
        new AbortController().signal,
        'auto'
      )
    ).rejects.toMatchObject({ code: 'AI_CONTEXT_TOO_LARGE' });
  });
});
