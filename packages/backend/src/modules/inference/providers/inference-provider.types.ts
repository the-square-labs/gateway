import type { InferenceRequest, InferenceStreamEvent } from '../protocol/inference-protocol.types.js';

export type InferenceWireProtocol = 'openai-responses' | 'openai-chat' | 'anthropic-messages' | 'google-gemini';
export type InferenceProviderFamily = 'openai' | 'anthropic' | 'kimi' | 'google' | 'custom';

export interface InferenceOAuthRedirectConfig {
  flow: 'redirect';
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  redirectUri: string;
  tokenEncoding: 'json' | 'form';
  clientSecret?: string;
  extraAuthorizeParams?: Record<string, string>;
}

export interface InferenceOAuthDeviceConfig {
  flow: 'device';
  clientId: string;
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  scopes?: string;
  deviceHeaders?: Record<string, string>;
  credentialExchange?: 'github-copilot';
}

export interface InferenceOAuthCodexDeviceConfig {
  flow: 'codex_device';
  clientId: string;
  userCodeUrl: string;
  deviceTokenUrl: string;
  verificationUrl: string;
  tokenUrl: string;
  redirectUri: string;
}

export interface InferenceProviderDefinition {
  id: string;
  label: string;
  family: InferenceProviderFamily;
  wireProtocol: InferenceWireProtocol;
  baseUrl: string;
  authTypes: Array<'oauth' | 'api_key' | 'local'>;
  subscription: boolean;
  featured: boolean;
  modelsPath?: string;
  /** Force the managed core to use the provider's live model catalog. */
  liveModels?: boolean;
  quotaKind?: 'chatgpt-wham' | 'anthropic-oauth' | 'kimi-usage' | 'xai-billing';
  staticModels?: string[];
  keyOptional?: boolean;
  authHeader?: 'bearer' | 'x-api-key' | 'api-key' | 'x-goog-api-key';
  staticHeaders?: Record<string, string>;
  allowBaseUrlOverride?: boolean;
  privateNetworkByDefault?: boolean;
  supportedOperations?: Array<'inference' | 'images' | 'search' | 'realtime'>;
  termsVersion?: string;
  oauth?: InferenceOAuthRedirectConfig | InferenceOAuthDeviceConfig | InferenceOAuthCodexDeviceConfig;
}

export interface InferenceCredentialPayload {
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  email?: string;
  tokenType?: string;
  projectId?: string;
  deviceId?: string;
}

export interface DiscoveredInferenceModel {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  autoCompactTokenLimit?: number;
  modalities: string[];
  capabilities: Record<string, boolean>;
  reasoningEfforts: string[];
  pricing?: InferenceProviderModelPricing;
  metadata: Record<string, unknown>;
}

export interface InferenceProviderModelPricing {
  version: string;
  inputMicrodollarsPerMillion: number;
  cachedInputMicrodollarsPerMillion?: number | null;
  cacheWriteMicrodollarsPerMillion?: number | null;
  outputMicrodollarsPerMillion: number;
  reasoningMicrodollarsPerMillion?: number | null;
  otherUnitPrices?: Record<string, number>;
  source: 'provider';
}

export interface InferenceQuotaWindow {
  dimension: string;
  modelBucket?: string;
  remainingFraction?: number;
  remainingValue?: string;
  limitValue?: string;
  resetAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface ProviderRequestResult {
  responseId: string;
  events: AsyncIterable<InferenceStreamEvent>;
  resolvedModel: string;
}

export interface InferenceProviderConnector {
  discoverModels(
    definition: InferenceProviderDefinition,
    credential: InferenceCredentialPayload,
    baseUrl: string,
    signal?: AbortSignal,
    allowPrivateNetwork?: boolean
  ): Promise<DiscoveredInferenceModel[]>;
  fetchQuota(
    definition: InferenceProviderDefinition,
    credential: InferenceCredentialPayload,
    signal?: AbortSignal
  ): Promise<InferenceQuotaWindow[]>;
  execute?(
    definition: InferenceProviderDefinition,
    credential: InferenceCredentialPayload,
    baseUrl: string,
    upstreamModel: string,
    request: InferenceRequest,
    signal: AbortSignal,
    allowPrivateNetwork?: boolean
  ): Promise<ProviderRequestResult>;
}
