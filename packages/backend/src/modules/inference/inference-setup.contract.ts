import { getEnv } from '@/config/env.js';
import type { OAuthService } from '@/modules/oauth/oauth.service.js';

export const INFERENCE_SETUP_SCHEMA_VERSION = 1;
export const INFERENCE_SETUP_MINIMUM_CLI_VERSION = '0.1.0';

export function inferenceAdapterDiscovery(oauth: OAuthService) {
  const baseUrl = getEnv().APP_URL;
  return {
    schemaVersion: INFERENCE_SETUP_SCHEMA_VERSION,
    minimumCliVersion: INFERENCE_SETUP_MINIMUM_CLI_VERSION,
    oauth: {
      resource: oauth.getInferenceSetupResourceUrl(),
      authorizationServer: oauth.getIssuerUrl(),
    },
    adapters: {
      openai: { baseUrl: new URL('/api/inference/openai/v1', baseUrl).href },
      codex: {
        baseUrl: new URL('/api/inference/codex/v1', baseUrl).href,
        catalogUrl: new URL('/api/inference/codex/v1/models', baseUrl).href,
      },
      // Anthropic SDK resources include their own leading /v1 segment.
      anthropic: { baseUrl: new URL('/api/inference/anthropic', baseUrl).href },
    },
    harnesses: { codex: { supported: true as const } },
  };
}
