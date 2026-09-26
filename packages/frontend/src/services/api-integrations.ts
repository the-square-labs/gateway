import type {
  CloudflareConnector,
  CloudflareConnectorCreateRequest,
  CloudflareConnectorPreviewTestRequest,
  CloudflareConnectorPreviewTestResult,
  CloudflareConnectorSyncResult,
  CloudflareConnectorUpdateRequest,
  CloudflareZone,
  ExternalSshConnector,
  ExternalSshConnectorRequest,
  ExternalSshHostKeyRequest,
  ExternalSshHostKeyResult,
  GitConnector,
  GitConnectorCreateRequest,
  GitConnectorPreviewTestRequest,
  GitConnectorPreviewTestResult,
  GitConnectorProvider,
  GitHubConnectorPreviewTestRequest,
  GitHubConnectorPreviewTestResult,
  GitHubOAuthSession,
  GitHubOAuthStartRequest,
  GitHubScopeTargets,
  GitLabAllowlistEntry,
  GitLabAllowlistPreviewSearchRequest,
  GitLabConnector,
  GitLabConnectorCreateRequest,
  GitLabConnectorPreviewTestRequest,
  GitLabConnectorPreviewTestResult,
  GitLabConnectorSyncResult,
  GitLabConnectorUpdateRequest,
  GitLabScopeTargets,
  GitLabUserCredentialStatus,
  GitScopeProvider,
  GitScopeTargetResolution,
  GitUserCredentialStatus,
} from "@/types/integrations";
import type { ApiClientBaseConstructor } from "./api-mixins";

