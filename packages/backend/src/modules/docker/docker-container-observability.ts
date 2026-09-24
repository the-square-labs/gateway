import { container } from '@/container.js';
import { DockerManagementService } from './docker.service.js';
import { filterDockerResourcesForScope } from './docker-access.middleware.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';

/**
 * Read-only container runtime views shared by the container routes and the
 * AI/MCP container tool. Callers enforce docker:containers:view first.
 */

const DOCKER_CONTAINER_PROCESS_LIST_MAX = 1000;

async function resolveMonitoringRuntimeContainerId(nodeId: string, containerIdOrName: string): Promise<string> {
  try {
    const detail = await container.resolve(DockerSnapshotService).getContainerDetailSnapshot(nodeId, containerIdOrName);
    return String(detail.data?.Id ?? detail.data?.id ?? containerIdOrName);
  } catch {
    return containerIdOrName;
  }
}

/** Latest resource sample from background health reports; never dispatches to the node. */
export async function getLatestDockerContainerStats(nodeId: string, containerId: string) {
  const { NodeMonitoringService } = await import('@/modules/nodes/node-monitoring.service.js');
  const runtimeContainerId = await resolveMonitoringRuntimeContainerId(nodeId, containerId);
  return container.resolve(NodeMonitoringService).getLatestContainerStats(nodeId, runtimeContainerId);
}

/** Recent resource samples used for the container sparklines. */
export async function getDockerContainerStatsHistory(nodeId: string, containerId: string) {
  const { NodeMonitoringService } = await import('@/modules/nodes/node-monitoring.service.js');
  const runtimeContainerId = await resolveMonitoringRuntimeContainerId(nodeId, containerId);
  return container.resolve(NodeMonitoringService).getContainerStatsHistory(runtimeContainerId);
}

/** Container process list, capped like every other Docker list. */
export async function getDockerContainerProcesses(nodeId: string, containerId: string) {
  const data = await container.resolve(DockerManagementService).getContainerTop(nodeId, containerId);
  if (Array.isArray(data?.Processes) && data.Processes.length > DOCKER_CONTAINER_PROCESS_LIST_MAX) {
    return {
      data: {
        ...data,
        Processes: data.Processes.slice(0, DOCKER_CONTAINER_PROCESS_LIST_MAX),
        totalProcesses: data.Processes.length,
        limit: DOCKER_CONTAINER_PROCESS_LIST_MAX,
        truncated: true,
      },
      truncated: true,
    };
  }
  return { data };
}

/** GPU devices on a node with the visible containers attached to each. */
export async function listDockerGpuUsage(nodeId: string, scopes: string[]) {
  const users = filterDockerResourcesForScope(
    await container.resolve(DockerManagementService).listGpuAttachmentUsers(nodeId, scopes),
    scopes,
    'docker:containers:view',
    nodeId
  );
  const byDeviceId = new Map<string, Array<{ name: string }>>();
  for (const user of users) {
    for (const deviceId of user.deviceIds) {
      const containers = byDeviceId.get(deviceId) ?? [];
      containers.push({ name: user.name });
      byDeviceId.set(deviceId, containers);
    }
  }
  return [...byDeviceId.entries()]
    .map(([deviceId, containers]) => {
      const sorted = containers.sort((a, b) => a.name.localeCompare(b.name));
      return { deviceId, containerCount: sorted.length, containers: sorted };
    })
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}
