import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerManagedVolumes } from '@/db/schema/index.js';
import { commandResultDataToBuffer } from '@/lib/command-result-data.js';
import { isMatchingUniqueConstraintViolation } from '@/lib/resource-slugs.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { isGatewayInternalContainer } from './docker-internal-containers.js';
import { DOCKER_FILE_READ_MAX_BYTES, DOCKER_FILE_UPLOAD_CHUNK_BYTES } from './docker-read-operations.js';

type DockerDispatchResult = { success: boolean; error?: string; detail?: string; data?: Buffer | Uint8Array | string };

export interface DockerVolumeNetworkOperationContext {
  db: DrizzleClient;
  nodeDispatch: NodeDispatchService;
  auditService: AuditService;
  eventBus?: EventBusService;
  parseResult(result: DockerDispatchResult): any;
}

interface DockerVolumeFileUploadSession {
  uploadId: string;
  nodeId: string;
  volumeName: string;
  path: string;
  totalBytes: number;
  expectedOffset: number;
  userId: string;
  expiresAt: number;
}

const volumeUploadSessions = new Map<string, DockerVolumeFileUploadSession>();
const DOCKER_VOLUME_FILE_UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000;

function cleanupExpiredVolumeUploadSessions(now = Date.now()) {
  for (const [uploadId, session] of volumeUploadSessions) {
    if (session.expiresAt <= now) {
      volumeUploadSessions.delete(uploadId);
    }
  }
}

function getVolumeUploadSession(uploadId: string) {
  cleanupExpiredVolumeUploadSessions();
  const session = volumeUploadSessions.get(uploadId);
  if (!session) {
    throw new AppError(404, 'UPLOAD_NOT_FOUND', 'Upload session not found or expired');
  }
  return session;
}

function assertVolumeUploadSessionScope(session: DockerVolumeFileUploadSession, nodeId: string, volumeName: string) {
  if (session.nodeId !== nodeId || session.volumeName !== volumeName) {
    throw new AppError(404, 'UPLOAD_NOT_FOUND', 'Upload session not found or expired');
  }
}

function fileParentPath(path: string) {
  const normalized = path.replace(/\/+$/, '');
  if (!normalized || normalized === '/') return '/';
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

function publishVolumeFileChanged(
  context: DockerVolumeNetworkOperationContext,
  payload: {
    nodeId: string;
    volumeName: string;
    action: 'created' | 'updated' | 'deleted' | 'moved';
    path?: string;
    kind?: 'file' | 'directory';
    fromPath?: string;
    toPath?: string;
  }
) {
  context.eventBus?.publish('docker.volume.file.changed', {
    ...payload,
    parentPath: payload.path ? fileParentPath(payload.path) : undefined,
    fromParentPath: payload.fromPath ? fileParentPath(payload.fromPath) : undefined,
    toParentPath: payload.toPath ? fileParentPath(payload.toPath) : undefined,
  });
}

export async function listVolumes(context: DockerVolumeNetworkOperationContext, nodeId: string) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'list');
  const volumes = context.parseResult(result);
  if (!Array.isArray(volumes)) return volumes;

  const [managedRows, containerResult] = await Promise.all([
    context.db
      .select({ volumeName: dockerManagedVolumes.volumeName })
      .from(dockerManagedVolumes)
      .where(eq(dockerManagedVolumes.nodeId, nodeId)),
    context.nodeDispatch.sendDockerContainerCommand(nodeId, 'list'),
  ]);
  const managedNames = new Set(managedRows.map((row) => row.volumeName));
  const containers = context.parseResult(containerResult);
  const userVisibleContainerNames = new Set(
    (Array.isArray(containers) ? containers : [])
      .filter((container) => !isGatewayInternalContainer(container))
      .map((container) => String(container.name ?? container.Name ?? '').replace(/^\/+/, ''))
      .filter(Boolean)
  );

  const visible: Record<string, any>[] = volumes.flatMap((volume: Record<string, any>) => {
    const name = String(volume.Name ?? volume.name ?? '');
    if (!name) return [];
    const usedBy = Array.isArray(volume.UsedBy ?? volume.usedBy) ? (volume.UsedBy ?? volume.usedBy) : [];
    const managed = managedNames.has(name);
    if (!managed && !usedBy.some((containerName: string) => userVisibleContainerNames.has(containerName))) return [];
    const eligibility = volumeAdoptionEligibility(volume);
    return [
      {
        ...volume,
        managementState: managed ? 'managed' : 'legacy',
        adoptable: !managed && eligibility.adoptable,
        adoptionReason: managed ? undefined : eligibility.reason,
      },
    ];
  });
  const returnedNames = new Set(visible.map((volume: Record<string, any>) => String(volume.Name ?? volume.name ?? '')));
  for (const row of managedRows) {
    if (returnedNames.has(row.volumeName)) continue;
    visible.push({
      Name: row.volumeName,
      Driver: 'local',
      Scope: 'local',
      UsedBy: [],
      managementState: 'managed',
      adoptable: false,
      availability: 'unavailable',
    });
  }
  return visible;
}

