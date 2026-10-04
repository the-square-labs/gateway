import type { ContainerLink, ContainerLinkCreateInput, ContainerLinkListParams } from "@/types";
import type { ApiClientBaseConstructor } from "./api-mixins";

export function withContainerLinksApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class ContainerLinksApiClient extends Base {
    /** `outgoing` (default): links the workload starts. `incoming`: links that reach it. */
    async listContainerLinks(params: ContainerLinkListParams): Promise<ContainerLink[]> {
      const query = new URLSearchParams({
        nodeId: params.nodeId,
        type: params.type,
        resourceId: params.resourceId,
        direction: params.direction ?? "outgoing",
      });
      return this.unwrapData(
        this.request<{ data: ContainerLink[] }>(`/docker/container-links?${query.toString()}`)
      );
    }

    async createContainerLink(data: ContainerLinkCreateInput): Promise<ContainerLink> {
      return this.unwrapData(
        this.request<{ data: ContainerLink }>("/docker/container-links", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteContainerLink(id: string): Promise<void> {
      await this.request<{ data: { success: boolean } }>(
        `/docker/container-links/${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
    }
  };
}
