import type {
  ContainerCreateConfig,
  DockerContainer,
  DockerContainerFolder,
  DockerDeployment,
  DockerFolderResourceType,
  DockerFolderTreeNode,
  DockerHealthCheck,
  DockerImage,
  DockerNetwork,
  DockerRegistry,
  DockerRuntimeStatus,
  DockerSecret,
  DockerTask,
  DockerVolume,
  FileEntry,
  Node,
} from "@/types";
import { API_BASE } from "./api-base";
import { withDockerMigrationApi } from "./api-docker-migrations";
import { withDockerWebhookApi } from "./api-docker-webhooks";
import type { ApiClientBaseConstructor } from "./api-mixins";

type DockerListEnvelope<T> = {
  data: T[];
  total?: number;
  limit?: number;
  truncated?: boolean;
  nodes?: Array<{
    id: string;
    slug?: string;
    hostname?: string;
    displayName?: string;
    appearanceColor?: Node["appearanceColor"];
  }>;
};

type DockerListQuery = {
  search?: string;
};

type DockerGpuUsage = {
  deviceId: string;
  containerCount: number;
  containers: Array<{ name: string }>;
};

function dockerListQuery(params?: DockerListQuery & { noCache?: boolean }) {
  const query = new URLSearchParams();
  if (params?.search?.trim()) query.set("search", params.search.trim());
  if (params?.noCache) query.set("_t", String(Date.now()));
  const qs = query.toString();
  return qs ? `?${qs}` : "";
}

function withDockerListMeta<T extends object>(response: DockerListEnvelope<T>): T[] {
  return (response.data ?? []).map((item) => ({
    ...item,
    _listTotal: response.total ?? response.data.length,
    _listLimit: response.limit ?? response.data.length,
    _listTruncated: response.truncated === true,
  })) as T[];
}

// Snapshot routes use the same daemon-originated list payloads as legacy per-node routes.
// Preserve the existing tolerant casing normalization until every producer is camelCase-only.
function normalizeDockerRow(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  if (Array.isArray(item)) return item.map(normalizeDockerRow);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    const normalizedKey = key.charAt(0).toLowerCase() + key.slice(1);
    out[normalizedKey] = normalizeDockerRow(value);
    if (normalizedKey !== key) out[key] = value;
  }
  return out;
}

function withSnapshotNodeMeta<T extends object>(response: DockerListEnvelope<T>): T[] {
  const nodes = new Map((response.nodes ?? []).map((node) => [node.id, node]));
  return withDockerListMeta(response).map((item) => {
    const nodeId =
      (item as { nodeId?: string; NodeId?: string }).nodeId ?? (item as { NodeId?: string }).NodeId;
    const node = nodeId ? nodes.get(nodeId) : undefined;
    return {
      ...(normalizeDockerRow(item) as T),
      _nodeId: nodeId,
      _nodeSlug: node?.slug ?? "",
      _nodeName: node?.displayName || node?.hostname || "",
      _nodeColor: node?.appearanceColor ?? null,
    };
  }) as T[];
}