export async function inspectVolume(context: DockerVolumeNetworkOperationContext, nodeId: string, name: string) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'inspect', { name });
  const volume = context.parseResult(result);
  const [managed] = await context.db
    .select({ volumeName: dockerManagedVolumes.volumeName })
    .from(dockerManagedVolumes)
    .where(and(eq(dockerManagedVolumes.nodeId, nodeId), eq(dockerManagedVolumes.volumeName, name)))
    .limit(1);
  const eligibility = volumeAdoptionEligibility(volume);
  return {
    ...volume,
    managementState: managed ? 'managed' : 'legacy',
    adoptable: !managed && eligibility.adoptable,
    adoptionReason: managed ? undefined : eligibility.reason,
  };
}

function volumeAdoptionEligibility(volume: Record<string, any>): { adoptable: boolean; reason?: string } {
  const driver = String(volume?.Driver ?? volume?.driver ?? '');
  const scope = String(volume?.Scope ?? volume?.scope ?? '');
  const options = volume?.Options ?? volume?.options ?? {};
  if (driver !== 'local') return { adoptable: false, reason: 'Only local Docker volumes can be managed' };
  if (scope !== 'local') return { adoptable: false, reason: 'Only node-local volumes can be managed' };
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length > 0) {
    return { adoptable: false, reason: 'Volumes with driver options cannot be managed' };
  }
  return { adoptable: true };
}

export async function listVolumeFiles(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  path: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'list-files', { name, path });
  return context.parseResult(result);
}

export async function exportVolume(context: DockerVolumeNetworkOperationContext, nodeId: string, name: string) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'export', { name });
  if (!result.success) return context.parseResult(result);
  const data = commandResultDataToBuffer(result.data);
  if (data.byteLength === 0 && result.detail) {
    throw new AppError(
      409,
      'DOCKER_DAEMON_PROTOCOL_MISMATCH',
      'Docker daemon returned a legacy volume export payload. Update and restart the Docker daemon.'
    );
  }
  return data;
}

export async function readVolumeFile(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  path: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'read-file', {
    name,
    path,
    maxBytes: DOCKER_FILE_READ_MAX_BYTES,
  });
  if (!result.success) {
    return context.parseResult(result);
  }
  const data = commandResultDataToBuffer(result.data);
  if (data.byteLength === 0 && result.detail) {
    throw new AppError(
      409,
      'DOCKER_DAEMON_PROTOCOL_MISMATCH',
      'Docker daemon returned a legacy volume file payload. Update and restart the Docker daemon.'
    );
  }
  return data;
}

export async function writeVolumeFile(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  path: string,
  content: string | Buffer,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'write-file', { name, path, content });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.volume.file.write',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId, path },
  });
  publishVolumeFileChanged(context, { nodeId, volumeName: name, action: 'updated', path, kind: 'file' });
}

