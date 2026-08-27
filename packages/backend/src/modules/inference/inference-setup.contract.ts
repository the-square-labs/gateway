import type { OAuthService } from '@/modules/oauth/oauth.service.js';

export const INFERENCE_SETUP_SCHEMA_VERSION = 2;
export const INFERENCE_SETUP_MINIMUM_CLI_VERSION = '0.3.0';

/**
 * Public discovery document for the @sqgateway/inference CLI. Schema v2
 * (plan T5): one stable data-plane prefix /api/inference/v1 for every client;
 * harness-specific bases, per-harness catalogs, and the harness toggle are
 * removed. The Anthropic SDK appends its own /v1 segment, so its base stops
 * one level higher.
 */
export function inferenceAdapterDiscovery(oauth: OAuthService) {
  const baseUrl = oauth.getIssuerUrl();
  return {
    schemaVersion: INFERENCE_SETUP_SCHEMA_VERSION,
    minimumCliVersion: INFERENCE_SETUP_MINIMUM_CLI_VERSION,
    oauth: {
      resource: oauth.getInferenceSetupResourceUrl(),
      authorizationServer: oauth.getIssuerUrl(),
    },
    adapters: {
      openai: { baseUrl: new URL('/api/inference/v1', baseUrl).href },
      anthropic: { baseUrl: new URL('/api/inference', baseUrl).href },
    },
  };
}
