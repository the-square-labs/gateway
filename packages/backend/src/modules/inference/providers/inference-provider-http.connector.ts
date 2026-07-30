import { createHash, randomUUID } from 'node:crypto';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { antigravityRequest } from './inference-antigravity.js';
import type { InferenceDestinationPolicy } from './inference-destination-policy.js';
import { pinnedFetch } from './inference-pinned-fetch.js';
import type {
  DiscoveredInferenceModel,
  InferenceCredentialPayload,
  InferenceProviderConnector,
  InferenceProviderDefinition,
  InferenceQuotaWindow,
} from './inference-provider.types.js';
import { knownProviderModel } from './inference-provider-model-catalog.js';
import {
  createProviderStreamState,
  parseProviderEvent,
  providerInferencePath,
  providerRequestBody,
} from './inference-provider-wire.js';

type Fetcher = typeof fetch;
type JsonObject = Record<string, unknown>;
const CODEX_MODELS_CLIENT_VERSION = '0.145.0';
const CODEX_EFFECTIVE_CONTEXT_PERCENT = 95;
const CODEX_AUTO_COMPACT_PERCENT = 90;

export class InferenceProviderHttpConnector implements InferenceProviderConnector {
  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly destinations?: InferenceDestinationPolicy
  ) {}

  async discoverModels(
    definition: InferenceProviderDefinition,
    credential: InferenceCredentialPayload,
    baseUrl: string,
    signal?: AbortSignal,
    allowPrivateNetwork = false
  ): Promise<DiscoveredInferenceModel[]> {
    if (!definition.modelsPath) return staticModels(definition);
    let url = modelDiscoveryUrl(definition, effectiveBaseUrl(definition, baseUrl));
    const rows: unknown[] = [];
    for (let page = 0; page < 20; page += 1) {
      const response = await this.request(
        url,
        {
          headers: this.authHeaders(definition, credential),
          redirect: 'manual',
          signal: signal ?? AbortSignal.timeout(30_000),
        },
        allowPrivateNetwork
      );
      if (!response.ok) {
        throw new InferenceProtocolError(
          response.status === 401 || response.status === 403 ? 401 : 502,
          'provider_discovery_failed',
          `Provider model discovery failed with HTTP ${response.status}`
        );
      }
      const payload = await response.json();
      rows.push(...modelRows(payload));
      const objectPayload = asObject(payload);
      const lastId = typeof objectPayload?.last_id === 'string' ? objectPayload.last_id : undefined;
      if (definition.family !== 'anthropic' || objectPayload?.has_more !== true || !lastId) break;
      const next = new URL(url);
      next.searchParams.set('after_id', lastId);
      next.searchParams.set('limit', '100');
      url = next.toString();
    }
    const normalized = rows
      .map((model) => normalizeModel(model, definition))
      .filter((model): model is DiscoveredInferenceModel => model !== null);
    return [...new Map(normalized.map((model) => [model.id, model])).values()];
  }

  async fetchQuota(
    definition: InferenceProviderDefinition,
    credential: InferenceCredentialPayload,
    signal?: AbortSignal
  ): Promise<InferenceQuotaWindow[]> {
    if (!definition.quotaKind) return [];
    const url = quotaUrl(definition.quotaKind);
    const response = await this.request(url, {
      headers: this.authHeaders(definition, credential),
      redirect: 'manual',
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new InferenceProtocolError(401, 'provider_reauth_required', 'Provider credential needs reauthentication');
      }
      if (response.status === 429) {
        throw new InferenceProtocolError(429, 'provider_rate_limited', 'Provider quota endpoint is rate limited');
      }
      throw new InferenceProtocolError(
        502,
        'provider_quota_failed',
        `Provider quota sync failed with HTTP ${response.status}`
      );
    }
    const payload = asObject(await response.json());
    if (!payload) return [];
    if (definition.quotaKind === 'chatgpt-wham') return parseWhamQuota(payload);
    if (definition.quotaKind === 'anthropic-oauth') return parseAnthropicQuota(payload);
    if (definition.quotaKind === 'xai-billing') return parseXaiQuota(payload);
    return parseKimiQuota(payload);
  }

  async execute(
    definition: InferenceProviderDefinition,
    credential: InferenceCredentialPayload,
    baseUrl: string,
    upstreamModel: string,
    request: import('../protocol/inference-protocol.types.js').InferenceRequest,
    signal: AbortSignal,
    allowPrivateNetwork = false
  ) {
    const antigravity =
      definition.id === 'google-antigravity'
        ? antigravityRequest(
            credential,
            upstreamModel,
            providerRequestBody(definition, upstreamModel, request),
            request.promptCacheKey
          )
        : null;
    const response = await this.request(
      joinUrl(
        effectiveBaseUrl(definition, baseUrl),
        antigravity?.path ?? providerInferencePath(definition, upstreamModel)
      ),
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(definition, credential),
          ...providerRuntimeHeaders(definition, credential, request.promptCacheKey),
          'Content-Type': 'application/json',
          ...antigravity?.headers,
        },
        body: JSON.stringify(antigravity?.body ?? providerRequestBody(definition, upstreamModel, request)),
        redirect: 'manual',
        signal,
      },
      allowPrivateNetwork
    );
    if (!response.ok || !response.body) {
      const status = response.status === 401 || response.status === 403 ? 401 : response.status === 429 ? 429 : 502;
      const message = await providerFailureMessage(response);
      throw new InferenceProtocolError(status, providerErrorCode(response.status), message);
    }
    const state = createProviderStreamState(upstreamModel, request.tools);
    return {
      responseId: state.responseId,
      resolvedModel: upstreamModel,
      events: decodeSse(response.body, (payload) => parseProviderEvent(definition, payload, state)),
    };
  }

  async rawRequest(
    definition: InferenceProviderDefinition,
    credential: InferenceCredentialPayload,
    baseUrl: string,
    path: string,
    init: RequestInit,
    allowPrivateNetwork = false
  ): Promise<Response> {
    return this.request(
      joinUrl(baseUrl, path),
      {
        ...init,
        headers: {
          ...this.authHeaders(definition, credential),
          ...(init.headers as Record<string, string> | undefined),
        },
        redirect: 'manual',
      },
      allowPrivateNetwork
    );
  }

  private async request(url: string, init: RequestInit, allowPrivateNetwork = false): Promise<Response> {
    if (!this.destinations) return this.fetcher(url, init);
    const destination = await this.destinations.assertAllowed(url, allowPrivateNetwork);
    return pinnedFetch(url, init, destination);
  }

  private authHeaders(
    definition: InferenceProviderDefinition,
    credential: InferenceCredentialPayload
  ): Record<string, string> {
    const token = credential.accessToken ?? credential.apiKey;
    if (!token && (definition.authTypes.includes('local') || definition.keyOptional)) {
      return { Accept: 'application/json', ...definition.staticHeaders };
    }
    if (!token) throw new InferenceProtocolError(401, 'provider_credential_missing', 'Provider credential is missing');
    const headerMode =
      definition.authHeader ?? (definition.family === 'anthropic' && credential.apiKey ? 'x-api-key' : 'bearer');
    if (headerMode !== 'bearer') {
      const headerName = headerMode;
      return {
        Accept: 'application/json',
        [headerName]: token,
        ...(definition.family === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
        ...definition.staticHeaders,
      };
    }
    if (definition.family === 'anthropic' && credential.apiKey) {
      return { Accept: 'application/json', 'x-api-key': credential.apiKey, 'anthropic-version': '2023-06-01' };
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...definition.staticHeaders,
    };
    if (definition.id === 'openai' && credential.accountId) headers['chatgpt-account-id'] = credential.accountId;
    if (definition.id === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20';
      headers['User-Agent'] = '@anthropic-ai/sdk/0.74.0';
      headers['X-App'] = 'cli';
      headers['X-Stainless-Retry-Count'] = '0';
      headers['X-Stainless-Runtime'] = 'node';
      headers['X-Stainless-Lang'] = 'js';
      headers['X-Stainless-Timeout'] = '600';
      headers['X-Stainless-Arch'] = process.arch;
      headers['X-Stainless-OS'] = process.platform;
      headers['X-Stainless-Package-Version'] = '0.74.0';
      headers['X-Stainless-Runtime-Version'] = process.version.slice(1);
      headers['X-Claude-Code-Session-Id'] = stableClaudeSessionId(token);
      headers['x-client-request-id'] = randomUUID();
    }
    if (definition.id === 'kimi') {
      headers['User-Agent'] = 'KimiCLI/0.14.0';
      headers['X-Msh-Platform'] = 'kimi_code_cli';
      headers['X-Msh-Version'] = '0.14.0';
    }
    return headers;
  }
}