export async function createVolumeFile(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  path: string,
  content: string | Buffer,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'create-file', { name, path, content });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.volume.file.create',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId, path },
  });
  publishVolumeFileChanged(context, { nodeId, volumeName: name, action: 'created', path, kind: 'file' });
}

export async function initVolumeFileUpload(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  path: string,
  totalBytes: number,
  userId: string,
  uploadId = randomUUID()
) {
  cleanupExpiredVolumeUploadSessions();
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'upload-init', {
    name,
    path: uploadId,
    targetPath: path,
    maxBytes: totalBytes,
  });
  context.parseResult(result);
  volumeUploadSessions.set(uploadId, {
    uploadId,
    nodeId,
    volumeName: name,
    path,
    totalBytes,
    expectedOffset: 0,
    userId,
    expiresAt: Date.now() + DOCKER_VOLUME_FILE_UPLOAD_SESSION_TTL_MS,
  });
  return { uploadId, chunkSize: DOCKER_FILE_UPLOAD_CHUNK_BYTES };
}

export async function appendVolumeFileUploadChunk(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  uploadId: string,
  offset: number,
  content: Buffer
) {
  const session = getVolumeUploadSession(uploadId);
  assertVolumeUploadSessionScope(session, nodeId, name);
  if (offset !== session.expectedOffset) {
    throw new AppError(
      409,
      'UPLOAD_OFFSET_MISMATCH',
      `Unexpected upload offset: expected ${session.expectedOffset}, received ${offset}`
    );
  }
  if (content.length > DOCKER_FILE_UPLOAD_CHUNK_BYTES) {
    throw new AppError(413, 'UPLOAD_CHUNK_TOO_LARGE', 'Upload chunk is too large');
  }
  if (session.expectedOffset + content.length > session.totalBytes) {
    throw new AppError(400, 'UPLOAD_SIZE_EXCEEDED', 'Upload chunk exceeds declared file size');
  }
  const result = await context.nodeDispatch.sendDockerVolumeCommand(session.nodeId, 'upload-chunk', {
    name: session.volumeName,
    path: uploadId,
    targetPath: session.path,
    maxBytes: offset,
    content,
  });
  context.parseResult(result);
  session.expectedOffset += content.length;
  session.expiresAt = Date.now() + DOCKER_VOLUME_FILE_UPLOAD_SESSION_TTL_MS;
  return { receivedBytes: session.expectedOffset, totalBytes: session.totalBytes };
}

export async function completeVolumeFileUpload(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  uploadId: string,
  path: string,
  totalBytes: number
) {
  const session = getVolumeUploadSession(uploadId);
  assertVolumeUploadSessionScope(session, nodeId, name);
  if (path !== session.path || totalBytes !== session.totalBytes) {
    throw new AppError(400, 'UPLOAD_MISMATCH', 'Upload completion does not match upload session');
  }
  if (session.expectedOffset !== session.totalBytes) {
    throw new AppError(
      409,
      'UPLOAD_INCOMPLETE',
      `Upload is incomplete: received ${session.expectedOffset} of ${session.totalBytes} bytes`
    );
  }
  const result = await context.nodeDispatch.sendDockerVolumeCommand(session.nodeId, 'upload-complete', {
    name: session.volumeName,
    path: uploadId,
    targetPath: session.path,
    maxBytes: totalBytes,
  });
  context.parseResult(result);
  volumeUploadSessions.delete(uploadId);
  await context.auditService.log({
    action: 'docker.volume.file.create',
    userId: session.userId,
    resourceType: 'docker-volume',
    resourceId: session.volumeName,
    details: { nodeId: session.nodeId, path: session.path },
  });
  publishVolumeFileChanged(context, {
    nodeId: session.nodeId,
    volumeName: session.volumeName,
    action: 'created',
    path: session.path,
    kind: 'file',
  });
}

