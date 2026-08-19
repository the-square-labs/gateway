export interface InferenceAdapters {
  openai: { baseUrl: string };
  anthropic: { baseUrl: string };
}

export type InferenceHarness = 'codex' | 'claude-code';

export interface InferenceDiscovery {
  /** Schema served by the Gateway; consumers use the normalized adapters below. */
  schemaVersion: 1 | 2;
  enabled?: boolean;
  minimumCliVersion: string;
  oauth: {
    resource: string;
    authorizationServer: string;
  };
  adapters: InferenceAdapters;
}

export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  scopes_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
}

export interface OAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType: 'Bearer';
  scope: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
  scope?: string;
}

export interface SetupIdentity {
  user: { id: string; name: string | null; email: string; role: string };
  inference: { enabled: true; allowed: true };
  adapters: InferenceAdapters;
  catalogVersion: string;
}

export interface ManagedToken {
  id: string;
  name: string;
  prefix: string;
  harness: string;
  deviceName: string;
  installationId: string;
  createdAt: string;
  lastUsedAt?: string | null;
}

export interface CreatedManagedToken extends Omit<ManagedToken, 'lastUsedAt'> {
  token: string;
}

export interface RuntimeCredential {
  token: string;
  tokenId: string;
  prefix: string;
  harness: InferenceHarness;
  installationId: string;
}

export interface GatewayApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}
