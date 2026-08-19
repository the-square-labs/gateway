import { createChildLogger } from '@/lib/logger.js';
import { type InferenceCoreHealthIdentity, inferenceCoreHealthIdentitySchema } from './inference-core.contract.js';

const logger = createChildLogger('InferenceCoreClient');

const REQUEST_TIMEOUT_MS = 5_000;

/** Provider row as the core's management API reports it (no secrets). */
export interface CoreProviderRow {
  name: string;
  adapter: string;
  baseUrl: string;
  defaultModel?: string;
  hasApiKey: boolean;
  models: string[];
  authMode?: string;
  disabled?: boolean;
  codexAccountMode?: string;
  discovery?: unknown;
}

export class InferenceCoreClientError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'InferenceCoreClientError';
  }
}

/**
 * Private client for the managed core container. Talks to the container's
 * network alias on the installer-managed Compose network only; the core never
 * publishes a host port. The management credential authenticates every call.
 */
export class InferenceCoreClient {
  constructor(
    private readonly baseUrl: string,
    private readonly managementCredential: string
  ) {}

  /** Liveness + contract identity. Returns null when the core is unreachable. */
  async health(): Promise<InferenceCoreHealthIdentity | null> {
    return this.getIdentity('/healthz');
  }

  /**
   * Readiness + contract identity. Readiness is stricter than liveness: the
   * core reports `ready` only after its startup sync settled.
   */
  async ready(): Promise<{
    ready: boolean;
    status: 'ready' | 'pending' | 'failed' | null;
    identity: InferenceCoreHealthIdentity | null;
  }> {
    const response = await this.request('GET', '/readyz');
    if (!response) return { ready: false, status: null, identity: null };
    const identity = this.parseIdentity(response.body);
    const rawStatus = (response.body as { status?: unknown }).status;
    const status = rawStatus === 'ready' || rawStatus === 'pending' || rawStatus === 'failed' ? rawStatus : null;
    return { ready: response.status === 200 && status === 'ready', status, identity };
  }

  /** Wiolett-only extended status (drain state + identity). */
  async wiolettStatus(): Promise<{ draining: boolean } | null> {
    const response = await this.request('GET', '/api/wiolett/status');
    if (!response || response.status !== 200) return null;
    return { draining: (response.body as { draining?: unknown }).draining === true };
  }

  // ----------------------------------------------------- management surface

  /** Config-backed provider rows as the core reports them (never includes secrets). */
  async listCoreProviders(): Promise<CoreProviderRow[] | null> {
    const response = await this.request('GET', '/api/providers');
    if (!response || response.status !== 200 || !Array.isArray(response.body)) return null;
    return response.body as CoreProviderRow[];
  }

  async createCoreProvider(name: string, provider: Record<string, unknown>): Promise<void> {
    const response = await this.request('POST', '/api/providers', { name, provider });
    this.assertOk(response, 'create provider');
  }

  async patchCoreProvider(name: string, patch: Record<string, unknown>): Promise<void> {
    const response = await this.request('PATCH', `/api/providers?name=${encodeURIComponent(name)}`, patch);
    this.assertOk(response, 'update provider');
  }

  async deleteCoreProvider(name: string): Promise<void> {
    const response = await this.request('DELETE', `/api/providers?name=${encodeURIComponent(name)}`);
    this.assertOk(response, 'delete provider');
  }

  /** Model rows known to the core (all providers, management view). */
  async listCoreModels(): Promise<unknown[] | null> {
    const response = await this.request('GET', '/api/models');
    if (!response || response.status !== 200 || !Array.isArray(response.body)) return null;
    return response.body as unknown[];
  }

  /** Exact model ids returned by one provider's live upstream discovery. */
  async coreProviderLiveModelIds(name: string): Promise<string[] | null> {
    const response = await this.request('POST', `/api/providers/test?name=${encodeURIComponent(name)}`);
    if (!response || response.status !== 200 || !response.body || typeof response.body !== 'object') return null;
    const body = response.body as { ok?: unknown; modelIds?: unknown };
    if (body.ok !== true || !Array.isArray(body.modelIds)) return null;
    return body.modelIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  }

  /** Quota reports per provider/account as the core measures them. */
  async coreProviderQuotas(): Promise<unknown | null> {
    const response = await this.request('GET', '/api/provider-quotas');
    return response && response.status === 200 ? response.body : null;
  }

  /** Providers that support an OAuth login flow on this core. */
  async listCoreOauthProviders(): Promise<string[]> {
    const response = await this.request('GET', '/api/oauth/providers');
    if (!response || response.status !== 200 || !Array.isArray(response.body)) return [];
    return (response.body as unknown[]).filter((entry): entry is string => typeof entry === 'string');
  }

