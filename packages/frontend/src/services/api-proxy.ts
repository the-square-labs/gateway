import type {
  CertificateDistributionState,
  CreateProxyHostRequest,
  FolderTreeNode,
  GroupedProxyHostsResponse,
  HealthStatus,
  PaginatedResponse,
  ProxyHost,
  ProxyHostType,
  ProxySecureLinkStatus,
} from "@/types";
import type { ApiClientBaseConstructor } from "./api-mixins";

export function withProxyApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class ProxyApiClient extends Base {
    // ── Proxy Hosts ──────────────────────────────────────────────────

    async listProxyHosts(params?: {
      page?: number;
      limit?: number;
      search?: string;
      type?: ProxyHostType;
      healthStatus?: HealthStatus;
      enabled?: boolean;
      sortBy?: string;
      sortOrder?: string;
      nodeId?: string;
    }): Promise<PaginatedResponse<ProxyHost>> {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set("page", params.page.toString());
      if (params?.limit) searchParams.set("limit", params.limit.toString());
      if (params?.search) searchParams.set("search", params.search);
      if (params?.type) searchParams.set("type", params.type);
      if (params?.healthStatus) searchParams.set("healthStatus", params.healthStatus);
      if (params?.enabled !== undefined) searchParams.set("enabled", params.enabled.toString());
      if (params?.sortBy) searchParams.set("sortBy", params.sortBy);
      if (params?.sortOrder) searchParams.set("sortOrder", params.sortOrder);
      if (params?.nodeId) searchParams.set("nodeId", params.nodeId);

      const query = searchParams.toString();
      return this.request<PaginatedResponse<ProxyHost>>(`/proxy-hosts${query ? `?${query}` : ""}`);
    }

    async getProxyHost(id: string): Promise<ProxyHost> {
      return this.unwrapData(this.request<{ data: ProxyHost }>(`/proxy-hosts/${id}`));
    }

    async getProxyHostBySlug(slug: string): Promise<ProxyHost> {
      return this.unwrapData(
        this.requestRouteContext<{ data: ProxyHost }>(
          `/proxy-hosts/by-slug/${encodeURIComponent(slug)}`
        )
      );
    }

    async getProxyHostHealthHistory(
      id: string
    ): Promise<Array<{ ts: string; status: string; responseMs?: number; slow?: boolean }>> {
      return this.unwrapData(this.request(`/proxy-hosts/${id}/health-history`));
    }

    async getProxySecureLinkStatus(id: string): Promise<ProxySecureLinkStatus> {
      return this.unwrapData(
        this.request<{ data: ProxySecureLinkStatus }>(`/proxy-hosts/${id}/secure-link`)
      );
    }

    async createProxyHost(data: CreateProxyHostRequest): Promise<ProxyHost> {
      return this.unwrapData(
        this.request<{ data: ProxyHost }>("/proxy-hosts", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateProxyHost(id: string, data: Partial<CreateProxyHostRequest>): Promise<ProxyHost> {
      return this.unwrapData(
        this.request<{ data: ProxyHost }>(`/proxy-hosts/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteProxyHost(id: string): Promise<void> {
      return this.request<void>(`/proxy-hosts/${id}`, { method: "DELETE" });
    }

    async toggleProxyHost(id: string, enabled: boolean): Promise<ProxyHost> {
      return this.unwrapData(
        this.request<{ data: ProxyHost }>(`/proxy-hosts/${id}/toggle`, {
          method: "POST",
          body: JSON.stringify({ enabled }),
        })
      );
    }

    async toggleProxyMaintenance(id: string, enabled: boolean): Promise<ProxyHost> {
      return this.unwrapData(
        this.request<{ data: ProxyHost }>(`/proxy-hosts/${id}/maintenance`, {
          method: "POST",
          body: JSON.stringify({ enabled }),
        })
      );
    }

    async resyncProxyHostTls(
      id: string
    ): Promise<{ distribution: CertificateDistributionState | null }> {
      return this.unwrapData(
        this.request<{ data: { distribution: CertificateDistributionState | null } }>(
          `/proxy-hosts/${id}/tls/resync`,
          { method: "POST" }
        )
      );
    }

    async getRenderedProxyConfig(id: string): Promise<{ rendered: string }> {
      return this.unwrapData(
        this.request<{ data: { rendered: string } }>(`/proxy-hosts/${id}/rendered-config`)
      );
    }

    async validateProxyConfig(
      snippet: string,
      mode: "advanced" | "raw" = "advanced",
      proxyHostId?: string
    ): Promise<{ valid: boolean; errors: string[] }> {
      return this.unwrapData(
        this.request<{ data: { valid: boolean; errors: string[] } }>(
          "/proxy-hosts/validate-config",
          {
            method: "POST",
            body: JSON.stringify({ snippet, mode, proxyHostId }),
          }
        )
      );
    }

    // ── Proxy Host Folders ─────────────────────────────────────────

    async listFolders(): Promise<FolderTreeNode[]> {
      return this.unwrapData(this.request<{ data: FolderTreeNode[] }>("/proxy-host-folders"));
    }

    async getGroupedProxyHosts(params?: {
      search?: string;
      type?: ProxyHostType;
      healthStatus?: HealthStatus;
      enabled?: boolean;
    }): Promise<GroupedProxyHostsResponse> {
      const searchParams = new URLSearchParams();
      if (params?.search) searchParams.set("search", params.search);
      if (params?.type) searchParams.set("type", params.type);
      if (params?.healthStatus) searchParams.set("healthStatus", params.healthStatus);
      if (params?.enabled !== undefined) searchParams.set("enabled", params.enabled.toString());
      const query = searchParams.toString();
      return this.unwrapData(
        this.request<{ data: GroupedProxyHostsResponse }>(
          `/proxy-host-folders/grouped${query ? `?${query}` : ""}`
        )
      );
    }
  };
}
