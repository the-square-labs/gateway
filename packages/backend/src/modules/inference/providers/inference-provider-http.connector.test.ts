import { describe, expect, it, vi } from 'vitest';
import { InferenceProviderRegistry } from './inference-provider.registry.js';
import { InferenceProviderHttpConnector } from './inference-provider-http.connector.js';

describe('InferenceProviderHttpConnector', () => {
  const registry = new InferenceProviderRegistry();

  it('normalizes discovered models and sends provider-specific authorization', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'gpt-test',
              display_name: 'GPT Test',
              input_token_limit: 128_000,
              output_token_limit: 32_000,
              input_modalities: ['text', 'image'],
              reasoning_efforts: ['low', 'high'],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const connector = new InferenceProviderHttpConnector(fetcher);

    const models = await connector.discoverModels(
      registry.require('openai'),
      { accessToken: 'secret', accountId: 'acct-1' },
      'https://chatgpt.com/backend-api/codex/'
    );

    expect(models).toEqual([
      expect.objectContaining({
        id: 'gpt-test',
        contextWindow: 128_000,
        maxOutputTokens: 32_000,
        modalities: ['text', 'image'],
        capabilities: { reasoning: true, tools: true, vision: true },
      }),
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/codex/models?client_version=0.145.0',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
          'chatgpt-account-id': 'acct-1',
        }),
      })
    );
  });

  it('normalizes the Codex subscription model catalog shape', async () => {
    const connector = new InferenceProviderHttpConnector(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            models: [
              {
                slug: 'gpt-5.6-sol',
                display_name: 'GPT-5.6 Sol',
                context_window: 272_000,
                effective_context_window_percent: 95,
                auto_compact_token_limit: 240_000,
                supported_reasoning_levels: [{ effort: 'high' }, { effort: 'xhigh' }],
                additional_speed_tiers: ['fast'],
                service_tiers: [{ id: 'priority', name: 'Fast', description: 'Priority processing' }],
                input_modalities: ['text', 'image'],
                supported_in_api: true,
                visibility: 'list',
              },
              { slug: 'hidden', supported_in_api: false, visibility: 'hide' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    const models = await connector.discoverModels(
      registry.require('openai'),
      { accessToken: 'secret', accountId: 'acct-1' },
      'https://chatgpt.com/backend-api/codex'
    );

    expect(models).toEqual([
      expect.objectContaining({
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        contextWindow: 272_000,
        maxInputTokens: 258_400,
        autoCompactTokenLimit: 240_000,
        reasoningEfforts: ['high', 'xhigh'],
        capabilities: { reasoning: true, tools: true, vision: true },
        metadata: expect.objectContaining({
          additional_speed_tiers: ['fast'],
          service_tiers: [{ id: 'priority', name: 'Fast', description: 'Priority processing' }],
        }),
      }),
    ]);
  });

  it('fills OpenAI API model metadata and pricing missing from the models endpoint', async () => {
    const connector = new InferenceProviderHttpConnector(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'gpt-5.1-codex-mini', object: 'model' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    const models = await connector.discoverModels(
      registry.require('openai-apikey'),
      { apiKey: 'secret' },
      'https://api.openai.com/v1'
    );

    expect(models).toEqual([
      expect.objectContaining({
        id: 'gpt-5.1-codex-mini',
        displayName: 'GPT-5.1-Codex mini',
        contextWindow: 400_000,
        maxInputTokens: 272_000,
        maxOutputTokens: 128_000,
        autoCompactTokenLimit: 244_800,
        modalities: ['text', 'image'],
        capabilities: { reasoning: true, tools: true, vision: true },
        reasoningEfforts: ['low', 'medium', 'high'],
        pricing: expect.objectContaining({
          version: 'openai-api-2026-07-27',
          inputMicrodollarsPerMillion: 250_000,
          cachedInputMicrodollarsPerMillion: 25_000,
          outputMicrodollarsPerMillion: 2_000_000,
          source: 'provider',
        }),
      }),
    ]);
  });

  it('fills common GPT-4 defaults when OpenAI returns only a model ID', async () => {
    const connector = new InferenceProviderHttpConnector(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'gpt-4', object: 'model' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    const [model] = await connector.discoverModels(
      registry.require('openai-apikey'),
      { apiKey: 'secret' },
      'https://api.openai.com/v1'
    );

    expect(model).toMatchObject({
      id: 'gpt-4',
      contextWindow: 8_192,
      maxInputTokens: 8_192,
      maxOutputTokens: 8_192,
      capabilities: { reasoning: false, tools: true, vision: false },
      pricing: {
        inputMicrodollarsPerMillion: 30_000_000,
        outputMicrodollarsPerMillion: 60_000_000,
        source: 'provider',
      },
    });
  });

  it('reads Claude Models API limits and capabilities before applying pricing defaults', async () => {
    const connector = new InferenceProviderHttpConnector(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'claude-sonnet-5',
                display_name: 'Claude Sonnet 5',
                max_input_tokens: 900_000,
                max_tokens: 100_000,
                capabilities: {
                  image_input: { supported: true },
                  thinking: { supported: true },
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    const [model] = await connector.discoverModels(
      registry.require('anthropic-apikey'),
      { apiKey: 'secret' },
      'https://api.anthropic.com'
    );

    expect(model).toMatchObject({
      contextWindow: 900_000,
      maxInputTokens: 900_000,
      maxOutputTokens: 100_000,
      modalities: ['text', 'image'],
      capabilities: { reasoning: true, tools: true, vision: true },
      pricing: {
        inputMicrodollarsPerMillion: 2_000_000,
        cachedInputMicrodollarsPerMillion: 200_000,
        cacheWriteMicrodollarsPerMillion: 2_500_000,
        outputMicrodollarsPerMillion: 10_000_000,
      },
    });
  });

  it('paginates Anthropic model discovery and deduplicates repeated IDs', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: 'claude-sonnet-5' }], has_more: true, last_id: 'claude-sonnet-5' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5' }, { id: 'claude-opus-5' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    const connector = new InferenceProviderHttpConnector(fetcher);

    const models = await connector.discoverModels(
      registry.require('anthropic-apikey'),
      { apiKey: 'secret' },
      'https://api.anthropic.com'
    );

    expect(models.map((model) => model.id)).toEqual(['claude-sonnet-5', 'claude-opus-5']);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://api.anthropic.com/v1/models?after_id=claude-sonnet-5&limit=100',
      expect.any(Object)
    );
  });

  it('fills Kimi K3 metadata and pricing when Moonshot returns only its ID', async () => {
    const connector = new InferenceProviderHttpConnector(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'kimi-k3' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    const [model] = await connector.discoverModels(
      registry.require('moonshot'),
      { apiKey: 'secret' },
      'https://api.moonshot.ai/v1'
    );

    expect(model).toMatchObject({
      contextWindow: 1_048_576,
      maxInputTokens: 1_048_576,
      modalities: ['text', 'image', 'video'],
      capabilities: { reasoning: true, tools: true, vision: true },
      reasoningEfforts: ['low', 'high', 'max'],
      pricing: {
        inputMicrodollarsPerMillion: 3_000_000,
        cachedInputMicrodollarsPerMillion: 300_000,
        outputMicrodollarsPerMillion: 15_000_000,
      },
    });
  });

  it('normalizes metadata and live per-token pricing returned by OpenRouter', async () => {
    const connector = new InferenceProviderHttpConnector(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'openai/gpt-test',
                name: 'GPT Test',
                context_length: 128_000,
                architecture: { input_modalities: ['text', 'image'] },
                supported_parameters: ['tools', 'reasoning'],
                top_provider: { max_completion_tokens: 16_000 },
                pricing: {
                  prompt: '0.00000025',
                  completion: '0.000002',
                  input_cache_read: '0.000000025',
                  internal_reasoning: '0.000002',
                  web_search: '0.004',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    const models = await connector.discoverModels(
      registry.require('openrouter'),
      { apiKey: 'secret' },
      'https://openrouter.ai/api/v1'
    );

    expect(models[0]).toMatchObject({
      contextWindow: 128_000,
      maxInputTokens: 112_000,
      maxOutputTokens: 16_000,
      modalities: ['text', 'image'],
      capabilities: { reasoning: true, tools: true, vision: true },
      pricing: {
        inputMicrodollarsPerMillion: 250_000,
        cachedInputMicrodollarsPerMillion: 25_000,
        outputMicrodollarsPerMillion: 2_000_000,
        reasoningMicrodollarsPerMillion: 2_000_000,
        otherUnitPrices: { web_search_query: 4_000 },
        source: 'provider',
        version: expect.stringMatching(/^openrouter-models-/),
      },
    });
  });

  it('normalizes xAI model pricing expressed as cents per 100 million tokens', async () => {
    const connector = new InferenceProviderHttpConnector(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'grok-test',
                context_length: 500_000,
                input_modalities: ['text', 'image'],
                prompt_text_token_price: 12_500,
                cached_prompt_text_token_price: 2_000,
                completion_text_token_price: 25_000,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    const [model] = await connector.discoverModels(
      registry.require('xai-apikey'),
      { apiKey: 'secret' },
      'https://api.x.ai/v1'
    );

    expect(model).toMatchObject({
      contextWindow: 500_000,
      modalities: ['text', 'image'],
      pricing: {
        inputMicrodollarsPerMillion: 1_250_000,
        cachedInputMicrodollarsPerMillion: 200_000,
        outputMicrodollarsPerMillion: 2_500_000,
        source: 'provider',
        version: expect.stringMatching(/^xai-models-/),
      },
    });
  });

  it('applies Codex context and compaction defaults when the catalog omits them', async () => {
    const connector = new InferenceProviderHttpConnector(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            models: [
              {
                slug: 'gpt-defaults',
                context_window: 272_000,
                auto_compact_token_limit: null,
                supported_reasoning_levels: [{ effort: 'medium' }],
                supported_in_api: true,
                visibility: 'list',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    const models = await connector.discoverModels(
      registry.require('openai'),
      { accessToken: 'secret', accountId: 'acct-1' },
      'https://chatgpt.com/backend-api/codex'
    );

    expect(models).toEqual([
      expect.objectContaining({
        contextWindow: 272_000,
        maxInputTokens: 258_400,
        autoCompactTokenLimit: 244_800,
      }),
    ]);
  });

  it('normalizes the Kimi subscription catalog capability fields', async () => {
    const connector = new InferenceProviderHttpConnector(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'k3',
                display_name: 'K3',
                context_length: 1_048_576,
                max_tokens: 1_048_576,
                think_efforts: { support: true, valid_efforts: ['low', 'high', 'max'] },
                supports_reasoning: true,
                supports_image_in: true,
                supports_video_in: true,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    const models = await connector.discoverModels(
      registry.require('kimi'),
      { accessToken: 'secret' },
      'https://api.kimi.com/coding/v1'
    );

    expect(models).toEqual([
      expect.objectContaining({
        id: 'k3',
        contextWindow: 1_048_576,
        modalities: ['text', 'image', 'video'],
        reasoningEfforts: ['low', 'high', 'max'],
        capabilities: { reasoning: true, tools: true, vision: true },
      }),
    ]);
    expect(models[0]?.maxOutputTokens).toBeUndefined();
  });

  it('normalizes subscription windows for ChatGPT and Anthropic', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: { limit_window_seconds: 18_000, used_percent: 25, reset_at: 2_000_000_000 },
              secondary_window: { limit_window_seconds: 604_800, used_percent: 80, reset_at: 2_000_100_000 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 10, resets_at: '2030-01-01T00:00:00Z' },
            seven_day_sonnet: { utilization: 75, resets_at: '2030-01-02T00:00:00Z' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    const connector = new InferenceProviderHttpConnector(fetcher);

    const openai = await connector.fetchQuota(registry.require('openai'), { accessToken: 'openai-token' });
    const anthropic = await connector.fetchQuota(registry.require('anthropic'), { accessToken: 'claude-token' });

    expect(openai.map((window) => window.dimension)).toEqual(['5h', '7d']);
    expect(openai[0]?.remainingFraction).toBeCloseTo(0.75);
    expect(openai[1]?.remainingFraction).toBeCloseTo(0.2);
    expect(anthropic).toEqual([
      expect.objectContaining({ dimension: '5h', remainingFraction: 0.9 }),
      expect.objectContaining({ dimension: '7d:sonnet', modelBucket: 'sonnet', remainingFraction: 0.25 }),
    ]);
  });

  it('normalizes Kimi top-level weekly usage and duration-based 5-hour limits', async () => {
    const connector = new InferenceProviderHttpConnector(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            usage: {
              limit: '100',
              used: '15',
              remaining: '85',
              resetTime: '2030-01-07T00:00:00Z',
            },
            limits: [
              {
                window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
                detail: {
                  limit: '100',
                  remaining: '80',
                  resetTime: '2030-01-01T00:00:00Z',
                },
              },
            ],
            totalQuota: { limit: '1000', remaining: '990' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    const quota = await connector.fetchQuota(registry.require('kimi'), { accessToken: 'kimi-token' });

    expect(quota).toEqual([
      expect.objectContaining({
        dimension: '5h',
        remainingFraction: 0.8,
        resetAt: new Date('2030-01-01T00:00:00Z'),
      }),
      expect.objectContaining({
        dimension: '7d',
        remainingFraction: 0.85,
        resetAt: new Date('2030-01-07T00:00:00Z'),
      }),
      expect.objectContaining({ dimension: 'subscription', remainingFraction: 0.99 }),
    ]);
    expect(quota.some((window) => window.dimension === '30d')).toBe(false);
  });

  it('normalizes xAI subscription monthly billing quota', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          config: {
            monthlyLimit: { val: 10_000 },
            used: { val: 2_500 },
            billingPeriodEnd: '2030-02-01T00:00:00Z',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const connector = new InferenceProviderHttpConnector(fetcher);

    const quota = await connector.fetchQuota(registry.require('xai'), { accessToken: 'xai-token' });

    expect(quota).toEqual([
      expect.objectContaining({
        dimension: '30d',
        remainingFraction: 0.75,
        remainingValue: '7500',
        limitValue: '10000',
        resetAt: new Date('2030-02-01T00:00:00Z'),
      }),
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      'https://cli-chat-proxy.grok.com/v1/billing',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer xai-token' }) })
    );
  });

  it('redacts credentials from provider failures', async () => {
    const connector = new InferenceProviderHttpConnector(
      vi.fn().mockResolvedValue(new Response('no', { status: 401 }))
    );
    await expect(
      connector.fetchQuota(registry.require('openai'), { accessToken: 'must-not-leak' })
    ).rejects.toMatchObject({
      code: 'provider_reauth_required',
      message: expect.not.stringContaining('must-not-leak'),
    });
  });

  it('returns the provider rejection reason without exposing credentials', async () => {
    const connector = new InferenceProviderHttpConnector(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: 'Unsupported input role for api_key=sk-secret-credential',
            },
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
    );

    await expect(
      connector.execute!(
        registry.require('openai'),
        { accessToken: 'must-not-leak', accountId: 'acct-1' },
        'https://chatgpt.com/backend-api/codex',
        'gpt-test',
        {
          protocol: 'responses',
          model: 'gpt-test',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'secret prompt' }] }],
          tools: [],
          stream: true,
          isCompaction: false,
          extensions: {},
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      code: 'provider_request_rejected',
      message: 'Provider rejected the request: Unsupported input role for api_key=[redacted]',
    });
  });

  it('maps a provider quota rejection to a useful public error', async () => {
    const connector = new InferenceProviderHttpConnector(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'insufficient_quota',
              message: 'Your quota is exhausted for this billing period.',
            },
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
    );

    await expect(
      connector.execute!(
        registry.require('openai'),
        { accessToken: 'must-not-leak', accountId: 'acct-1' },
        'https://chatgpt.com/backend-api/codex',
        'gpt-test',
        {
          protocol: 'responses',
          model: 'gpt-test',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
          tools: [],
          stream: true,
          isCompaction: false,
          extensions: {},
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      code: 'provider_request_rejected',
      message: 'Provider quota is exhausted. Try again later or choose another model.',
    });
  });

  it('returns a useful error when the provider rate limits inference', async () => {
    const connector = new InferenceProviderHttpConnector(
      vi.fn().mockResolvedValue(new Response('busy', { status: 429 }))
    );

    await expect(
      connector.execute!(
        registry.require('kimi'),
        { accessToken: 'must-not-leak' },
        'https://api.kimi.com/coding',
        'k3',
        {
          protocol: 'responses',
          model: 'k3',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
          tools: [],
          stream: true,
          isCompaction: false,
          extensions: {},
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      code: 'provider_rate_limited',
      message: 'Provider is rate limited: busy',
    });
  });

  it('flushes a final SSE terminal frame without a trailing blank line', async () => {
    const connector = new InferenceProviderHttpConnector(
      vi.fn().mockResolvedValue(
        new Response(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp-upstream',
              model: 'gpt-test',
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          })}`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )
      )
    );
    const execution = await connector.execute!(
      registry.require('openai'),
      { accessToken: 'secret', accountId: 'acct-1' },
      'https://chatgpt.com/backend-api/codex',
      'gpt-test',
      {
        protocol: 'responses',
        model: 'gpt-test',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
        stream: true,
        isCompaction: false,
        extensions: {},
      },
      new AbortController().signal
    );
    const events = [];
    for await (const event of execution.events) events.push(event);

    expect(events).toEqual([expect.objectContaining({ type: 'completed', status: 'completed', finishReason: 'stop' })]);
  });

  it('routes xAI subscription traffic through the Grok CLI transport contract', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );
    const connector = new InferenceProviderHttpConnector(fetcher);

    await connector.execute!(
      registry.require('xai'),
      { accessToken: 'xai-token' },
      'https://api.x.ai/v1',
      'grok-test',
      {
        protocol: 'chat_completions',
        model: 'grok-test',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
        stream: true,
        promptCacheKey: 'thread-1',
        isCompaction: false,
        extensions: {},
      },
      new AbortController().signal
    );

    expect(fetcher).toHaveBeenCalledWith(
      'https://cli-chat-proxy.grok.com/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer xai-token',
          'x-grok-client-identifier': 'opencodex',
          'x-grok-client-version': '0.2.93',
          'x-xai-token-auth': 'xai-grok-cli',
          'x-grok-req-id': expect.any(String),
          'x-grok-conv-id': expect.stringMatching(/^[a-f0-9]{32}$/),
          'x-grok-session-id': expect.stringMatching(/^[a-f0-9]{32}$/),
        }),
      })
    );
  });
});
