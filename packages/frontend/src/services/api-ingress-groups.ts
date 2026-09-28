import type {
  CreateIngressGroupRequest,
  Domain,
  DomainIngressGroupOption,
  IngressGroup,
  IngressGroupDetail,
  ProxyHost,
  RouteIngressGroupOption,
  UpdateIngressGroupRequest,
} from "@/types";
import type { ApiClientBaseConstructor } from "./api-mixins";

/** /api/ingress-groups and the ingress placement of routes and domains. */
export function withIngressGroupsApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class IngressGroupsApiClient extends Base {
    async listIngressGroups(params?: {
      search?: string;
      folderId?: string;
    }): Promise<IngressGroup[]> {
      const query = new URLSearchParams();
      if (params?.search) query.set("search", params.search);
      if (params?.folderId) query.set("folderId", params.folderId);
      const suffix = query.toString();
      return this.unwrapData(
        this.request<{ data: IngressGroup[] }>(`/ingress-groups${suffix ? `?${suffix}` : ""}`)
      );
    }

    async getIngressGroup(id: string): Promise<IngressGroupDetail> {
      return this.unwrapData(this.request<{ data: IngressGroupDetail }>(`/ingress-groups/${id}`));
    }

    async createIngressGroup(data: CreateIngressGroupRequest): Promise<IngressGroup> {
      return this.unwrapData(
        this.request<{ data: IngressGroup }>("/ingress-groups", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateIngressGroup(id: string, data: UpdateIngressGroupRequest): Promise<IngressGroup> {
      return this.unwrapData(
        this.request<{ data: IngressGroup }>(`/ingress-groups/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteIngressGroup(id: string): Promise<void> {
      await this.request(`/ingress-groups/${id}`, { method: "DELETE" });
    }

    async addIngressGroupMember(
      id: string,
      data: { nodeId: string; position?: number }
    ): Promise<IngressGroup> {
      return this.unwrapData(
        this.request<{ data: IngressGroup }>(`/ingress-groups/${id}/members`, {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async removeIngressGroupMember(
      id: string,
      nodeId: string,
      options?: { force?: boolean }
    ): Promise<IngressGroup> {
      return this.unwrapData(
        this.request<{ data: IngressGroup }>(`/ingress-groups/${id}/members/${nodeId}`, {
          method: "DELETE",
          body: JSON.stringify({ force: options?.force === true }),
        })
      );
    }

    async reorderIngressGroup(id: string, nodeIds: string[]): Promise<IngressGroup> {
      return this.unwrapData(
        this.request<{ data: IngressGroup }>(`/ingress-groups/${id}/members/order`, {
          method: "PUT",
          body: JSON.stringify({ nodeIds }),
        })
      );
    }

    /** Ingress groups a new route may use (every member open to the caller's proxy:create grant). */
    async listRouteIngressGroups(folderId?: string | null): Promise<RouteIngressGroupOption[]> {
      const suffix = folderId ? `?folderId=${encodeURIComponent(folderId)}` : "";
      const response = await this.request<{ groups?: RouteIngressGroupOption[] }>(
        `/proxy-hosts/ingress-nodes${suffix}`
      );
      return response.groups ?? [];
    }

    /** Ingress groups a new domain may use (from GET /domains/nginx-nodes). */
    async listDomainIngressGroups(): Promise<DomainIngressGroupOption[]> {
      const response = await this.request<{ data: { ingressGroups?: DomainIngressGroupOption[] } }>(
        "/domains/nginx-nodes"
      );
      return response.data?.ingressGroups ?? [];
    }

    /** Serves a route from every member of a group, or (ingressGroupId null) from one member node. */
    async changeRouteIngressPlacement(
      id: string,
      target: { ingressGroupId: string | null; nodeId?: string }
    ): Promise<ProxyHost> {
      return this.unwrapData(
        this.request<{ data: ProxyHost }>(`/proxy-hosts/${id}/ingress-placement`, {
          method: "POST",
          body: JSON.stringify(target),
        })
      );
    }

    /** Moves a domain (and its routes) onto a group, or (ingressGroupId null) back to one member node. */
    async changeDomainIngressPlacement(
      id: string,
      target: { ingressGroupId: string | null; nginxNodeId?: string }
    ): Promise<Domain> {
      return this.unwrapData(
        this.request<{ data: Domain }>(`/domains/${id}/ingress-placement`, {
          method: "POST",
          body: JSON.stringify(target),
        })
      );
    }
  };
}
