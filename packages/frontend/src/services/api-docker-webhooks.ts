import type { DockerImageCleanupSettings, DockerWebhook } from "@/types";
import type { ApiClientBaseConstructor } from "./api-mixins";

export function withDockerWebhookApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class DockerWebhookApiClient extends Base {
    async getContainerWebhook(
      nodeId: string,
      containerName: string
    ): Promise<DockerWebhook | null> {
      const result = await this.request<{ data: DockerWebhook | null }>(
        `/docker/nodes/${nodeId}/containers/${encodeURIComponent(containerName)}/webhook`
      );
      return result.data;
    }

    async upsertContainerWebhook(
      nodeId: string,
      containerName: string,
      input: { enabled?: boolean }
    ): Promise<DockerWebhook> {
      return this.unwrapData(
        this.request<{ data: DockerWebhook }>(
          `/docker/nodes/${nodeId}/containers/${encodeURIComponent(containerName)}/webhook`,
          { method: "PUT", body: JSON.stringify(input) }
        )
      );
    }

    async deleteContainerWebhook(nodeId: string, containerName: string): Promise<void> {
      await this.request<void>(
        `/docker/nodes/${nodeId}/containers/${encodeURIComponent(containerName)}/webhook`,
        { method: "DELETE" }
      );
    }

    async regenerateWebhookToken(nodeId: string, containerName: string): Promise<DockerWebhook> {
      return this.unwrapData(
        this.request<{ data: DockerWebhook }>(
          `/docker/nodes/${nodeId}/containers/${encodeURIComponent(containerName)}/webhook/regenerate`,
          { method: "POST" }
        )
      );
    }

    async getContainerImageCleanup(
      nodeId: string,
      containerName: string
    ): Promise<DockerImageCleanupSettings> {
      return this.unwrapData(
        this.request<{ data: DockerImageCleanupSettings }>(
          `/docker/nodes/${nodeId}/containers/${encodeURIComponent(containerName)}/image-cleanup`
        )
      );
    }

    async upsertContainerImageCleanup(
      nodeId: string,
      containerName: string,
      input: { enabled?: boolean; retentionCount?: number }
    ): Promise<DockerImageCleanupSettings> {
      return this.unwrapData(
        this.request<{ data: DockerImageCleanupSettings }>(
          `/docker/nodes/${nodeId}/containers/${encodeURIComponent(containerName)}/image-cleanup`,
          { method: "PUT", body: JSON.stringify(input) }
        )
      );
    }

    async getDeploymentWebhook(
      nodeId: string,
      deploymentId: string
    ): Promise<DockerWebhook | null> {
      const result = await this.request<{ data: DockerWebhook | null }>(
        `/docker/nodes/${nodeId}/deployments/${deploymentId}/webhook`
      );
      return result.data;
    }

    async upsertDeploymentWebhook(
      nodeId: string,
      deploymentId: string,
      input: { enabled?: boolean }
    ): Promise<DockerWebhook> {
      return this.unwrapData(
        this.request<{ data: DockerWebhook }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/webhook`,
          { method: "PUT", body: JSON.stringify(input) }
        )
      );
    }

    async deleteDeploymentWebhook(nodeId: string, deploymentId: string): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/deployments/${deploymentId}/webhook`, {
        method: "DELETE",
      });
    }

    async regenerateDeploymentWebhookToken(
      nodeId: string,
      deploymentId: string
    ): Promise<DockerWebhook> {
      return this.unwrapData(
        this.request<{ data: DockerWebhook }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/webhook/regenerate`,
          { method: "POST" }
        )
      );
    }

    async getDeploymentImageCleanup(
      nodeId: string,
      deploymentId: string
    ): Promise<DockerImageCleanupSettings> {
      return this.unwrapData(
        this.request<{ data: DockerImageCleanupSettings }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/image-cleanup`
        )
      );
    }

    async upsertDeploymentImageCleanup(
      nodeId: string,
      deploymentId: string,
      input: { enabled?: boolean; retentionCount?: number }
    ): Promise<DockerImageCleanupSettings> {
      return this.unwrapData(
        this.request<{ data: DockerImageCleanupSettings }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/image-cleanup`,
          { method: "PUT", body: JSON.stringify(input) }
        )
      );
    }

    /**
     * Pull an image now. With `workload`, the pull is for a container or deployment about to be created at that
     * destination (container folder, or null for the node root): its create scope authorizes the pull.
     */
    async pullImageSync(
      nodeId: string,
      imageRef: string,
      registryId?: string,
      workload?: { folderId: string | null }
    ): Promise<{ success: boolean; imageRef: string }> {
      return this.unwrapData(
        this.request<{ data: { success: boolean; imageRef: string } }>(
          `/docker/nodes/${nodeId}/images/pull-sync`,
          { method: "POST", body: JSON.stringify({ imageRef, registryId, workload }) }
        )
      );
    }
  };
}