export async function abortVolumeFileUpload(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  uploadId: string
) {
  const session = volumeUploadSessions.get(uploadId);
  if (!session) return;
  assertVolumeUploadSessionScope(session, nodeId, name);
  volumeUploadSessions.delete(uploadId);
  const result = await context.nodeDispatch.sendDockerVolumeCommand(session.nodeId, 'upload-abort', {
    name: session.volumeName,
    path: uploadId,
    targetPath: session.path,
  });
  context.parseResult(result);
}

export async function createVolumeDirectory(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  path: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'create-dir', { name, path });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.volume.file.create_directory',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId, path },
  });
  publishVolumeFileChanged(context, { nodeId, volumeName: name, action: 'created', path, kind: 'directory' });
}

export async function deleteVolumeFile(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  path: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'delete', { name, path });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.volume.file.delete',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId, path },
  });
  publishVolumeFileChanged(context, { nodeId, volumeName: name, action: 'deleted', path });
}

export async function moveVolumeFile(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  fromPath: string,
  toPath: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'move', {
    name,
    path: fromPath,
    targetPath: toPath,
  });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.volume.file.move',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId, fromPath, toPath },
  });
  publishVolumeFileChanged(context, { nodeId, volumeName: name, action: 'moved', fromPath, toPath });
}

export async function renameVolume(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  newName: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'rename', { name, newName });
  context.parseResult(result);
  await context.db
    .update(dockerManagedVolumes)
    .set({ volumeName: newName, updatedAt: new Date() })
    .where(and(eq(dockerManagedVolumes.nodeId, nodeId), eq(dockerManagedVolumes.volumeName, name)));
  await context.auditService.log({
    action: 'docker.volume.rename',
    userId,
    resourceType: 'docker-volume',
    resourceId: newName,
    details: { nodeId, oldName: name, name: newName },
  });
  context.eventBus?.publish('docker.volume.changed', { nodeId, name: newName, action: 'renamed', oldName: name });
}

export async function updateVolumeLabels(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  labels: Record<string, string>,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'update-labels', { name, labels });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.volume.labels.update',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId, name },
  });
  context.eventBus?.publish('docker.volume.changed', { nodeId, name, action: 'labels-updated' });
}

export async function createVolume(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  config: { name: string },
  userId: string
) {
  const daemonConfig = {
    name: config.name,
  };
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'create', daemonConfig);
  const data = context.parseResult(result);
  try {
    await context.db.insert(dockerManagedVolumes).values({
      nodeId,
      volumeName: config.name,
      origin: 'created',
      createdById: userId,
    });
  } catch (error) {
    if (isMatchingUniqueConstraintViolation(error, 'docker_managed_volumes_pkey')) {
      throw new AppError(409, 'NAME_IN_USE', `A managed volume named "${config.name}" already exists on this node`);
    }
    throw new AppError(
      500,
      'MANAGED_VOLUME_REGISTRY_FAILED',
      `Volume "${config.name}" was created but could not be registered; its data was preserved and must be resolved from the Docker host before retrying`
    );
  }
  await context.auditService.log({
    action: 'docker.volume.create',
    userId,
    resourceType: 'docker-volume',
    details: { nodeId, name: config.name },
  });
  context.eventBus?.publish('docker.volume.changed', { nodeId, name: config.name, action: 'created' });
  return data;
}

export async function removeVolume(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  force: boolean,
  userId: string | null
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'remove', { name, force });
  context.parseResult(result);
  await context.db
    .delete(dockerManagedVolumes)
    .where(and(eq(dockerManagedVolumes.nodeId, nodeId), eq(dockerManagedVolumes.volumeName, name)));
  await context.auditService.log({
    action: 'docker.volume.remove',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId },
  });
  context.eventBus?.publish('docker.volume.changed', { nodeId, name, action: 'removed' });
}

