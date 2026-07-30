import { hostname } from 'node:os';
import { type Fetch, requestJson } from './http.js';
import type { CreatedManagedToken, InferenceHarness, ManagedToken, SetupIdentity } from './types.js';

export class InferenceSetupClient {
  constructor(
    private readonly origin: string,
    private readonly accessToken: string,
    private readonly fetcher?: Fetch
  ) {}

  me(): Promise<SetupIdentity> {
    return requestJson(new URL('/api/inference/setup/me', this.origin).href, {}, this.options());
  }

  async listTokens(): Promise<ManagedToken[]> {
    const response = await requestJson<{ data: ManagedToken[] }>(
      new URL('/api/inference/setup/tokens', this.origin).href,
      {},
      this.options()
    );
    return response.data;
  }

  createToken(input: {
    harness?: InferenceHarness;
    installationId: string;
    deviceName?: string;
    replaceExisting?: boolean;
  }): Promise<CreatedManagedToken> {
    return requestJson(
      new URL('/api/inference/setup/tokens', this.origin).href,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          harness: input.harness ?? 'codex',
          deviceName: input.deviceName?.trim() || hostname(),
          installationId: input.installationId,
          ...(input.replaceExisting ? { replaceExisting: true } : {}),
        }),
      },
      this.options()
    );
  }

  revokeToken(id: string): Promise<void> {
    return requestJson(
      new URL(`/api/inference/setup/tokens/${encodeURIComponent(id)}`, this.origin).href,
      { method: 'DELETE' },
      this.options()
    );
  }

  private options() {
    return { fetch: this.fetcher, accessToken: this.accessToken };
  }
}
