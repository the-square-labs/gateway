import type {
  DockerMigration,
  DockerMigrationPreflight,
  DockerMigrationRequest,
  StartDockerMigrationRequest,
} from "@/types";
import type { ApiClientBaseConstructor } from "./api-mixins";

export function withDockerMigrationApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class DockerMigrationApiClient extends Base {
    async preflightDockerMigration(
      request: DockerMigrationRequest
    ): Promise<DockerMigrationPreflight> {
      return this.unwrapData(
        this.request<{ data: DockerMigrationPreflight }>("/docker/migrations/preflight", {
          method: "POST",
          body: JSON.stringify(request),
        })
      );
    }

    async startDockerMigration(request: StartDockerMigrationRequest): Promise<DockerMigration> {
      return this.unwrapData(
        this.request<{ data: DockerMigration }>("/docker/migrations", {
          method: "POST",
          body: JSON.stringify(request),
        })
      );
    }

    async listDockerMigrations(params?: {
      nodeId?: string;
      status?: string;
    }): Promise<DockerMigration[]> {
      const query = new URLSearchParams();
      if (params?.nodeId) query.set("nodeId", params.nodeId);
      if (params?.status) query.set("status", params.status);
      const suffix = query.size ? `?${query}` : "";
      return this.unwrapData(
        this.request<{ data: DockerMigration[] }>(`/docker/migrations${suffix}`)
      );
    }

    async getDockerMigration(id: string): Promise<DockerMigration> {
      return this.unwrapData(this.request<{ data: DockerMigration }>(`/docker/migrations/${id}`));
    }

    async cancelDockerMigration(id: string): Promise<DockerMigration> {
      return this.unwrapData(
        this.request<{ data: DockerMigration }>(`/docker/migrations/${id}/cancel`, {
          method: "POST",
        })
      );
    }

    async resolveDockerMigration(
      id: string,
      authoritativeSide: "source" | "target"
    ): Promise<DockerMigration> {
      return this.unwrapData(
        this.request<{ data: DockerMigration }>(`/docker/migrations/${id}/resolve`, {
          method: "POST",
          body: JSON.stringify({ authoritativeSide }),
        })
      );
    }

    async retryDockerMigrationCleanup(id: string): Promise<DockerMigration> {
      return this.unwrapData(
        this.request<{ data: DockerMigration }>(`/docker/migrations/${id}/retry-cleanup`, {
          method: "POST",
        })
      );
    }
  };
}
