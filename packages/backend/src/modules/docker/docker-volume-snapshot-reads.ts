import { HTTPException } from 'hono/http-exception';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { DockerManagementService } from './docker.service.js';
import { resolveDockerVolumeByName } from './docker-route-resolvers.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';
import { DockerSnapshotReconciler } from './docker-snapshot-reconciler.service.js';

/**
 * Snapshot-backed volume reads shared by the volume routes and the AI/MCP
 * volume tool. They keep working while a node is offline. Callers enforce
 * docker:volumes:view for the volume first.
 */

export function normalizeVolumeDetailItem(volume: Record<string, any>) {
  const usedBy = volume.usedBy ?? volume.UsedBy;
  const normalizedUsedBy = Array.isArray(usedBy) ? usedBy : [];
  return {
    name: volume.name ?? volume.Name,
    driver: volume.driver ?? volume.Driver,
    mountpoint: volume.mountpoint ?? volume.Mountpoint,
    labels: volume.labels ?? volume.Labels ?? {},
    options: volume.options ?? volume.Options ?? {},
    scope: volume.scope ?? volume.Scope,
    managementState: volume.managementState,
    storageKind: volume.storageKind,
    capacityBytes: volume.capacityBytes,
    adoptable: Boolean(volume.adoptable),
    adoptionReason: volume.adoptionReason,
    availability: volume.availability,
    createdAt: volume.createdAt ?? volume.CreatedAt,
    usedBy: normalizedUsedBy,
    usedByCount: normalizedUsedBy.length,
    usedByTruncated: false,
  };
}

/** Refuse volumes hidden from the user volume list, using the cached inventory. */
export async function assertSnapshotVolumeVisible(nodeId: string, name: string) {
  const snapshots = container.resolve(DockerSnapshotService);
  await snapshots.assertDockerNode(nodeId);
  const [volumes, containers] = await Promise.all([
    snapshots.getList<any[]>(nodeId, 'volumes'),
    snapshots.getList<any[]>(nodeId, 'containers'),
  ]);
  const candidates = (Array.isArray(volumes.data) ? volumes.data : []).filter(
    (volume) => String(volume?.Name ?? volume?.name ?? '') === name
  );
  const decorated = await container
    .resolve(DockerManagementService)
    .decoratePublicVolumeSnapshot(nodeId, candidates, Array.isArray(containers.data) ? containers.data : []);
  if (!decorated.some((volume) => String(volume?.Name ?? volume?.name ?? '') === name)) {
    throw new AppError(404, 'VOLUME_NOT_FOUND', 'Volume not found');
  }
}

/** Volume detail from the cached inspect, with the public volume visibility applied. */
export async function inspectDockerVolumeSnapshot(nodeId: string, name: string) {
  const snapshots = container.resolve(DockerSnapshotService);
  const detail = await snapshots.getDetail(nodeId, 'volume-detail', name);
  const data = await resolveDockerVolumeByName({ inspectVolume: async () => detail?.data }, nodeId, name);
  const containerSnapshot = await snapshots.getList<any[]>(nodeId, 'containers');
  const [decorated] = await container
    .resolve(DockerManagementService)
    .decoratePublicVolumeSnapshot(nodeId, [data], Array.isArray(containerSnapshot.data) ? containerSnapshot.data : []);
  if (!decorated) throw new HTTPException(404, { message: 'Volume not found' });
  return {
    ...normalizeVolumeDetailItem(decorated),
    nodeId,
    availability: detail ? snapshots.availability(nodeId, detail) : 'unavailable',
  };
}

/** Cached volume usage; queues a background measurement and answers 503 while none exists. */
export async function getDockerVolumeMetricsSnapshot(nodeId: string, name: string) {
  const snapshots = container.resolve(DockerSnapshotService);
  await snapshots.assertDockerNode(nodeId);
  const volumes = await snapshots.getList<Array<Record<string, unknown>>>(nodeId, 'volumes');
  const exists = volumes.data.some((volume) => String(volume.name ?? volume.Name ?? '') === name);
  if (!exists) throw new AppError(404, 'VOLUME_NOT_FOUND', 'Volume not found');
  const metrics = await snapshots.getDetail(nodeId, 'volume-metrics', name);
  if (!metrics?.data) {
    container
      .resolve(DockerSnapshotReconciler)
      .enqueue({ nodeId, kind: 'volume-metrics', key: name }, { urgent: true });
    throw new AppError(503, 'DOCKER_VOLUME_METRICS_PENDING', 'Volume metrics are being collected in the background');
  }
  return metrics.data;
}