export function withDockerApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class DockerApiClient extends withDockerMigrationApi(withDockerWebhookApi(Base)) {
    async getDockerNodeBySlug(
      slug: string
    ): Promise<
      Pick<Node, "id" | "slug" | "type" | "hostname" | "displayName" | "appearanceColor">
    > {
      return this.unwrapData(
        this.requestRouteContext<{
          data: Pick<Node, "id" | "slug" | "type" | "hostname" | "displayName" | "appearanceColor">;
        }>(`/docker/nodes/by-slug/${encodeURIComponent(slug)}`)
      );
    }

    // ── Docker Folders ─────────────────────────────────────────────

    async listDockerFolders(
      resourceType: DockerFolderResourceType = "container"
    ): Promise<DockerFolderTreeNode[]> {
      return this.unwrapData(
        this.request<{ data: DockerFolderTreeNode[] }>(
          `/docker/folders?resourceType=${resourceType}`
        )
      );
    }

    async createDockerFolder(data: {
      name: string;
      parentId?: string;
      resourceType?: DockerFolderResourceType;
    }): Promise<DockerContainerFolder> {
      return this.unwrapData(
        this.request<{ data: DockerContainerFolder }>("/docker/folders", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateDockerFolder(id: string, data: { name: string }): Promise<DockerContainerFolder> {
      return this.unwrapData(
        this.request<{ data: DockerContainerFolder }>(`/docker/folders/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteDockerFolder(id: string): Promise<void> {
      return this.request<void>(`/docker/folders/${id}`, { method: "DELETE" });
    }

    async reorderDockerFolders(
      items: { id: string; sortOrder: number }[],
      resourceType: DockerFolderResourceType = "container"
    ): Promise<void> {
      return this.request<void>("/docker/folders/reorder", {
        method: "PUT",
        body: JSON.stringify({ items, resourceType }),
      });
    }

    async moveDockerResourcesToFolder(
      resourceType: DockerFolderResourceType,
      items: Array<{ nodeId: string; resourceKey: string }>,
      folderId: string | null
    ): Promise<void> {
      return this.request<void>("/docker/folders/move-resources", {
        method: "POST",
        body: JSON.stringify({ resourceType, items, folderId }),
      });
    }

    async moveDockerContainersToFolder(
      items: Array<{ nodeId: string; containerName: string }>,
      folderId: string | null
    ): Promise<void> {
      return this.request<void>("/docker/folders/move-containers", {
        method: "POST",
        body: JSON.stringify({ items, folderId }),
      });
    }

    async reorderDockerContainers(
      items: Array<{ nodeId: string; containerName: string; sortOrder: number }>
    ): Promise<void> {
      return this.request<void>("/docker/folders/reorder-containers", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async reorderDockerResources(
      resourceType: DockerFolderResourceType,
      items: Array<{ nodeId: string; resourceKey: string; sortOrder: number }>
    ): Promise<void> {
      return this.request<void>("/docker/folders/reorder-resources", {
        method: "PUT",
        body: JSON.stringify({ resourceType, items }),
      });
    }

    async getDockerFolderPlacements(
      resourceType: DockerFolderResourceType,
      items: Array<{ nodeId: string; resourceKey: string }>
    ): Promise<
      Array<{
        nodeId: string;
        resourceKey: string;
        folderId: string | null;
        folderIsSystem: boolean;
        sortOrder: number;
      }>
    > {
      return this.unwrapData(
        this.request<{
          data: Array<{
            nodeId: string;
            resourceKey: string;
            folderId: string | null;
            folderIsSystem: boolean;
            sortOrder: number;
          }>;
        }>("/docker/folders/placements", {
          method: "POST",
          body: JSON.stringify({ resourceType, items }),
        })
      );
    }

    // ── Docker Containers ─────────────────────────────────────────────

    async listDockerContainers(
      nodeId: string,
      options: boolean | (DockerListQuery & { noCache?: boolean }) = false
    ): Promise<DockerContainer[]> {
      const params = typeof options === "boolean" ? { noCache: options } : options;
      const url = `/docker/nodes/${nodeId}/containers${dockerListQuery(params)}`;
      return withDockerListMeta(await this.request<DockerListEnvelope<DockerContainer>>(url));
    }

    async listDockerGpuUsage(nodeId: string): Promise<DockerGpuUsage[]> {
      return this.unwrapData(
        this.request<{ data: DockerGpuUsage[] }>(`/docker/nodes/${nodeId}/containers/gpu-usage`)
      );
    }

    async listDockerContainerSnapshots(params?: DockerListQuery & { nodeId?: string }) {
      const query = dockerListQuery(params);
      const separator = query ? "&" : "?";
      const nodeId = params?.nodeId
        ? `${separator}nodeId=${encodeURIComponent(params.nodeId)}`
        : "";
      return withSnapshotNodeMeta(
        await this.request<DockerListEnvelope<DockerContainer>>(
          `/docker/containers${query}${nodeId}`
        )
      );
    }

    async inspectContainer(
      nodeId: string,
      containerId: string,
      noCache = false
    ): Promise<Record<string, unknown>> {
      const url = noCache
        ? `/docker/nodes/${nodeId}/containers/${containerId}?_t=${Date.now()}`
        : `/docker/nodes/${nodeId}/containers/${containerId}`;
      return this.unwrapData(this.request<{ data: Record<string, unknown> }>(url));
    }

    async inspectContainerByName(
      nodeId: string,
      name: string,
      noCache = false
    ): Promise<Record<string, unknown>> {
      const path = `/docker/nodes/${nodeId}/containers/by-name/${encodeURIComponent(name)}`;
      return this.unwrapData(
        this.requestRouteContext<{ data: Record<string, unknown> }>(
          noCache ? `${path}?_t=${Date.now()}` : path
        )
      );
    }

    async createContainer(
      nodeId: string,
      config: ContainerCreateConfig
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(`/docker/nodes/${nodeId}/containers`, {
          method: "POST",
          body: JSON.stringify(config),
        })
      );
    }

    async listDockerDeployments(
      nodeId: string,
      params?: DockerListQuery
    ): Promise<DockerDeployment[]> {
      return withDockerListMeta(
        await this.request<DockerListEnvelope<DockerDeployment>>(
          `/docker/nodes/${nodeId}/deployments${dockerListQuery(params)}`
        )
      );
    }

    async getDockerDeployment(nodeId: string, deploymentId: string): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}`
        )
      );
    }

    async getDockerDeploymentByName(nodeId: string, name: string): Promise<DockerDeployment> {
      return this.unwrapData(
        this.requestRouteContext<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/by-name/${encodeURIComponent(name)}`
        )
      );
    }

    async createDockerDeployment(
      nodeId: string,
      config: Record<string, unknown>
    ): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(`/docker/nodes/${nodeId}/deployments`, {
          method: "POST",
          body: JSON.stringify(config),
        })
      );
    }

    async updateDockerDeployment(
      nodeId: string,
      deploymentId: string,
      config: Record<string, unknown>
    ): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}`,
          { method: "PUT", body: JSON.stringify(config) }
        )
      );
    }

    async deployDockerDeployment(
      nodeId: string,
      deploymentId: string,
      config: { image?: string; tag?: string; env?: Record<string, string> }
    ): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/deploy`,
          { method: "POST", body: JSON.stringify(config) }
        )
      );
    }

    async switchDockerDeployment(
      nodeId: string,
      deploymentId: string,
      slot: "blue" | "green",
      force = false
    ): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/switch`,
          { method: "POST", body: JSON.stringify({ slot, force }) }
        )
      );
    }

    async rollbackDockerDeployment(
      nodeId: string,
      deploymentId: string,
      force = false
    ): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/rollback`,
          { method: "POST", body: JSON.stringify({ force }) }
        )
      );
    }

    async stopDockerDeploymentSlot(
      nodeId: string,
      deploymentId: string,
      slot: "blue" | "green"
    ): Promise<void> {
      await this.request<void>(
        `/docker/nodes/${nodeId}/deployments/${deploymentId}/slots/${slot}/stop`,
        { method: "POST" }
      );
    }

    async startDockerDeployment(nodeId: string, deploymentId: string): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/start`,
          { method: "POST" }
        )
      );
    }

    async stopDockerDeployment(nodeId: string, deploymentId: string): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/stop`,
          { method: "POST" }
        )
      );
    }

    async restartDockerDeployment(nodeId: string, deploymentId: string): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/restart`,
          { method: "POST" }
        )
      );
    }

    async killDockerDeployment(nodeId: string, deploymentId: string): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/kill`,
          { method: "POST" }
        )
      );
    }

    async deleteDockerDeployment(nodeId: string, deploymentId: string): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/deployments/${deploymentId}`, {
        method: "DELETE",
      });
    }

    async getContainerHealthCheck(
      nodeId: string,
      containerName: string
    ): Promise<DockerHealthCheck> {
      return this.unwrapData(
        this.request<{ data: DockerHealthCheck }>(
          `/docker/nodes/${nodeId}/containers/${encodeURIComponent(containerName)}/health-check`
        )
      );
    }

    async updateContainerHealthCheck(
      nodeId: string,
      containerName: string,
      data: Partial<DockerHealthCheck>
    ): Promise<DockerHealthCheck> {
      return this.unwrapData(
        this.request<{ data: DockerHealthCheck }>(
          `/docker/nodes/${nodeId}/containers/${encodeURIComponent(containerName)}/health-check`,
          { method: "PUT", body: JSON.stringify(data) }
        )
      );
    }

    async testContainerHealthCheck(
      nodeId: string,
      containerName: string,
      data: Partial<DockerHealthCheck>
    ): Promise<{ ok: boolean; status: string; httpStatus?: number; responseMs?: number }> {
      return this.unwrapData(
        this.request<{
          data: { ok: boolean; status: string; httpStatus?: number; responseMs?: number };
        }>(
          `/docker/nodes/${nodeId}/containers/${encodeURIComponent(containerName)}/health-check/test`,
          { method: "POST", body: JSON.stringify(data) }
        )
      );
    }

    async getDeploymentHealthCheck(
      nodeId: string,
      deploymentId: string
    ): Promise<DockerHealthCheck> {
      return this.unwrapData(
        this.request<{ data: DockerHealthCheck }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/health-check`
        )
      );
    }

    async updateDeploymentHealthCheck(
      nodeId: string,
      deploymentId: string,
      data: Partial<DockerHealthCheck>
    ): Promise<DockerHealthCheck> {
      return this.unwrapData(
        this.request<{ data: DockerHealthCheck }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/health-check`,
          { method: "PUT", body: JSON.stringify(data) }
        )
      );
    }

    async testDeploymentHealthCheck(
      nodeId: string,
      deploymentId: string,
      data: Partial<DockerHealthCheck>
    ): Promise<{ ok: boolean; status: string; httpStatus?: number; responseMs?: number }> {
      return this.unwrapData(
        this.request<{
          data: { ok: boolean; status: string; httpStatus?: number; responseMs?: number };
        }>(`/docker/nodes/${nodeId}/deployments/${deploymentId}/health-check/test`, {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async startContainer(nodeId: string, containerId: string): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/containers/${containerId}/start`, {
        method: "POST",
      });
    }

    async stopContainer(nodeId: string, containerId: string, timeout?: number): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/containers/${containerId}/stop`, {
        method: "POST",
        body: JSON.stringify(timeout === undefined ? {} : { timeout }),
      });
    }

    async restartContainer(nodeId: string, containerId: string, timeout?: number): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/containers/${containerId}/restart`, {
        method: "POST",
        body: JSON.stringify(timeout === undefined ? {} : { timeout }),
      });
    }

    async killContainer(nodeId: string, containerId: string, signal = "SIGKILL"): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/containers/${containerId}/kill`, {
        method: "POST",
        body: JSON.stringify({ signal }),
      });
    }

    async removeContainer(nodeId: string, containerId: string, force = false): Promise<void> {
      const query = force ? "?force=true" : "";
      await this.request<void>(`/docker/nodes/${nodeId}/containers/${containerId}${query}`, {
        method: "DELETE",
      });
    }

    async renameContainer(nodeId: string, containerId: string, name: string): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/containers/${containerId}/rename`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
    }

    async duplicateContainer(
      nodeId: string,
      containerId: string,
      name: string
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/duplicate`,
          { method: "POST", body: JSON.stringify({ name }) }
        )
      );
    }

    containerArchiveDownloadUrl(
      nodeId: string,
      containerId: string,
      includeWritableLayer = false,
      imageMode: "portable" | "registry" = "portable",
      includeSecrets = false,
      includeEnvironment = true
    ): string {
      const query = new URLSearchParams({
        includeWritableLayer: String(includeWritableLayer),
        imageMode,
        includeSecrets: String(includeSecrets),
        includeEnvironment: String(includeEnvironment),
      });
      return `${API_BASE}/docker/nodes/${nodeId}/containers/${containerId}/archive?${query}`;
    }

    async downloadContainerArchive(
      nodeId: string,
      containerId: string,
      includeWritableLayer = false,
      imageMode: "portable" | "registry" = "portable",
      includeSecrets = false,
      includeEnvironment = true,
      onProgress?: (progress: { loaded: number; total: number }) => void
    ): Promise<Blob> {
      const bytes = await this.requestBinary(
        this.containerArchiveDownloadUrl(
          nodeId,
          containerId,
          includeWritableLayer,
          imageMode,
          includeSecrets,
          includeEnvironment
        ),
        {},
        onProgress
      );
      return new Blob([bytes], { type: "application/vnd.wiolett.gwca" });
    }

    async importContainerArchive(
      nodeId: string,
      name: string,
      archive: File,
      resolution: {
        networks?: Record<string, string>;
        createNetworks?: string[];
        volumes?: Record<string, string>;
        createVolumes?: string[];
        ports?: Record<string, number>;
      } = {},
      onProgress?: (progress: { loaded: number; total: number }) => void
    ): Promise<{ containerId: string; containerName: string; imageId: string }> {
      const query = new URLSearchParams({ name });
      if (Object.keys(resolution).length > 0) query.set("resolution", JSON.stringify(resolution));
      return this.unwrapData(
        this.uploadRaw<{
          data: { containerId: string; containerName: string; imageId: string };
        }>(`/docker/nodes/${nodeId}/containers/archive?${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/vnd.wiolett.gwca" },
          body: archive,
          onProgress,
        })
      );
    }

    async planContainerArchiveImport(
      nodeId: string,
      metadata: {
        networks: Array<{
          name: string;
          driver?: string;
          subnet?: string;
          gateway?: string;
          createable: boolean;
          createNew?: boolean;
          requiresMapping?: boolean;
        }>;
        mounts: Array<{
          type: "bind" | "volume";
          source: string;
          target: string;
          readOnly: boolean;
          driver?: string;
          labels?: Record<string, string>;
          createNew?: boolean;
          requiresMapping?: boolean;
        }>;
        ports: Array<{
          containerPort: number;
          hostPort: number;
          protocol: "tcp" | "udp";
        }>;
      }
    ): Promise<{
      networks: DockerNetwork[];
      volumes: DockerVolume[];
      resolution: {
        networks: Record<string, string>;
        createNetworks: string[];
        volumes: Record<string, string>;
        createVolumes: string[];
        ports: Record<string, number>;
      };
      conflictingPorts: string[];
    }> {
      return this.unwrapData(
        this.request<{
          data: {
            networks: DockerNetwork[];
            volumes: DockerVolume[];
            resolution: {
              networks: Record<string, string>;
              createNetworks: string[];
              volumes: Record<string, string>;
              createVolumes: string[];
              ports: Record<string, number>;
            };
            conflictingPorts: string[];
          };
        }>(`/docker/nodes/${nodeId}/containers/archive/plan`, {
          method: "POST",
          body: JSON.stringify(metadata),
        })
      );
    }

    async updateContainer(
      nodeId: string,
      containerId: string,
      config: { tag?: string; env?: Record<string, string>; removeEnv?: string[] }
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/update`,
          { method: "POST", body: JSON.stringify(config) }
        )
      );
    }

    async getContainerLogs(
      nodeId: string,
      containerId: string,
      params?: { tail?: number; timestamps?: boolean }
    ): Promise<string[]> {
      const qs = new URLSearchParams();
      if (params?.tail) qs.set("tail", String(params.tail));
      if (params?.timestamps) qs.set("timestamps", "true");
      const query = qs.toString();
      return this.unwrapData(
        this.request<{ data: string[] }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/logs${query ? `?${query}` : ""}`
        )
      );
    }

    async getContainerStats(nodeId: string, containerId: string): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/stats`
        )
      );
    }

    async getContainerTop(
      nodeId: string,
      containerId: string
    ): Promise<{
      Titles: string[];
      Processes: string[][];
      truncated?: boolean;
      totalProcesses?: number;
      limit?: number;
    }> {
      return this.unwrapData(
        this.request<{
          data: {
            Titles: string[];
            Processes: string[][];
            truncated?: boolean;
            totalProcesses?: number;
            limit?: number;
          };
        }>(`/docker/nodes/${nodeId}/containers/${containerId}/top`)
      );
    }

    async getContainerStatsHistory(
      nodeId: string,
      containerId: string
    ): Promise<Record<string, unknown>[]> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown>[] }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/stats/history`
        )
      );
    }

    async getContainerEnv(nodeId: string, containerId: string): Promise<string[]> {
      return this.unwrapData(
        this.request<{ data: string[] }>(`/docker/nodes/${nodeId}/containers/${containerId}/env`)
      );
    }

    async updateContainerEnv(
      nodeId: string,
      containerId: string,
      env: Record<string, string>,
      removeEnv?: string[]
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/env`,
          { method: "PUT", body: JSON.stringify({ env, removeEnv }) }
        )
      );
    }

    async liveUpdateContainer(
      nodeId: string,
      containerId: string,
      config: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/live-update`,
          { method: "POST", body: JSON.stringify(config) }
        )
      );
    }

    async recreateWithConfig(
      nodeId: string,
      containerId: string,
      config: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/recreate`,
          { method: "POST", body: JSON.stringify(config) }
        )
      );
    }

    // ── Docker Secrets ────────────────────────────────────────────────

    async listDockerSecrets(nodeId: string, containerId: string): Promise<DockerSecret[]> {
      return this.unwrapData(
        this.request<{ data: DockerSecret[] }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/secrets`
        )
      );
    }

    async createDockerSecret(
      nodeId: string,
      containerId: string,
      key: string,
      value: string
    ): Promise<DockerSecret> {
      return this.unwrapData(
        this.request<{ data: DockerSecret }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/secrets`,
          {
            method: "POST",
            body: JSON.stringify({ key, value }),
          }
        )
      );
    }

    async updateDockerSecret(
      nodeId: string,
      containerId: string,
      secretId: string,
      value: string
    ): Promise<DockerSecret> {
      return this.unwrapData(
        this.request<{ data: DockerSecret }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/secrets/${secretId}`,
          {
            method: "PUT",
            body: JSON.stringify({ value }),
          }
        )
      );
    }

    async deleteDockerSecret(nodeId: string, containerId: string, secretId: string): Promise<void> {
      await this.request(`/docker/nodes/${nodeId}/containers/${containerId}/secrets/${secretId}`, {
        method: "DELETE",
      });
    }

    async listDockerDeploymentSecrets(
      nodeId: string,
      deploymentId: string
    ): Promise<DockerSecret[]> {
      return this.unwrapData(
        this.request<{ data: DockerSecret[] }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/secrets`
        )
      );
    }

    async createDockerDeploymentSecret(
      nodeId: string,
      deploymentId: string,
      key: string,
      value: string
    ): Promise<DockerSecret> {
      return this.unwrapData(
        this.request<{ data: DockerSecret }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/secrets`,
          {
            method: "POST",
            body: JSON.stringify({ key, value }),
          }
        )
      );
    }

    async updateDockerDeploymentSecret(
      nodeId: string,
      deploymentId: string,
      secretId: string,
      value: string
    ): Promise<DockerSecret> {
      return this.unwrapData(
        this.request<{ data: DockerSecret }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/secrets/${secretId}`,
          {
            method: "PUT",
            body: JSON.stringify({ value }),
          }
        )
      );
    }

    async deleteDockerDeploymentSecret(
      nodeId: string,
      deploymentId: string,
      secretId: string
    ): Promise<void> {
      await this.request(
        `/docker/nodes/${nodeId}/deployments/${deploymentId}/secrets/${secretId}`,
        {
          method: "DELETE",
        }
      );
    }

    // ── Docker Images ─────────────────────────────────────────────────

    async listDockerImages(nodeId: string, params?: DockerListQuery): Promise<DockerImage[]> {
      return withDockerListMeta(
        await this.request<DockerListEnvelope<DockerImage>>(
          `/docker/nodes/${nodeId}/images${dockerListQuery(params)}`
        )
      );
    }

    async listDockerImageSnapshots(params?: DockerListQuery & { nodeId?: string }) {
      const query = dockerListQuery(params);
      const separator = query ? "&" : "?";
      const nodeId = params?.nodeId
        ? `${separator}nodeId=${encodeURIComponent(params.nodeId)}`
        : "";
      return withSnapshotNodeMeta(
        await this.request<DockerListEnvelope<DockerImage>>(`/docker/images${query}${nodeId}`)
      );
    }

    async pullImage(
      nodeId: string,
      imageRef: string,
      registryId?: string
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(`/docker/nodes/${nodeId}/images/pull`, {
          method: "POST",
          body: JSON.stringify({ imageRef, registryId }),
        })
      );
    }

    async removeImage(nodeId: string, imageId: string): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/images/${encodeURIComponent(imageId)}`, {
        method: "DELETE",
      });
    }

    async pruneImages(nodeId: string): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(`/docker/nodes/${nodeId}/images/prune`, {
          method: "POST",
        })
      );
    }

    // ── Docker Volumes ────────────────────────────────────────────────

    async listDockerVolumes(nodeId: string, params?: DockerListQuery): Promise<DockerVolume[]> {
      return withDockerListMeta(
        await this.request<DockerListEnvelope<DockerVolume>>(
          `/docker/nodes/${nodeId}/volumes${dockerListQuery(params)}`
        )
      );
    }

    async listDockerVolumeSnapshots(params?: DockerListQuery & { nodeId?: string }) {
      const query = dockerListQuery(params);
      const separator = query ? "&" : "?";
      const nodeId = params?.nodeId
        ? `${separator}nodeId=${encodeURIComponent(params.nodeId)}`
        : "";
      return withSnapshotNodeMeta(
        await this.request<DockerListEnvelope<DockerVolume>>(`/docker/volumes${query}${nodeId}`)
      );
    }

    async inspectDockerVolume(nodeId: string, name: string): Promise<DockerVolume> {
      return this.unwrapData(
        this.request<{ data: DockerVolume }>(
          `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}`
        )
      );
    }

    async resolveDockerVolumeByName(nodeId: string, name: string): Promise<DockerVolume> {
      return this.unwrapData(
        this.requestRouteContext<{ data: DockerVolume }>(
          `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}`
        )
      );
    }

    async listVolumeDir(nodeId: string, name: string, path: string): Promise<FileEntry[]> {
      const response = await this.request<DockerListEnvelope<FileEntry>>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`
      );
      return withDockerListMeta(response);
    }

    async readVolumeFile(nodeId: string, name: string, path: string): Promise<ArrayBuffer> {
      return this.requestBinary(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/read?path=${encodeURIComponent(path)}`
      );
    }

    async writeVolumeFile(nodeId: string, name: string, path: string, content: string) {
      const encoded = new TextEncoder().encode(content);
      return this.unwrapData(
        this.uploadRaw<{ data: unknown }>(
          `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/write?path=${encodeURIComponent(path)}`,
          {
            method: "PUT",
            body: encoded,
            headers: { "Content-Type": "application/octet-stream" },
          }
        )
      );
    }

    async createVolumeFile(
      nodeId: string,
      name: string,
      path: string,
      content: Blob | BufferSource | string = "",
      onProgress?: (progress: { loaded: number; total: number }) => void
    ) {
      const body =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content instanceof Blob
            ? content
            : content;
      return this.uploadRaw<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/create?path=${encodeURIComponent(path)}`,
        {
          method: "POST",
          body,
          headers: { "Content-Type": "application/octet-stream" },
          onProgress,
        }
      );
    }

    async initVolumeFileUpload(
      nodeId: string,
      name: string,
      path: string,
      totalBytes: number
    ): Promise<{ uploadId: string; chunkSize: number }> {
      return this.unwrapData(
        this.request<{ data: { uploadId: string; chunkSize: number } }>(
          `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/uploads`,
          {
            method: "POST",
            body: JSON.stringify({ path, totalBytes }),
          }
        )
      );
    }

    async uploadVolumeFileChunk(
      nodeId: string,
      name: string,
      uploadId: string,
      offset: number,
      content: Blob,
      onProgress?: (progress: { loaded: number; total: number }) => void
    ): Promise<{ receivedBytes: number; totalBytes: number }> {
      return this.unwrapData(
        this.uploadRaw<{ data: { receivedBytes: number; totalBytes: number } }>(
          `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/uploads/${uploadId}/chunks?offset=${offset}`,
          {
            method: "PUT",
            body: content,
            headers: { "Content-Type": "application/octet-stream" },
            onProgress,
          }
        )
      );
    }

    async completeVolumeFileUpload(
      nodeId: string,
      name: string,
      uploadId: string,
      path: string,
      totalBytes: number
    ): Promise<void> {
      await this.request<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/uploads/${uploadId}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ path, totalBytes }),
        }
      );
    }

    async abortVolumeFileUpload(nodeId: string, name: string, uploadId: string): Promise<void> {
      await this.request<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/uploads/${uploadId}`,
        { method: "DELETE" }
      );
    }

    async createVolumeDirectory(nodeId: string, name: string, path: string) {
      return this.request<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/directory`,
        {
          method: "POST",
          body: JSON.stringify({ path }),
        }
      );
    }

    async deleteVolumeFile(nodeId: string, name: string, path: string) {
      return this.request<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`,
        { method: "DELETE" }
      );
    }

    async moveVolumeFile(nodeId: string, name: string, fromPath: string, toPath: string) {
      return this.request<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/move`,
        {
          method: "POST",
          body: JSON.stringify({ fromPath, toPath }),
        }
      );
    }

    async exportDockerVolume(nodeId: string, name: string): Promise<Blob> {
      const response = await fetch(
        `${API_BASE}/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/export`,
        { headers: this.getHeaders() }
      );
      if (!response.ok) throw new Error("Failed to export volume");
      return response.blob();
    }

    async createVolume(
      nodeId: string,
      config: { name: string; storageKind?: "regular" | "disk-image"; capacityBytes?: number }
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(`/docker/nodes/${nodeId}/volumes`, {
          method: "POST",
          body: JSON.stringify(config),
        })
      );
    }

    async getVolumeMetrics(
      nodeId: string,
      name: string
    ): Promise<import("@/types").DockerVolumeMetrics> {
      return this.unwrapData(
        this.request<{ data: import("@/types").DockerVolumeMetrics }>(
          `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/metrics`
        )
      );
    }

    async resizeVolume(nodeId: string, name: string, capacityBytes: number): Promise<void> {
      await this.request(`/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/resize`, {
        method: "POST",
        body: JSON.stringify({ capacityBytes }),
      });
    }

    async listManagedVolumeOptions(nodeId: string): Promise<Array<{ name: string }>> {
      return this.unwrapData(
        this.request<{ data: Array<{ name: string }> }>(`/docker/nodes/${nodeId}/managed-volumes`)
      );
    }

    async adoptVolume(nodeId: string, name: string): Promise<void> {
      await this.request(`/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/adopt`, {
        method: "POST",
      });
    }

    async preflightDockerRuntime(nodeId: string): Promise<DockerRuntimeStatus> {
      return this.unwrapData(
        this.request<{ data: DockerRuntimeStatus }>(
          `/docker/nodes/${nodeId}/runtime/runsc/preflight`,
          {
            method: "POST",
          }
        )
      );
    }

    async installDockerRuntime(nodeId: string): Promise<DockerRuntimeStatus> {
      return this.unwrapData(
        this.request<{ data: DockerRuntimeStatus }>(
          `/docker/nodes/${nodeId}/runtime/runsc/install`,
          {
            method: "POST",
          }
        )
      );
    }

    async removeVolume(nodeId: string, name: string): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
    }

    async renameVolume(nodeId: string, name: string, newName: string): Promise<void> {
      await this.request<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/rename`,
        {
          method: "POST",
          body: JSON.stringify({ name: newName }),
        }
      );
    }

    async updateVolumeLabels(
      nodeId: string,
      name: string,
      labels: Record<string, string>
    ): Promise<void> {
      await this.request<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/labels`,
        {
          method: "PUT",
          body: JSON.stringify({ labels }),
        }
      );
    }

    // ── Docker Networks ───────────────────────────────────────────────

    async listDockerNetworks(nodeId: string, params?: DockerListQuery): Promise<DockerNetwork[]> {
      return withDockerListMeta(
        await this.request<DockerListEnvelope<DockerNetwork>>(
          `/docker/nodes/${nodeId}/networks${dockerListQuery(params)}`
        )
      );
    }

    async listDockerNetworkSnapshots(params?: DockerListQuery & { nodeId?: string }) {
      const query = dockerListQuery(params);
      const separator = query ? "&" : "?";
      const nodeId = params?.nodeId
        ? `${separator}nodeId=${encodeURIComponent(params.nodeId)}`
        : "";
      return withSnapshotNodeMeta(
        await this.request<DockerListEnvelope<DockerNetwork>>(`/docker/networks${query}${nodeId}`)
      );
    }

    async refreshDockerSnapshots(input: {
      nodeId?: string;
      resource:
        | "containers"
        | "images"
        | "volumes"
        | "networks"
        | "container-detail"
        | "volume-detail";
      key?: string;
    }): Promise<void> {
      await this.request<void>("/docker/snapshots/refresh", {
        method: "POST",
        body: JSON.stringify(input),
      });
    }

    async createNetwork(
      nodeId: string,
      config: { name: string; driver?: string; subnet?: string; gateway?: string }
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(`/docker/nodes/${nodeId}/networks`, {
          method: "POST",
          body: JSON.stringify(config),
        })
      );
    }

    async removeNetwork(nodeId: string, networkId: string): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/networks/${networkId}`, {
        method: "DELETE",
      });
    }

    async connectContainerToNetwork(
      nodeId: string,
      networkId: string,
      containerId: string
    ): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/networks/${networkId}/connect`, {
        method: "POST",
        body: JSON.stringify({ containerId }),
      });
    }

    async disconnectContainerFromNetwork(
      nodeId: string,
      networkId: string,
      containerId: string
    ): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/networks/${networkId}/disconnect`, {
        method: "POST",
        body: JSON.stringify({ containerId }),
      });
    }

    // ── Docker File Browser ───────────────────────────────────────────

    async listContainerDir(
      nodeId: string,
      containerId: string,
      path: string
    ): Promise<FileEntry[]> {
      const response = await this.request<DockerListEnvelope<FileEntry>>(
        `/docker/nodes/${nodeId}/containers/${containerId}/files?path=${encodeURIComponent(path)}`
      );
      return withDockerListMeta(response);
    }

    async readContainerFile(
      nodeId: string,
      containerId: string,
      path: string
    ): Promise<ArrayBuffer> {
      return this.requestBinary(
        `/docker/nodes/${nodeId}/containers/${containerId}/files/read?path=${encodeURIComponent(path)}`
      );
    }

    async writeContainerFile(nodeId: string, containerId: string, path: string, content: string) {
      const encoded = new TextEncoder().encode(content);
      return this.unwrapData(
        this.uploadRaw<{ data: unknown }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/files/write?path=${encodeURIComponent(path)}`,
          {
            method: "PUT",
            body: encoded,
            headers: { "Content-Type": "application/octet-stream" },
          }
        )
      );
    }

    async createContainerFile(
      nodeId: string,
      containerId: string,
      path: string,
      content: Blob | BufferSource | string = "",
      onProgress?: (progress: { loaded: number; total: number }) => void
    ) {
      const body =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content instanceof Blob
            ? content
            : content;
      return this.uploadRaw<void>(
        `/docker/nodes/${nodeId}/containers/${containerId}/files/create?path=${encodeURIComponent(path)}`,
        {
          method: "POST",
          body,
          headers: { "Content-Type": "application/octet-stream" },
          onProgress,
        }
      );
    }

    async initContainerFileUpload(
      nodeId: string,
      containerId: string,
      path: string,
      totalBytes: number
    ): Promise<{ uploadId: string; chunkSize: number }> {
      return this.unwrapData(
        this.request<{ data: { uploadId: string; chunkSize: number } }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/files/uploads`,
          {
            method: "POST",
            body: JSON.stringify({ path, totalBytes }),
          }
        )
      );
    }

    async uploadContainerFileChunk(
      nodeId: string,
      containerId: string,
      uploadId: string,
      offset: number,
      content: Blob,
      onProgress?: (progress: { loaded: number; total: number }) => void
    ): Promise<{ receivedBytes: number; totalBytes: number }> {
      return this.unwrapData(
        this.uploadRaw<{ data: { receivedBytes: number; totalBytes: number } }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/files/uploads/${uploadId}/chunks?offset=${offset}`,
          {
            method: "PUT",
            body: content,
            headers: { "Content-Type": "application/octet-stream" },
            onProgress,
          }
        )
      );
    }

    async completeContainerFileUpload(
      nodeId: string,
      containerId: string,
      uploadId: string,
      path: string,
      totalBytes: number
    ): Promise<void> {
      await this.request<void>(
        `/docker/nodes/${nodeId}/containers/${containerId}/files/uploads/${uploadId}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ path, totalBytes }),
        }
      );
    }

    async abortContainerFileUpload(
      nodeId: string,
      containerId: string,
      uploadId: string
    ): Promise<void> {
      await this.request<void>(
        `/docker/nodes/${nodeId}/containers/${containerId}/files/uploads/${uploadId}`,
        { method: "DELETE" }
      );
    }

    async createContainerDirectory(nodeId: string, containerId: string, path: string) {
      return this.request<void>(
        `/docker/nodes/${nodeId}/containers/${containerId}/files/directory`,
        {
          method: "POST",
          body: JSON.stringify({ path }),
        }
      );
    }

    async deleteContainerFile(nodeId: string, containerId: string, path: string) {
      return this.request<void>(
        `/docker/nodes/${nodeId}/containers/${containerId}/files?path=${encodeURIComponent(path)}`,
        { method: "DELETE" }
      );
    }

    async moveContainerFile(nodeId: string, containerId: string, fromPath: string, toPath: string) {
      return this.request<void>(`/docker/nodes/${nodeId}/containers/${containerId}/files/move`, {
        method: "POST",
        body: JSON.stringify({ fromPath, toPath }),
      });
    }

    // ── Docker Registries ─────────────────────────────────────────────

    async listDockerRegistries(): Promise<DockerRegistry[]> {
      return this.unwrapData(this.request<{ data: DockerRegistry[] }>("/docker/registries"));
    }

    async createRegistry(config: {
      name: string;
      url: string;
      username?: string;
      password?: string;
      trustedAuthRealm?: string;
      scope?: string;
      nodeId?: string;
    }): Promise<DockerRegistry> {
      return this.unwrapData(
        this.request<{ data: DockerRegistry }>("/docker/registries", {
          method: "POST",
          body: JSON.stringify(config),
        })
      );
    }

    async updateRegistry(
      id: string,
      config: Partial<{
        name: string;
        url: string;
        username?: string;
        password?: string;
        trustedAuthRealm?: string;
        scope?: string;
        nodeId?: string;
      }>
    ): Promise<DockerRegistry> {
      return this.unwrapData(
        this.request<{ data: DockerRegistry }>(`/docker/registries/${id}`, {
          method: "PUT",
          body: JSON.stringify(config),
        })
      );
    }

    async deleteRegistry(id: string): Promise<void> {
      await this.request<void>(`/docker/registries/${id}`, { method: "DELETE" });
    }

    async testRegistry(id: string): Promise<{ ok: boolean; error?: string }> {
      const result = await this.unwrapData(
        this.request<{
          data: { success?: boolean; ok?: boolean; error?: string; statusText?: string };
        }>(`/docker/registries/${id}/test`, { method: "POST" })
      );
      return { ok: result.success ?? result.ok ?? false, error: result.error || result.statusText };
    }

    async testRegistryDirect(creds: {
      url: string;
      username?: string;
      password?: string;
      trustedAuthRealm?: string;
    }): Promise<{ ok: boolean; error?: string }> {
      const result = await this.unwrapData(
        this.request<{ data: { success?: boolean; error?: string; statusText?: string } }>(
          `/docker/registries/test`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(creds),
          }
        )
      );
      return { ok: result.success ?? false, error: result.error || result.statusText };
    }

    // ── Docker Tasks ──────────────────────────────────────────────────

    async listDockerTasks(params?: {
      nodeId?: string;
      status?: string;
      type?: string;
    }): Promise<DockerTask[]> {
      const qs = new URLSearchParams();
      if (params?.nodeId) qs.set("nodeId", params.nodeId);
      if (params?.status) qs.set("status", params.status);
      if (params?.type) qs.set("type", params.type);
      const query = qs.toString();
      return this.unwrapData(
        this.request<{ data: DockerTask[] }>(`/docker/tasks${query ? `?${query}` : ""}`)
      );
    }

    async getDockerTask(id: string): Promise<DockerTask> {
      return this.unwrapData(this.request<{ data: DockerTask }>(`/docker/tasks/${id}`));
    }

    async forceCancelDockerTask(id: string): Promise<DockerTask> {
      return this.unwrapData(
        this.request<{ data: DockerTask }>(`/docker/tasks/${id}/force-cancel`, {
          method: "POST",
        })
      );
    }

    // ── Docker Exec WebSocket ─────────────────────────────────────────

    createExecWebSocket(nodeId: string, containerId: string, shell = "/bin/sh"): WebSocket {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/api/docker/nodes/${nodeId}/containers/${containerId}/exec?shell=${encodeURIComponent(shell)}`;
      return new WebSocket(url);
    }

    // ── Node Console WebSocket ─────────────────────────────────────

    createNodeExecWebSocket(nodeId: string, shell = "auto"): WebSocket {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/api/nodes/${nodeId}/exec?shell=${encodeURIComponent(shell)}`;
      return new WebSocket(url);
    }

    // ── Docker Log Stream WebSocket ─────────────────────────────────

    createLogStreamWebSocket(nodeId: string, containerId: string, tail = 100): WebSocket {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/api/docker/nodes/${nodeId}/containers/${containerId}/logs/stream?tail=${tail}`;
      return new WebSocket(url);
    }
  };
}
