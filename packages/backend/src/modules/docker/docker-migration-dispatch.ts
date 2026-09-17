import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
export interface MigrationArtifactMetadata {
  artifactId: string;
  artifactType: 'image' | 'volume' | '';
  sizeBytes: number;
  artifactDigest?: string;
  logicalDigest?: string;
  entryCount?: number;
  contentBytes?: number;
  imageId?: string;
  imageTags?: string[];
  complete: boolean;
}
export interface MigrationVolumeMeasure {
  volumeName: string;
  entryCount: number;
  logicalBytes: number;
}
export interface ArchiveImportPlan {
  networks: Array<{
    id: string;
    name: string;
    driver: string;
    scope: string;
  }>;
  volumes: Array<{
    name: string;
    driver: string;
    mountpoint: string;
    scope: string;
  }>;
  resolution: {
    networks: Record<string, string>;
    createNetworks: string[];
    volumes: Record<string, string>;
    createVolumes: string[];
    ports: Record<string, number>;
  };
  conflictingPorts: string[];
}
export class DockerMigrationDispatchAdapter {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_dispatch: NodeDispatchService) {}
  async capabilities(_nodeId: string): Promise<Record<string, unknown>> {
    return commercialModuleUnavailable();
  }
  async captureManifest(_nodeId: string, _resourceId: string): Promise<Record<string, unknown>> {
    return commercialModuleUnavailable();
  }
  async openArchiveExport(_args: {
    nodeId: string;
    archiveId: string;
    artifactId: string;
    containerId: string;
    includeWritableLayer: boolean;
    imageMode: 'portable' | 'registry';
    environment: Record<string, string>;
    secrets: Record<string, string>;
    secretKeys: string[];
    includeEnvironment: boolean;
    includeSecrets: boolean;
  }): Promise<Record<string, unknown>> {
    return commercialModuleUnavailable();
  }
  readArchiveImage(_nodeId: string, _archiveId: string, _artifactId: string): ReadableStream<Uint8Array> {
    return commercialModuleUnavailable();
  }
  async openArchiveImport(
    _nodeId: string,
    _archiveId: string,
    _artifactId: string,
    _config: {
      expectedImageId: string;
      imageEmbedded: boolean;
      pullReference?: string;
      registryAuthCandidates?: string[];
    }
  ): Promise<void> {
    return commercialModuleUnavailable();
  }
  async planArchiveImport(
    _nodeId: string,
    _config: {
      manifest: unknown;
      canViewNetworks: boolean;
      canCreateNetworks: boolean;
      canViewVolumes: boolean;
      canCreateVolumes: boolean;
    }
  ): Promise<ArchiveImportPlan> {
    return commercialModuleUnavailable();
  }
  async writeArchiveImage(
    _nodeId: string,
    _archiveId: string,
    _artifactId: string,
    _chunks: AsyncIterable<Uint8Array>
  ): Promise<number> {
    return commercialModuleUnavailable();
  }
  async finishArchiveImport(
    _nodeId: string,
    _archiveId: string,
    _artifactId: string,
    _config: Record<string, unknown>
  ): Promise<{
    containerId: string;
    containerName: string;
    imageId: string;
    createdVolumes?: string[];
  }> {
    return commercialModuleUnavailable();
  }
  async cleanupArchiveImport(_nodeId: string, _archiveId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async measureVolume(_nodeId: string, _volumeName: string): Promise<MigrationVolumeMeasure> {
    return commercialModuleUnavailable();
  }
  async prepareArtifact(_args: {
    nodeId: string;
    migrationId: string;
    artifactId: string;
    kind: 'image' | 'volume';
    sourceIdentity: string;
  }): Promise<MigrationArtifactMetadata> {
    return commercialModuleUnavailable();
  }
  async queryArtifact(_nodeId: string, _migrationId: string, _artifactId: string): Promise<MigrationArtifactMetadata> {
    return commercialModuleUnavailable();
  }
  async transferArtifact(_args: {
    sourceNodeId: string;
    targetNodeId: string;
    migrationId: string;
    artifactId: string;
    offset: number;
    onProgress?: (offset: number) => void | Promise<void>;
  }): Promise<number> {
    return commercialModuleUnavailable();
  }
  async importArtifact(_args: {
    nodeId: string;
    migrationId: string;
    artifactId: string;
    kind: 'image' | 'volume';
    config: Record<string, unknown>;
  }): Promise<MigrationArtifactMetadata> {
    return commercialModuleUnavailable();
  }
  async createContainerStopped(
    _nodeId: string,
    _migrationId: string,
    _config: Record<string, unknown>
  ): Promise<{
    containerId: string;
  }> {
    return commercialModuleUnavailable();
  }
  async createDeploymentStopped(
    _nodeId: string,
    _migrationId: string,
    _config: Record<string, unknown>
  ): Promise<Record<string, string>> {
    return commercialModuleUnavailable();
  }
  async heartbeat(_nodeId: string, _migrationId: string): Promise<Record<string, unknown>> {
    return commercialModuleUnavailable();
  }
  async finalize(_nodeId: string, _migrationId: string): Promise<Record<string, unknown>> {
    return commercialModuleUnavailable();
  }
  async abort(_nodeId: string, _migrationId: string): Promise<Record<string, unknown>> {
    return commercialModuleUnavailable();
  }
  async containerAction(
    _nodeId: string,
    _action: string,
    _containerId: string,
    _options?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return commercialModuleUnavailable();
  }
  async deploymentAction(
    _nodeId: string,
    _action: string,
    _deploymentId: string,
    _options?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return commercialModuleUnavailable();
  }
  async volumeAction(
    _nodeId: string,
    _action: string,
    _name: string,
    _options?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return commercialModuleUnavailable();
  }
}
