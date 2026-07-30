import type { CredentialStore } from './credentials.js';
import { discoverInference, fetchSetupOAuthMetadata } from './discovery.js';
import { CliError } from './errors.js';
import { withFileLock } from './file-lock.js';
import type { Fetch } from './http.js';
import { loginWithBrowser, revokeCredential } from './oauth.js';
import type { Output } from './output.js';
import { normalizeGatewayOrigin, type ProfileStore } from './profiles.js';
import { InferenceSetupClient } from './tokens.js';

export async function loginCommand(
  args: { gateway?: string; command: string[] },
  profileName: string,
  profiles: ProfileStore,
  credentials: CredentialStore,
  output: Output,
  fetcher?: Fetch,
  browser?: (url: string) => Promise<void>
): Promise<void> {
  const existing = await profiles.get(profileName);
  const originInput = args.gateway ?? args.command[1] ?? existing?.origin;
  if (!originInput) {
    throw new CliError('GATEWAY_REQUIRED', 'Provide a Gateway origin: login https://gateway.example.com');
  }
  const origin = normalizeGatewayOrigin(originInput);
  const discovery = await discoverInference(origin, fetcher);
  const metadata = await fetchSetupOAuthMetadata(discovery, fetcher);
  const result = await loginWithBrowser({
    profile: profileName,
    discovery,
    metadata,
    credentials,
    fetch: fetcher,
    openBrowser: browser,
    persistCredential: false,
  });
  const client = new InferenceSetupClient(origin, result.credential.accessToken, fetcher);
  const identity = await client.me();
  const profile = await withFileLock(
    profiles.credentialLockFile(profileName),
    async () => {
      await credentials.set(profileName, result.credential);
      return profiles.upsert(profileName, origin, { clientId: result.clientId });
    },
    'AUTHORIZATION_LOCKED'
  );
  output.write(
    { ok: true, gateway: profile.origin, user: identity.user, inference: identity.inference },
    () => `Logged in to ${profile.origin} as ${identity.user.email}.`
  );
}

export async function logoutCommand(
  profileName: string,
  profiles: ProfileStore,
  credentials: CredentialStore,
  output: Output,
  fetcher?: Fetch
): Promise<void> {
  const profile = await profiles.get(profileName);
  let revocationEndpoint: string | undefined;
  if (profile) {
    try {
      const discovery = await discoverInference(profile.origin, fetcher, false);
      revocationEndpoint = (await fetchSetupOAuthMetadata(discovery, fetcher)).revocation_endpoint;
    } catch {
      // Local logout remains available when Gateway is offline or inference is disabled.
    }
  }
  const result = await revokeCredential({
    profile: profileName,
    clientId: profile?.clientId,
    revocationEndpoint,
    credentials,
    fetch: fetcher,
    lockFile: profiles.credentialLockFile(profileName),
  });
  await profiles.removeClient(profileName);
  output.write({ ok: true, remoteRevoked: result.remoteRevoked }, () =>
    result.remoteRevoked ? 'Logged out.' : 'Removed local authorization; remote revocation could not be confirmed.'
  );
}