  async coreOauthLoginStart(
    provider: string,
    options: { addAccount?: boolean; accountId?: string; reauth?: boolean } = {}
  ): Promise<{ url: string | null; instructions: string | null; deviceCode: unknown | null }> {
    const response = await this.request('POST', '/api/oauth/login', { provider, ...options });
    this.assertOk(response, 'start OAuth login');
    const body = response.body as { url?: unknown; instructions?: unknown; deviceCode?: unknown };
    return {
      url: typeof body.url === 'string' ? body.url : null,
      instructions: typeof body.instructions === 'string' ? body.instructions : null,
      deviceCode: body.deviceCode ?? null,
    };
  }

  async coreOauthLoginStatus(provider: string): Promise<unknown | null> {
    const response = await this.request('GET', `/api/oauth/status?provider=${encodeURIComponent(provider)}`);
    return response && response.status === 200 ? response.body : null;
  }

  async coreOauthLoginCode(provider: string, input: string): Promise<void> {
    const response = await this.request('POST', '/api/oauth/login/code', { provider, input });
    this.assertOk(response, 'complete OAuth login');
  }

  async coreOauthLoginCancel(provider: string): Promise<void> {
    const response = await this.request('POST', '/api/oauth/login/cancel', { provider });
    this.assertOk(response, 'cancel OAuth login');
  }

  /**
   * OAuth account set for one provider as the core stores it. Emails arrive
   * masked upstream; account ids are the stable reference.
   */
  async listCoreOauthAccounts(
    provider: string
  ): Promise<{ activeAccountId: string | null; accounts: Array<Record<string, unknown>> } | null> {
    const response = await this.request('GET', `/api/oauth/accounts?provider=${encodeURIComponent(provider)}`);
    if (!response || response.status !== 200 || !response.body || typeof response.body !== 'object') return null;
    const body = response.body as { activeAccountId?: unknown; accounts?: unknown };
    return {
      activeAccountId: typeof body.activeAccountId === 'string' ? body.activeAccountId : null,
      accounts: Array.isArray(body.accounts)
        ? body.accounts.filter((account): account is Record<string, unknown> => Boolean(account) && typeof account === 'object')
        : [],
    };
  }

  /** Remove one account from a core OAuth provider account set. */
  async deleteCoreOauthAccount(provider: string, accountId: string): Promise<void> {
    const response = await this.request(
      'DELETE',
      `/api/oauth/accounts?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(accountId)}`
    );
    this.assertOk(response, 'remove OAuth account');
  }

  /**
   * Per-provider account-pool rotation strategy. The core implements generic
   * OAuth account pools only for anthropic today; other providers keep their
   * active-account semantics and skip this call.
   */
  async setCoreOauthPoolStrategy(provider: string, strategy: 'balanced' | 'even' | 'sequential'): Promise<void> {
    const response = await this.request('PUT', '/api/oauth/accounts/pool', {
      provider,
      strategy,
      enabled: true,
    });
    this.assertOk(response, 'set account pool strategy');
  }

  // ---------------------------------------------------- codex (ChatGPT) pool
  // ChatGPT accounts live in the core's codex account pool, managed through
  // /api/codex-auth/* rather than the generic /api/oauth/* surface.

  async coreCodexLoginStart(
    options: { accountId?: string; reauth?: boolean; flow?: 'browser' | 'device' } = {}
  ): Promise<{ flowId: string; url: string | null; instructions: string | null; deviceCode: string | null }> {
    const response = await this.request('POST', '/api/codex-auth/login', {
      ...(options.accountId ? { id: options.accountId } : {}),
      ...(options.reauth ? { reauth: true } : {}),
      ...(options.flow ? { flow: options.flow } : {}),
    });
    this.assertOk(response, 'start ChatGPT login');
    const body = response.body as { flowId?: unknown; url?: unknown; instructions?: unknown; deviceCode?: unknown };
    if (typeof body.flowId !== 'string' || !body.flowId) {
      throw new InferenceCoreClientError('Core ChatGPT login did not return a flow id');
    }
    return {
      flowId: body.flowId,
      url: typeof body.url === 'string' ? body.url : null,
      instructions: typeof body.instructions === 'string' ? body.instructions : null,
      deviceCode: typeof body.deviceCode === 'string' ? body.deviceCode : null,
    };
  }

