import type { GwcaContainerManifest, GwcaImportResolution, GwcaManifest } from './docker-container-archive-format.js';
import type { DockerMigrationDispatchAdapter } from './docker-migration-dispatch.js';

export type { GwcaContainerManifest, GwcaImportResolution, GwcaManifest } from './docker-container-archive-format.js';

interface GwcaFooter {
  algorithm: 'sha256';
  manifestDigest: string;
  imageDigest: string;
  imageBytes: number;
}
export declare function openGwcaExport(args: {
  dispatch: DockerMigrationDispatchAdapter;
  nodeId: string;
  containerId: string;
  includeWritableLayer: boolean;
  imageMode: 'portable' | 'registry';
  environment: Record<string, string>;
  secrets?: Record<string, string>;
  secretKeys?: string[];
  includeEnvironment?: boolean;
  includeSecrets?: boolean;
}): Promise<{
  archiveId: string;
  filename: string;
  stream: ReadableStream<Uint8Array>;
}>;
export declare class GwcaImportReader {
  private bytes;
  footer: GwcaFooter | null;
  private hasher;
  private imageBytes;
  private manifestDigest;
  constructor(stream: ReadableStream<Uint8Array>);
  private readFrame;
  readManifest(): Promise<GwcaManifest>;
  imageChunks(): AsyncGenerator<Uint8Array>;
}
export declare function importGwca(args: {
  dispatch: DockerMigrationDispatchAdapter;
  nodeId: string;
  name: string;
  body: ReadableStream<Uint8Array>;
  resolution?: GwcaImportResolution;
  authorizeContents?: (container: GwcaContainerManifest) => void | Promise<void>;
  resolveRegistryAuthCandidates?: (imageReference: string) => Promise<string[]>;
}): Promise<{
  archiveId: string;
  containerId: string;
  containerName: string;
  imageId: string;
  environment: Record<string, string>;
  secrets: Record<string, string>;
  createdVolumes: string[];
}>;
export declare function gwcaPortKey(port: { containerPort: number; hostPort: number; protocol: string }): string;
export declare function applyGwcaImportResolution(manifest: GwcaManifest, resolution: GwcaImportResolution): void;