export function withIntegrationsApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class IntegrationsApi extends Base {
    async listGitConnectors(provider: GitConnectorProvider): Promise<GitConnector[]> {
      return this.unwrapData(
        this.request<{ data: GitConnector[] }>(`/integrations/${provider}/connectors`)
      );
    }

    async createGitConnector(
      provider: GitConnectorProvider,
      data: GitConnectorCreateRequest
    ): Promise<GitConnector> {
      return this.unwrapData(
        this.request<{ data: GitConnector }>(`/integrations/${provider}/connectors`, {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async previewGitHubConnectorTest(
      data: GitHubConnectorPreviewTestRequest
    ): Promise<GitHubConnectorPreviewTestResult> {
      return this.unwrapData(
        this.request<{ data: GitHubConnectorPreviewTestResult }>(
          "/integrations/github/connectors/preview-test",
          {
            method: "POST",
            body: JSON.stringify(data),
          }
        )
      );
    }

    async previewGitConnectorTest(
      data: GitConnectorPreviewTestRequest
    ): Promise<GitConnectorPreviewTestResult> {
      return this.unwrapData(
        this.request<{ data: GitConnectorPreviewTestResult }>(
          "/integrations/git/connectors/preview-test",
          {
            method: "POST",
            body: JSON.stringify(data),
          }
        )
      );
    }

    async updateGitConnector(
      provider: GitConnectorProvider,
      id: string,
      data: Partial<GitConnectorCreateRequest>
    ): Promise<GitConnector> {
      return this.unwrapData(
        this.request<{ data: GitConnector }>(`/integrations/${provider}/connectors/${id}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        })
      );
    }

    async testGitConnector(provider: GitConnectorProvider, id: string): Promise<GitConnector> {
      return this.unwrapData(
        this.request<{ data: GitConnector }>(`/integrations/${provider}/connectors/${id}/test`, {
          method: "POST",
        })
      );
    }

    async syncGitConnector(provider: GitConnectorProvider, id: string): Promise<GitConnector> {
      return this.unwrapData(
        this.request<{ data: GitConnector }>(`/integrations/${provider}/connectors/${id}/sync`, {
          method: "POST",
        })
      );
    }

    async deleteGitConnector(provider: GitConnectorProvider, id: string): Promise<void> {
      await this.request<{ success: true }>(`/integrations/${provider}/connectors/${id}`, {
        method: "DELETE",
      });
    }

    async getGitHubOAuthAvailability(): Promise<{ available: boolean }> {
      return this.unwrapData(
        this.request<{ data: { available: boolean } }>("/integrations/github/oauth")
      );
    }

    async startGitHubOAuth(data: GitHubOAuthStartRequest): Promise<GitHubOAuthSession> {
      return this.unwrapData(
        this.request<{ data: GitHubOAuthSession }>("/integrations/github/oauth/sessions", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async getGitHubOAuthStatus(id: string): Promise<GitHubOAuthSession> {
      return this.unwrapData(
        this.request<{ data: GitHubOAuthSession }>(`/integrations/github/oauth/sessions/${id}`)
      );
    }

    async cancelGitHubOAuth(id: string): Promise<GitHubOAuthSession> {
      return this.unwrapData(
        this.request<{ data: GitHubOAuthSession }>(`/integrations/github/oauth/sessions/${id}`, {
          method: "DELETE",
        })
      );
    }

    async getGitUserCredentialStatus(
      provider: GitConnectorProvider,
      connectorId: string
    ): Promise<GitUserCredentialStatus> {
      return this.unwrapData(
        this.request<{ data: GitUserCredentialStatus }>(
          `/integrations/${provider}/connectors/${connectorId}/user-credential`
        )
      );
    }

    async authorizeGitUserCredential(
      provider: GitConnectorProvider,
      connectorId: string,
      input: { username?: string; token: string }
    ): Promise<GitUserCredentialStatus> {
      return this.unwrapData(
        this.request<{ data: GitUserCredentialStatus }>(
          `/integrations/${provider}/connectors/${connectorId}/user-credential`,
          { method: "POST", body: JSON.stringify(input) }
        )
      );
    }

    async listExternalSshConnectors(signal?: AbortSignal): Promise<ExternalSshConnector[]> {
      return this.unwrapData(
        this.request<{ data: ExternalSshConnector[] }>("/integrations/ssh/connectors", { signal })
      );
    }

    async discoverExternalSshHostKey(
      data: ExternalSshHostKeyRequest,
      signal?: AbortSignal
    ): Promise<ExternalSshHostKeyResult> {
      return this.unwrapData(
        this.request<{ data: ExternalSshHostKeyResult }>("/integrations/ssh/connectors/host-key", {
          method: "POST",
          body: JSON.stringify(data),
          signal,
        })
      );
    }

    async createExternalSshConnector(
      data: ExternalSshConnectorRequest,
      signal?: AbortSignal
    ): Promise<{ connector: ExternalSshConnector; generatedPublicKey: string | null }> {
      return this.unwrapData(
        this.request<{
          data: { connector: ExternalSshConnector; generatedPublicKey: string | null };
        }>("/integrations/ssh/connectors", {
          method: "POST",
          body: JSON.stringify(data),
          signal,
        })
      );
    }

    async testExternalSshConnector(id: string, signal?: AbortSignal): Promise<{ success: true }> {
      return this.unwrapData(
        this.request<{ data: { success: true } }>(`/integrations/ssh/connectors/${id}/test`, {
          method: "POST",
          signal,
        })
      );
    }

    async syncExternalSshConnector(id: string, signal?: AbortSignal): Promise<{ success: true }> {
      return this.unwrapData(
        this.request<{ data: { success: true } }>(`/integrations/ssh/connectors/${id}/sync`, {
          method: "POST",
          signal,
        })
      );
    }

    async updateExternalSshConnector(id: string, name: string): Promise<ExternalSshConnector> {
      return this.unwrapData(
        this.request<{ data: ExternalSshConnector }>(`/integrations/ssh/connectors/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ name }),
        })
      );
    }

    async deleteExternalSshConnector(id: string): Promise<void> {
      await this.request<{ data: { success: true } }>(`/integrations/ssh/connectors/${id}`, {
        method: "DELETE",
      });
    }
    async listGitLabConnectors(params?: { enabled?: boolean }): Promise<GitLabConnector[]> {
      const searchParams = new URLSearchParams();
      if (params?.enabled !== undefined) searchParams.set("enabled", String(params.enabled));
      const query = searchParams.toString();
      return this.unwrapData(
        this.request<{ data: GitLabConnector[] }>(
          `/integrations/gitlab/connectors${query ? `?${query}` : ""}`
        )
      );
    }

    async listCloudflareConnectors(params?: { enabled?: boolean }): Promise<CloudflareConnector[]> {
      const searchParams = new URLSearchParams();
      if (params?.enabled !== undefined) searchParams.set("enabled", String(params.enabled));
      const query = searchParams.toString();
      return this.unwrapData(
        this.request<{ data: CloudflareConnector[] }>(
          `/integrations/cloudflare/connectors${query ? `?${query}` : ""}`
        )
      );
    }

    async getCloudflareConnector(id: string): Promise<CloudflareConnector> {
      return this.unwrapData(
        this.request<{ data: CloudflareConnector }>(`/integrations/cloudflare/connectors/${id}`)
      );
    }

    async createCloudflareConnector(
      data: CloudflareConnectorCreateRequest
    ): Promise<CloudflareConnector> {
      return this.unwrapData(
        this.request<{ data: CloudflareConnector }>("/integrations/cloudflare/connectors", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async previewCloudflareConnectorTest(
      data: CloudflareConnectorPreviewTestRequest
    ): Promise<CloudflareConnectorPreviewTestResult> {
      return this.unwrapData(
        this.request<{ data: CloudflareConnectorPreviewTestResult }>(
          "/integrations/cloudflare/connectors/preview-test",
          {
            method: "POST",
            body: JSON.stringify(data),
          }
        )
      );
    }

    async updateCloudflareConnector(
      id: string,
      data: CloudflareConnectorUpdateRequest
    ): Promise<CloudflareConnector> {
      return this.unwrapData(
        this.request<{ data: CloudflareConnector }>(`/integrations/cloudflare/connectors/${id}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteCloudflareConnector(id: string): Promise<void> {
      await this.request<{ success: true }>(`/integrations/cloudflare/connectors/${id}`, {
        method: "DELETE",
      });
    }

    async rotateCloudflareConnectorToken(id: string, token: string): Promise<CloudflareConnector> {
      return this.unwrapData(
        this.request<{ data: CloudflareConnector }>(
          `/integrations/cloudflare/connectors/${id}/token`,
          {
            method: "POST",
            body: JSON.stringify({ token }),
          }
        )
      );
    }

    async testCloudflareConnector(id: string): Promise<CloudflareConnector> {
      return this.unwrapData(
        this.request<{ data: CloudflareConnector }>(
          `/integrations/cloudflare/connectors/${id}/test`,
          {
            method: "POST",
          }
        )
      );
    }

    async syncCloudflareConnector(id: string): Promise<CloudflareConnectorSyncResult> {
      return this.unwrapData(
        this.request<{ data: CloudflareConnectorSyncResult }>(
          `/integrations/cloudflare/connectors/${id}/sync`,
          {
            method: "POST",
          }
        )
      );
    }

    async listCloudflareZones(id: string): Promise<CloudflareZone[]> {
      return this.unwrapData(
        this.request<{ data: CloudflareZone[] }>(`/integrations/cloudflare/connectors/${id}/zones`)
      );
    }

    async getGitLabConnector(id: string): Promise<GitLabConnector> {
      return this.unwrapData(
        this.request<{ data: GitLabConnector }>(`/integrations/gitlab/connectors/${id}`)
      );
    }

    async getGitLabUserCredentialStatus(id: string): Promise<GitLabUserCredentialStatus> {
      return this.unwrapData(
        this.request<{ data: GitLabUserCredentialStatus }>(
          `/integrations/gitlab/connectors/${id}/user-credential`
        )
      );
    }

    async authorizeGitLabUserCredential(
      id: string,
      token: string
    ): Promise<GitLabUserCredentialStatus> {
      return this.unwrapData(
        this.request<{ data: GitLabUserCredentialStatus }>(
          `/integrations/gitlab/connectors/${id}/user-credential`,
          { method: "PUT", body: JSON.stringify({ token }) }
        )
      );
    }

    async disconnectGitLabUserCredential(id: string): Promise<{ disconnected: boolean }> {
      return this.unwrapData(
        this.request<{ data: { disconnected: boolean } }>(
          `/integrations/gitlab/connectors/${id}/user-credential`,
          { method: "DELETE" }
        )
      );
    }

    async createGitLabConnector(data: GitLabConnectorCreateRequest): Promise<GitLabConnector> {
      return this.unwrapData(
        this.request<{ data: GitLabConnector }>("/integrations/gitlab/connectors", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async previewGitLabAllowlistSearch(
      data: GitLabAllowlistPreviewSearchRequest
    ): Promise<GitLabAllowlistEntry[]> {
      return this.unwrapData(
        this.request<{ data: GitLabAllowlistEntry[] }>(
          "/integrations/gitlab/allowlist/preview-search",
          {
            method: "POST",
            body: JSON.stringify(data),
          }
        )
      );
    }

    async previewGitLabConnectorTest(
      data: GitLabConnectorPreviewTestRequest
    ): Promise<GitLabConnectorPreviewTestResult> {
      return this.unwrapData(
        this.request<{ data: GitLabConnectorPreviewTestResult }>(
          "/integrations/gitlab/connectors/preview-test",
          {
            method: "POST",
            body: JSON.stringify(data),
          }
        )
      );
    }

    async updateGitLabConnector(
      id: string,
      data: GitLabConnectorUpdateRequest
    ): Promise<GitLabConnector> {
      return this.unwrapData(
        this.request<{ data: GitLabConnector }>(`/integrations/gitlab/connectors/${id}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteGitLabConnector(id: string): Promise<void> {
      await this.request<{ success: true }>(`/integrations/gitlab/connectors/${id}`, {
        method: "DELETE",
      });
    }

    async rotateGitLabConnectorToken(id: string, token: string): Promise<GitLabConnector> {
      return this.unwrapData(
        this.request<{ data: GitLabConnector }>(`/integrations/gitlab/connectors/${id}/token`, {
          method: "POST",
          body: JSON.stringify({ token }),
        })
      );
    }

    async getGitLabConnectorCapabilities(id: string): Promise<Record<string, boolean>> {
      return this.unwrapData(
        this.request<{ data: Record<string, boolean> }>(
          `/integrations/gitlab/connectors/${id}/capabilities`
        )
      );
    }

    async testGitLabConnector(id: string): Promise<GitLabConnector> {
      return this.unwrapData(
        this.request<{ data: GitLabConnector }>(`/integrations/gitlab/connectors/${id}/test`, {
          method: "POST",
        })
      );
    }

    async syncGitLabConnector(id: string): Promise<GitLabConnectorSyncResult> {
      return this.unwrapData(
        this.request<{ data: GitLabConnectorSyncResult }>(
          `/integrations/gitlab/connectors/${id}/sync`,
          {
            method: "POST",
          }
        )
      );
    }

    async searchGitLabAllowlist(id: string, query: string): Promise<GitLabAllowlistEntry[]> {
      return this.unwrapData(
        this.request<{ data: GitLabAllowlistEntry[] }>(
          `/integrations/gitlab/connectors/${id}/allowlist/search?q=${encodeURIComponent(query)}`
        )
      );
    }

    async listGitLabAllowlistOptions(id: string): Promise<GitLabAllowlistEntry[]> {
      return this.unwrapData(
        this.request<{ data: GitLabAllowlistEntry[] }>(
          `/integrations/gitlab/connectors/${id}/allowlist/options`
        )
      );
    }

    async refreshGitLabAllowlistOptions(id: string): Promise<GitLabAllowlistEntry[]> {
      return this.unwrapData(
        this.request<{ data: GitLabAllowlistEntry[] }>(
          `/integrations/gitlab/connectors/${id}/allowlist/options/refresh`,
          { method: "POST" }
        )
      );
    }

    /** Groups and projects of a GitLab connector that a permission can be limited to. */
    async searchGitLabScopeTargets(
      connectorId: string,
      search: string,
      limit = SCOPE_TARGET_SEARCH_LIMIT
    ): Promise<GitLabScopeTargets> {
      const payload = unwrapScopeTargetPayload(
        await this.request<ScopeTargetPayload<GitLabScopeTargets>>(
          scopeTargetSearchPath("gitlab", connectorId, search, limit)
        )
      );
      return { groups: payload?.groups ?? [], projects: payload?.projects ?? [] };
    }

    /** Owners and repositories of a GitHub connector that a permission can be limited to. */
    async searchGitHubScopeTargets(
      connectorId: string,
      search: string,
      limit = SCOPE_TARGET_SEARCH_LIMIT
    ): Promise<GitHubScopeTargets> {
      const payload = unwrapScopeTargetPayload(
        await this.request<ScopeTargetPayload<GitHubScopeTargets>>(
          scopeTargetSearchPath("github", connectorId, search, limit)
        )
      );
      return { owners: payload?.owners ?? [], repos: payload?.repos ?? [] };
    }

    /** Labels for stored qualifiers of one connector (`group/123`, `repo/456`, …). */
    async resolveGitScopeTargets(
      provider: GitScopeProvider,
      connectorId: string,
      qualifiers: readonly string[]
    ): Promise<GitScopeTargetResolution[]> {
      const params = new URLSearchParams({ ids: qualifiers.join(",") });
      const payload = unwrapScopeTargetPayload(
        await this.request<
          ScopeTargetPayload<{ items: GitScopeTargetResolution[] } | GitScopeTargetResolution[]>
        >(
          `/integrations/${provider}/${encodeURIComponent(connectorId)}/scope-targets/resolve?${params}`
        )
      );
      return (Array.isArray(payload) ? payload : payload?.items) ?? [];
    }
  };
}

const SCOPE_TARGET_SEARCH_LIMIT = 50;

type ScopeTargetPayload<T> = T | { data: T };

// The contract describes the payload itself; accept it bare or in the usual `{ data }` envelope.
function unwrapScopeTargetPayload<T extends object>(
  response: ScopeTargetPayload<T> | null | undefined
): T | undefined {
  if (!response) return undefined;
  if (!Array.isArray(response) && "data" in response) return response.data;
  return response as T;
}

function scopeTargetSearchPath(
  provider: "gitlab" | "github",
  connectorId: string,
  search: string,
  limit: number
) {
  const params = new URLSearchParams({ search, limit: String(limit) });
  return `/integrations/${provider}/${encodeURIComponent(connectorId)}/scope-targets?${params}`;
}