  async coreCodexLoginStatus(
    flowId: string
  ): Promise<{ status: string; accountId?: string; email?: string; error?: string } | null> {
    const response = await this.request('GET', `/api/codex-auth/login-status?flowId=${encodeURIComponent(flowId)}`);
    if (!response || response.status !== 200) return null;
    const body = response.body as { status?: unknown; accountId?: unknown; email?: unknown; error?: unknown };
    if (typeof body.status !== 'string') return null;
    return {
      status: body.status,
      ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
      ...(typeof body.email === 'string' ? { email: body.email } : {}),
      ...(typeof body.error === 'string' ? { error: body.error } : {}),
    };
  }

  async coreCodexLoginCode(flowId: string, input: string): Promise<void> {
    const response = await this.request('POST', '/api/codex-auth/login/code', { flowId, input });
    this.assertOk(response, 'complete ChatGPT login');
  }

  async coreCodexLoginCancel(flowId?: string): Promise<void> {
    const response = await this.request('POST', '/api/codex-auth/login/cancel', flowId ? { flowId } : {});
    this.assertOk(response, 'cancel ChatGPT login');
  }

  /** ChatGPT pool accounts as the core reports them (emails are masked upstream). */
  async listCoreCodexAccounts(): Promise<unknown[] | null> {
    const response = await this.request('GET', '/api/codex-auth/accounts');
    if (!response || response.status !== 200) return null;
    const accounts = (response.body as { accounts?: unknown }).accounts;
    return Array.isArray(accounts) ? accounts : null;
  }

  async deleteCoreCodexAccount(accountId: string): Promise<void> {
    const response = await this.request('DELETE', `/api/codex-auth/accounts?id=${encodeURIComponent(accountId)}`);
    this.assertOk(response, 'remove ChatGPT account');
  }

  async setCoreCodexAccountPaused(accountId: string, paused: boolean): Promise<void> {
    const response = await this.request('PUT', '/api/codex-auth/accounts/pause', { id: accountId, paused });
    this.assertOk(response, 'pause ChatGPT account');
  }

  async setCoreCodexAccountPriority(accountId: string, priority: number | null): Promise<void> {
    const response = await this.request('PUT', '/api/codex-auth/accounts/priority', { id: accountId, priority });
    this.assertOk(response, 'prioritize ChatGPT account');
  }

  async setCoreCodexPoolStrategy(strategy: 'balanced' | 'even' | 'sequential'): Promise<void> {
    const response = await this.request('PUT', '/api/codex-auth/pool-strategy', { strategy });
    this.assertOk(response, 'set ChatGPT pool strategy');
  }

  /** Raw per-account ChatGPT quota map keyed by core account id. */
  async coreCodexQuota(): Promise<Record<string, unknown> | null> {
    const response = await this.request('GET', '/api/codex-auth/quota');
    if (!response || response.status !== 200) return null;
    const quotas = (response.body as { quotas?: unknown }).quotas;
    return quotas && typeof quotas === 'object' ? (quotas as Record<string, unknown>) : null;
  }

  private assertOk(
    response: { status: number; body: unknown } | null,
    action: string
  ): asserts response is { status: number; body: unknown } {
    if (!response) throw new InferenceCoreClientError(`Core is unreachable during ${action}`);
    if (response.status < 200 || response.status >= 300) {
      const message =
        response.body && typeof response.body === 'object' && typeof (response.body as { error?: unknown }).error === 'string'
          ? (response.body as { error: string }).error
          : `core ${action} failed with status ${response.status}`;
      throw new InferenceCoreClientError(message, response.status);
    }
  }

  /** Ask the core to stop accepting new work and finish in-flight turns. */
  async drain(): Promise<void> {
    const response = await this.request('POST', '/api/wiolett/drain');
    if (!response || response.status !== 200) {
      throw new InferenceCoreClientError(`Core drain failed (${response?.status ?? 'unreachable'})`, response?.status);
    }
  }

  /** Resume after a drain (used when an update aborts before replacement). */
  async resume(): Promise<void> {
    const response = await this.request('POST', '/api/wiolett/resume');
    if (!response || response.status !== 200) {
      throw new InferenceCoreClientError(`Core resume failed (${response?.status ?? 'unreachable'})`, response?.status);
    }
  }

  private async getIdentity(path: string): Promise<InferenceCoreHealthIdentity | null> {
    const response = await this.request('GET', path);
    if (!response || response.status !== 200) return null;
    return this.parseIdentity(response.body);
  }

  private parseIdentity(body: unknown): InferenceCoreHealthIdentity | null {
    const parsed = inferenceCoreHealthIdentitySchema.safeParse(body);
    if (!parsed.success) return null;
    return parsed.data;
  }

  private async request(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    payload?: unknown
  ): Promise<{ status: number; body: unknown } | null> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'x-opencodex-api-key': this.managementCredential,
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      logger.debug('Core request failed', {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON replies carry no identity information.
    }
    return { status: response.status, body };
  }
}
