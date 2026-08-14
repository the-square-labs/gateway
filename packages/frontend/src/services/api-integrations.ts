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
  GitConnector,
  GitConnectorProvider,
  GitConnectorRequest,
  GitHubOAuthSession,
  GitHubOAuthStartRequest,
  GitLabAllowlistEntry,
  GitLabAllowlistPreviewSearchRequest,
  GitLabConnector,
  GitLabConnectorCreateRequest,
  GitLabConnectorPreviewTestRequest,
  GitLabConnectorPreviewTestResult,
  GitLabConnectorSyncResult,
  GitLabConnectorUpdateRequest,
  GitLabUserCredentialStatus,
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
      data: GitConnectorRequest
    ): Promise<GitConnector> {
      return this.unwrapData(
        this.request<{ data: GitConnector }>(`/integrations/${provider}/connectors`, {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
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

    async listExternalSshConnectors(): Promise<ExternalSshConnector[]> {
      return this.unwrapData(
        this.request<{ data: ExternalSshConnector[] }>("/integrations/ssh/connectors")
      );
    }

    async createExternalSshConnector(
      data: ExternalSshConnectorRequest
    ): Promise<{ connector: ExternalSshConnector; generatedPublicKey: string | null }> {
      return this.unwrapData(
        this.request<{
          data: { connector: ExternalSshConnector; generatedPublicKey: string | null };
        }>("/integrations/ssh/connectors", { method: "POST", body: JSON.stringify(data) })
      );
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
  };
}