function staticModels(definition: InferenceProviderDefinition): DiscoveredInferenceModel[] {
  return (definition.staticModels ?? []).map((id) => ({
    id,
    modalities: ['text'],
    capabilities: { tools: true, reasoning: false, vision: false },
    reasoningEfforts: [],
    metadata: { source: 'registry' },
  }));
}

async function* decodeSse(
  body: ReadableStream<Uint8Array>,
  parse: (payload: JsonObject) => import('../protocol/inference-protocol.types.js').InferenceStreamEvent[]
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parseFrame = (frame: string) => {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return [];
    const payload = asObject(JSON.parse(data));
    return payload ? parse(payload) : [];
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const event of parseFrame(frame)) yield event;
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode().replace(/\r\n/g, '\n');
    if (buffer.trim()) {
      for (const event of parseFrame(buffer)) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function providerErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'provider_reauth_required';
  if (status === 429) return 'provider_rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'provider_request_rejected';
}

async function providerFailureMessage(response: Response): Promise<string> {
  if (response.status === 401 || response.status === 403) {
    return 'Provider credential needs reauthentication.';
  }

  const reason = await readProviderFailureReason(response);
  if (isQuotaFailure(reason)) {
    return 'Provider quota is exhausted. Try again later or choose another model.';
  }
  if (response.status === 429) {
    return reason
      ? `Provider is rate limited: ${reason}`
      : 'Provider is rate limited. Try again shortly or choose another model.';
  }
  if (reason) return `Provider rejected the request: ${reason}`;
  return `Provider request failed with HTTP ${response.status}`;
}

async function readProviderFailureReason(response: Response): Promise<string | null> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  try {
    const payload = asObject(JSON.parse(raw));
    const error = asObject(payload?.error);
    const code = firstNonEmptyString(error?.code, payload?.code);
    if (isQuotaFailure(code)) return code;
    const reason = firstNonEmptyString(
      error?.message,
      error?.detail,
      error?.error,
      payload?.message,
      payload?.detail,
      payload?.error_description
    );
    return reason ? sanitizeProviderFailureReason(reason) : null;
  } catch {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('text/plain') || raw.includes('<html')) return null;
    return sanitizeProviderFailureReason(raw);
  }
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function sanitizeProviderFailureReason(value: string): string | null {
  const normalized = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(?:gwi|sk|rk|pk)[_-][A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(
      /((?:access[_ -]?token|refresh[_ -]?token|api[_ -]?key|authorization)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi,
      '$1[redacted]'
    )
    .trim();
  return normalized ? normalized.slice(0, 400) : null;
}

function isQuotaFailure(reason: string | null): boolean {
  return (
    reason !== null &&
    (/\binsufficient[_ -]?quota\b/i.test(reason) ||
      /\b(?:quota|credits?|credit balance)\b.{0,80}\b(?:exhausted|exceeded|depleted|insufficient)\b/i.test(reason) ||
      /\b(?:exhausted|exceeded|depleted)\b.{0,80}\bquota\b/i.test(reason) ||
      /\bbilling limit\b/i.test(reason))
  );
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function modelDiscoveryUrl(definition: InferenceProviderDefinition, baseUrl: string): string {
  const joined = joinUrl(baseUrl, definition.modelsPath ?? 'models');
  if (definition.id !== 'openai') return joined;
  const url = new URL(joined);
  url.searchParams.set('client_version', CODEX_MODELS_CLIENT_VERSION);
  return url.toString();
}

function quotaUrl(kind: NonNullable<InferenceProviderDefinition['quotaKind']>): string {
  if (kind === 'chatgpt-wham') return 'https://chatgpt.com/backend-api/wham/usage';
  if (kind === 'anthropic-oauth') return 'https://api.anthropic.com/api/oauth/usage';
  if (kind === 'xai-billing') return 'https://cli-chat-proxy.grok.com/v1/billing';
  return 'https://api.kimi.com/coding/v1/usages';
}

function effectiveBaseUrl(definition: InferenceProviderDefinition, configuredBaseUrl: string): string {
  return definition.id === 'xai' ? 'https://cli-chat-proxy.grok.com/v1' : configuredBaseUrl;
}

function providerRuntimeHeaders(
  definition: InferenceProviderDefinition,
  credential: InferenceCredentialPayload,
  promptCacheKey?: string
): Record<string, string> {
  if (definition.id !== 'xai' || !credential.accessToken) return {};
  const affinity = promptCacheKey ? createHash('sha256').update(promptCacheKey).digest('hex').slice(0, 32) : undefined;
  return {
    'x-grok-req-id': randomUUID(),
    ...(affinity ? { 'x-grok-conv-id': affinity, 'x-grok-session-id': affinity } : {}),
  };
}

function stableClaudeSessionId(token: string): string {
  const hash = createHash('sha256').update(`claude-code-session:${token}`).digest('hex');
  const variant = ((Number.parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function modelRows(value: unknown): unknown[] {
  const payload = asObject(value);
  if (!payload) return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.models)) return payload.models;
  return [];
}

function normalizeModel(value: unknown, definition: InferenceProviderDefinition): DiscoveredInferenceModel | null {
  const row = asObject(value);
  if (!row) return null;
  if (row.supported_in_api === false || row.visibility === 'hide') return null;
  const id =
    typeof row.id === 'string'
      ? row.id
      : typeof row.slug === 'string'
        ? row.slug
        : typeof row.name === 'string'
          ? row.name
          : null;
  if (!id) return null;
  const known = knownProviderModel(definition.id, id);
  const upstreamContextWindow = finiteInteger(
    row.context_window ??
      row.max_context_window ??
      row.contextWindow ??
      row.max_input_tokens ??
      row.input_token_limit ??
      row.context_length
  );
  const contextWindow = upstreamContextWindow ?? known?.contextWindow;
  const effectiveContextPercent =
    finiteInteger(row.effective_context_window_percent) ??
    (definition.id === 'openai' ? CODEX_EFFECTIVE_CONTEXT_PERCENT : undefined);
  const topProvider = asObject(row.top_provider);
  const genericMaxTokens = definition.family === 'kimi' ? undefined : row.max_tokens;
  const upstreamMaxOutputTokens = finiteInteger(
    row.max_output_tokens ??
      row.maxOutputTokens ??
      genericMaxTokens ??
      row.output_token_limit ??
      topProvider?.max_completion_tokens
  );
  const maxInputTokens =
    finiteInteger(row.max_input_tokens ?? row.maxInputTokens ?? row.input_token_limit) ??
    (upstreamContextWindow && effectiveContextPercent
      ? Math.floor((upstreamContextWindow * Math.min(effectiveContextPercent, 100)) / 100)
      : undefined) ??
    known?.maxInputTokens ??
    (upstreamContextWindow && upstreamMaxOutputTokens && upstreamContextWindow > upstreamMaxOutputTokens
      ? upstreamContextWindow - upstreamMaxOutputTokens
      : undefined);
  const maxOutputTokens = upstreamMaxOutputTokens ?? known?.maxOutputTokens;
  const configuredAutoCompactTokenLimit = finiteInteger(row.auto_compact_token_limit ?? row.autoCompactTokenLimit);
  const derivedAutoCompactTokenLimit =
    definition.id === 'openai' && contextWindow
      ? Math.floor((contextWindow * CODEX_AUTO_COMPACT_PERCENT) / 100)
      : undefined;
  const autoCompactTokenLimit = derivedAutoCompactTokenLimit
    ? Math.min(configuredAutoCompactTokenLimit ?? derivedAutoCompactTokenLimit, derivedAutoCompactTokenLimit)
    : (configuredAutoCompactTokenLimit ?? known?.autoCompactTokenLimit);
  const architecture = asObject(row.architecture);
  const modelCapabilities = asObject(row.capabilities);
  const imageInputCapability = asObject(modelCapabilities?.image_input);
  const thinkingCapability = asObject(modelCapabilities?.thinking);
  const reportedModalities = arrayOfStrings(row.input_modalities ?? architecture?.input_modalities);
  const modalities = reportedModalities.length
    ? reportedModalities
    : (known?.modalities ?? [
        'text',
        ...(row.supports_image_in === true || imageInputCapability?.supported === true ? ['image'] : []),
        ...(row.supports_video_in === true ? ['video'] : []),
      ]);
  const thinkEfforts = asObject(row.think_efforts);
  const upstreamReasoningEfforts = reasoningLevels(
    row.reasoning_efforts ??
      row.supported_reasoning_levels ??
      row.supported_reasoning_efforts ??
      thinkEfforts?.valid_efforts
  );
  const reasoningEfforts = upstreamReasoningEfforts.length ? upstreamReasoningEfforts : (known?.reasoningEfforts ?? []);
  const supportedParameters = arrayOfStrings(row.supported_parameters);
  const upstreamReportsReasoning =
    row.reasoning !== undefined ||
    row.supports_reasoning !== undefined ||
    thinkEfforts?.support !== undefined ||
    thinkingCapability?.supported !== undefined ||
    supportedParameters.includes('reasoning');
  const pricing = providerPricing(definition.id, row) ?? known?.pricing;
  const metadata = {
    ...row,
    ...(known
      ? {
          gatewayCatalog: {
            providerId: definition.id,
            version: known.catalogVersion,
            sourceUrl: known.sourceUrl,
          },
        }
      : {}),
    ...(pricing ? { gatewayPricing: pricing } : {}),
  };
  return {
    id,
    ...(typeof row.display_name === 'string'
      ? { displayName: row.display_name }
      : typeof row.displayName === 'string'
        ? { displayName: row.displayName }
        : typeof row.name === 'string'
          ? { displayName: row.name }
          : known
            ? { displayName: known.displayName }
            : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxInputTokens ? { maxInputTokens } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(autoCompactTokenLimit ? { autoCompactTokenLimit } : {}),
    modalities,
    capabilities: {
      reasoning:
        upstreamReasoningEfforts.length > 0 ||
        row.reasoning === true ||
        row.supports_reasoning === true ||
        thinkEfforts?.support === true ||
        thinkingCapability?.supported === true ||
        supportedParameters.includes('reasoning') ||
        (!upstreamReportsReasoning && known?.capabilities.reasoning === true),
      tools:
        row.tools === true ||
        supportedParameters.includes('tools') ||
        (row.tools === undefined && known?.capabilities.tools !== false),
      vision: modalities.includes('image'),
    },
    reasoningEfforts,
    ...(pricing ? { pricing } : {}),
    metadata,
  };
}

function providerPricing(providerId: string, row: JsonObject) {
  if (providerId === 'xai-apikey') {
    const input = xaiTokenPrice(row.prompt_text_token_price);
    const output = xaiTokenPrice(row.completion_text_token_price);
    if (input === undefined || output === undefined) return undefined;
    const normalized = {
      inputMicrodollarsPerMillion: input,
      cachedInputMicrodollarsPerMillion: xaiTokenPrice(row.cached_prompt_text_token_price),
      outputMicrodollarsPerMillion: output,
      source: 'provider' as const,
    };
    return {
      ...normalized,
      version: `xai-models-${createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 12)}`,
    };
  }
  if (providerId !== 'openrouter') return undefined;
  const pricing = asObject(row.pricing);
  if (!pricing) return undefined;
  const input = perTokenPrice(pricing.prompt);
  const output = perTokenPrice(pricing.completion);
  if (input === undefined || output === undefined) return undefined;
  const normalized = {
    inputMicrodollarsPerMillion: input,
    cachedInputMicrodollarsPerMillion: perTokenPrice(pricing.input_cache_read),
    cacheWriteMicrodollarsPerMillion: perTokenPrice(pricing.input_cache_write),
    outputMicrodollarsPerMillion: output,
    reasoningMicrodollarsPerMillion: perTokenPrice(pricing.internal_reasoning),
    otherUnitPrices: {
      ...(perUnitPrice(pricing.image) !== undefined ? { image_input: perUnitPrice(pricing.image)! } : {}),
      ...(perUnitPrice(pricing.web_search) !== undefined
        ? { web_search_query: perUnitPrice(pricing.web_search)! }
        : {}),
      ...(perUnitPrice(pricing.request) !== undefined ? { request: perUnitPrice(pricing.request)! } : {}),
    },
    source: 'provider' as const,
  };
  return {
    ...normalized,
    version: `openrouter-models-${createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 12)}`,
  };
}

function xaiTokenPrice(value: unknown): number | undefined {
  const centsPerHundredMillion = numberValue(value);
  if (centsPerHundredMillion === undefined || centsPerHundredMillion < 0) return undefined;
  const microdollarsPerMillion = Math.round(centsPerHundredMillion * 100);
  return Number.isSafeInteger(microdollarsPerMillion) ? microdollarsPerMillion : undefined;
}

function reasoningLevels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return [item];
    const effort = asObject(item)?.effort;
    return typeof effort === 'string' ? [effort] : [];
  });
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function perTokenPrice(value: unknown): number | undefined {
  const price = numberValue(value);
  if (price === undefined || price < 0) return undefined;
  const microdollarsPerMillion = Math.round(price * 1_000_000_000_000);
  return Number.isSafeInteger(microdollarsPerMillion) ? microdollarsPerMillion : undefined;
}

function perUnitPrice(value: unknown): number | undefined {
  const price = numberValue(value);
  if (price === undefined || price < 0) return undefined;
  const microdollars = Math.round(price * 1_000_000);
  return Number.isSafeInteger(microdollars) ? microdollars : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : undefined;
}

function numberValue(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

function resetDate(value: unknown): Date | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  const numeric = numberValue(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  return new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric);
}

function remainingFractionFromPercent(value: unknown): number | undefined {
  const percent = numberValue(value);
  if (percent === undefined) return undefined;
  return Math.max(0, Math.min(1, 1 - percent / 100));
}

function parseWhamQuota(payload: JsonObject): InferenceQuotaWindow[] {
  const rateLimit = asObject(payload.rate_limit);
  if (!rateLimit) return [];
  const resetCredits = numberValue(asObject(payload.rate_limit_reset_credits)?.available_count);
  const rows: InferenceQuotaWindow[] = [];
  for (const [fallback, value] of [
    ['primary', rateLimit.primary_window],
    ['secondary', rateLimit.secondary_window],
    ['tertiary', rateLimit.tertiary_window],
  ] as const) {
    const window = asObject(value);
    if (!window) continue;
    const seconds = numberValue(window.limit_window_seconds);
    const dimension =
      seconds === 18_000 ? '5h' : seconds === 604_800 ? '7d' : seconds && seconds >= 2_419_200 ? '30d' : fallback;
    rows.push({
      dimension,
      remainingFraction: remainingFractionFromPercent(window.used_percent),
      resetAt: resetDate(window.reset_at),
      metadata: {
        limitWindowSeconds: seconds,
        ...(resetCredits !== undefined ? { resetCreditsAvailable: resetCredits } : {}),
      },
    });
  }
  return rows;
}

function parseAnthropicQuota(payload: JsonObject): InferenceQuotaWindow[] {
  const buckets = [
    ['5h', payload.five_hour],
    ['7d', payload.seven_day],
    ['7d:opus', payload.seven_day_opus],
    ['7d:sonnet', payload.seven_day_sonnet],
  ] as const;
  return buckets.flatMap(([dimension, value]) => {
    const bucket = asObject(value);
    if (!bucket) return [];
    return [
      {
        dimension,
        ...(dimension.includes(':') ? { modelBucket: dimension.split(':')[1] } : {}),
        remainingFraction: remainingFractionFromPercent(bucket.utilization),
        resetAt: resetDate(bucket.resets_at),
      },
    ];
  });
}

function parseXaiQuota(payload: JsonObject): InferenceQuotaWindow[] {
  const config = asObject(payload.config);
  const limit = numberValue(asObject(config?.monthlyLimit)?.val ?? config?.monthlyLimit);
  const used = numberValue(asObject(config?.used)?.val ?? config?.used);
  if (limit === undefined || used === undefined || limit <= 0) return [];
  return [
    {
      dimension: '30d',
      remainingFraction: Math.max(0, Math.min(1, 1 - used / limit)),
      remainingValue: String(Math.max(0, limit - used)),
      limitValue: String(limit),
      resetAt: resetDate(config?.billingPeriodEnd),
      metadata: { unit: 'cents' },
    },
  ];
}

function parseKimiQuota(value: JsonObject): InferenceQuotaWindow[] {
  const nested = asObject(value.data);
  const hasQuota = (payload: JsonObject) =>
    payload.usage != null || payload.limits != null || payload.totalQuota != null;
  const payload = nested && !hasQuota(value) && hasQuota(nested) ? nested : value;
  let fiveHour: Omit<InferenceQuotaWindow, 'dimension'> | null = null;
  let weekly = kimiQuotaRow(payload.usage);
  const total = kimiQuotaRow(payload.totalQuota);
  const candidates = Array.isArray(payload.limits) ? payload.limits : [];
  for (const candidate of candidates) {
    const row = asObject(candidate);
    const detail = asObject(row?.detail) ?? row;
    if (!row || !detail) continue;
    const window = asObject(row.window) ?? {};
    if (!fiveHour && isKimiFiveHourLimit(row, detail, window)) {
      fiveHour = kimiQuotaRow(detail, window);
    }
    if (!weekly && isKimiWeeklyLimit(row, detail, window)) {
      weekly = kimiQuotaRow(detail, window);
    }
    if (fiveHour && weekly) break;
  }
  return [
    ...(fiveHour ? [{ dimension: '5h', ...fiveHour }] : []),
    ...(weekly ? [{ dimension: '7d', ...weekly }] : []),
    ...(total ? [{ dimension: 'subscription', ...total }] : []),
  ];
}

function kimiQuotaRow(value: unknown, resetFallback?: JsonObject): Omit<InferenceQuotaWindow, 'dimension'> | null {
  const row = asObject(value);
  if (!row) return null;
  const limit = numberValue(row.limit);
  const used = numberValue(row.used);
  const remaining = numberValue(row.remaining);
  const remainingFraction =
    limit && limit > 0
      ? Math.max(0, Math.min(1, remaining !== undefined ? remaining / limit : 1 - (used ?? 0) / limit))
      : remainingFractionFromPercent(row.utilization ?? row.percent ?? row.usedPercent ?? row.used_percent);
  if (remainingFraction === undefined) return null;
  return {
    remainingFraction,
    ...(remaining !== undefined ? { remainingValue: String(remaining) } : {}),
    ...(limit !== undefined ? { limitValue: String(limit) } : {}),
    resetAt:
      resetDate(row.resetTime ?? row.resetAt ?? row.resetsAt ?? row.reset_at) ??
      resetDate(
        resetFallback?.resetTime ?? resetFallback?.resetAt ?? resetFallback?.resetsAt ?? resetFallback?.reset_at
      ),
  };
}

function kimiQuotaLabel(item: JsonObject, detail: JsonObject): string {
  return [item.name, item.title, item.scope, detail.name, detail.title]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

function isKimiFiveHourLimit(item: JsonObject, detail: JsonObject, window: JsonObject): boolean {
  const duration = numberValue(window.duration ?? item.duration ?? detail.duration);
  const unit = String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? '').toUpperCase();
  if ((unit.includes('MINUTE') && duration === 300) || (unit.includes('HOUR') && duration === 5)) return true;
  return /(^|\b)5\s*(?:h|hour)/.test(kimiQuotaLabel(item, detail));
}

function isKimiWeeklyLimit(item: JsonObject, detail: JsonObject, window: JsonObject): boolean {
  const duration = numberValue(window.duration ?? item.duration ?? detail.duration);
  const unit = String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? '').toUpperCase();
  if ((unit.includes('DAY') && duration === 7) || (unit.includes('HOUR') && duration === 168)) return true;
  return /weekly|7\s*(?:d|day)/.test(kimiQuotaLabel(item, detail));
}
