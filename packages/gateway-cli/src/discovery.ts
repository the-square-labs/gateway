import { CliError } from './errors.js';
import { assertTrustedEndpoint, type Fetch, requestJson } from './http.js';
import type { InferenceDiscovery, OAuthMetadata } from './types.js';

export const CLI_VERSION = '0.1.5';

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export async function discoverInference(
  origin: string,
  fetcher?: Fetch,
  requireEnabled = true
): Promise<InferenceDiscovery> {
  const discovery = await requestJson<InferenceDiscovery>(
    new URL('/.well-known/wiolett-inference', origin).href,
    {},
    { fetch: fetcher }
  );
  if (discovery.schemaVersion !== 1 || !discovery.oauth?.resource || !discovery.oauth.authorizationServer) {
    throw new CliError('INCOMPATIBLE_GATEWAY', 'Gateway inference discovery uses an unsupported schema.');
  }
  const expectedOrigin = new URL(origin).origin;
  if (
    new URL(discovery.oauth.resource).origin !== expectedOrigin ||
    new URL(discovery.oauth.authorizationServer).origin !== expectedOrigin
  ) {
    throw new CliError('UNTRUSTED_OAUTH_ENDPOINT', 'Gateway discovery advertised OAuth URLs on another origin.');
  }
  if (requireEnabled && !discovery.enabled)
    throw new CliError('INFERENCE_DISABLED', 'Inference is disabled on this Gateway.');
  if (requireEnabled && discovery.harnessSpecificEndpointsEnabled === false) {
    throw new CliError(
      'HARNESS_ENDPOINTS_DISABLED',
      'Harness-specific inference endpoints are disabled on this Gateway. Ask an administrator to enable them in Settings > Inference.'
    );
  }
  if (compareVersions(CLI_VERSION, discovery.minimumCliVersion) < 0) {
    throw new CliError(
      'CLI_UPDATE_REQUIRED',
      `Gateway requires @wiolett/gateway-inference ${discovery.minimumCliVersion} or newer (current ${CLI_VERSION}).`
    );
  }
  return discovery;
}

export async function fetchSetupOAuthMetadata(discovery: InferenceDiscovery, fetcher?: Fetch): Promise<OAuthMetadata> {
  const issuer = new URL(discovery.oauth.authorizationServer);
  const path = '/.well-known/oauth-authorization-server/api/inference/setup';
  const metadata = await requestJson<OAuthMetadata>(new URL(path, issuer).href, {}, { fetch: fetcher });
  if (
    new URL(metadata.issuer).href !== new URL(discovery.oauth.authorizationServer).href ||
    !metadata.authorization_endpoint ||
    !metadata.token_endpoint ||
    !metadata.registration_endpoint ||
    !metadata.revocation_endpoint ||
    !metadata.code_challenge_methods_supported?.includes('S256') ||
    !metadata.grant_types_supported?.includes('authorization_code') ||
    !metadata.grant_types_supported?.includes('refresh_token') ||
    !metadata.scopes_supported?.includes('inference:setup')
  ) {
    throw new CliError(
      'INCOMPATIBLE_OAUTH_SERVER',
      'Gateway does not advertise the required inference setup OAuth contract.'
    );
  }
  assertTrustedEndpoint(metadata.authorization_endpoint, discovery.oauth.authorizationServer, 'authorization endpoint');
  assertTrustedEndpoint(metadata.token_endpoint, discovery.oauth.authorizationServer, 'token endpoint');
  assertTrustedEndpoint(metadata.registration_endpoint, discovery.oauth.authorizationServer, 'registration endpoint');
  assertTrustedEndpoint(metadata.revocation_endpoint, discovery.oauth.authorizationServer, 'revocation endpoint');
  return metadata;
}