export async function adoptVolume(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'inspect', { name });
  const volume = context.parseResult(result);
  const eligibility = volumeAdoptionEligibility(volume);
  if (!eligibility.adoptable) {
    throw new AppError(409, 'VOLUME_NOT_ADOPTABLE', eligibility.reason ?? 'Volume cannot be managed');
  }
  await context.db
    .insert(dockerManagedVolumes)
    .values({ nodeId, volumeName: name, origin: 'adopted', createdById: userId })
    .onConflictDoUpdate({
      target: [dockerManagedVolumes.nodeId, dockerManagedVolumes.volumeName],
      set: { origin: 'adopted', updatedAt: new Date() },
    });
  await context.auditService.log({
    action: 'docker.volume.adopt',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId, name, copiedData: false },
  });
  context.eventBus?.publish('docker.volume.changed', { nodeId, name, action: 'adopted' });
  return { name, managementState: 'managed' as const };
}

export async function listNetworks(context: DockerVolumeNetworkOperationContext, nodeId: string) {
  const result = await context.nodeDispatch.sendDockerNetworkCommand(nodeId, 'list');
  return context.parseResult(result);
}

export function isBuiltInDockerNetwork(name: string) {
  return ['bridge', 'host', 'none'].includes(name);
}

export async function resolveNetworkName(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  networkId: string
) {
  const networks = await listNetworks(context, nodeId);
  if (!Array.isArray(networks)) return networkId;

  const match = networks.find((network: any) => {
    const id = String(network.id ?? network.Id ?? '');
    const name = String(network.name ?? network.Name ?? '');
    return id === networkId || name === networkId;
  });

  return String(match?.name ?? match?.Name ?? networkId);
}

export async function createNetwork(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  config: { name: string; driver: string; subnet?: string; gateway?: string },
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerNetworkCommand(nodeId, 'create', {
    networkId: config.name,
    driver: config.driver,
    subnet: config.subnet,
    gatewayAddr: config.gateway,
  });
  const data = context.parseResult(result);
  await context.auditService.log({
    action: 'docker.network.create',
    userId,
    resourceType: 'docker-network',
    details: { nodeId, name: config.name },
  });
  context.eventBus?.publish('docker.network.changed', { nodeId, name: config.name, action: 'created' });
  return data;
}

export async function removeNetwork(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  networkId: string,
  userId: string
) {
  const networkName = await resolveNetworkName(context, nodeId, networkId);
  if (isBuiltInDockerNetwork(networkName)) {
    throw new AppError(400, 'BUILTIN_NETWORK', 'Built-in Docker networks cannot be removed');
  }
  const result = await context.nodeDispatch.sendDockerNetworkCommand(nodeId, 'remove', { networkId });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.network.remove',
    userId,
    resourceType: 'docker-network',
    resourceId: networkId,
    details: { nodeId },
  });
  context.eventBus?.publish('docker.network.changed', { nodeId, name: networkId, action: 'removed' });
}

export async function connectContainerToNetwork(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  networkId: string,
  containerId: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerNetworkCommand(nodeId, 'connect', { networkId, containerId });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.network.connect',
    userId,
    resourceType: 'docker-network',
    resourceId: networkId,
    details: { nodeId, containerId },
  });
}

export async function disconnectContainerFromNetwork(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  networkId: string,
  containerId: string,
  userId: string
) {
  const networkName = await resolveNetworkName(context, nodeId, networkId);
  if (isBuiltInDockerNetwork(networkName)) {
    throw new AppError(400, 'BUILTIN_NETWORK', 'Containers cannot be disconnected from built-in Docker networks');
  }
  const result = await context.nodeDispatch.sendDockerNetworkCommand(nodeId, 'disconnect', { networkId, containerId });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.network.disconnect',
    userId,
    resourceType: 'docker-network',
    resourceId: networkId,
    details: { nodeId, containerId },
  });
}
